"""Whisper-local extension.

Install path:
  1. `sys.executable -m pip install faster-whisper` — streams pip output
     line-by-line to the install SSE channel.
  2. Construct `WhisperModel(...)` — triggers the HuggingFace weight
     download on first use. Weights cache under `~/.cache/huggingface/`.

No cloud APIs are called. Everything runs on the user's machine.

Start path (on each backend boot or immediately after install):
  - Lazy-import faster_whisper
  - Construct a singleton model
  - Subscribe to AudioBridge frames (buffer → chunk → transcribe)
  - Hold a set of connected `/ws/transcribe` clients and broadcast
    each chunk's text to all of them.
"""
import asyncio
import importlib
import sys
import time
from typing import Any, Optional, Set

from fastapi import FastAPI

from app.extensions.base import Extension, InstallContext


# Unified prefix + flush — backend runs without `-u` in many setups,
# so a plain print() disappears into a buffer for minutes. flush=True
# makes every diagnostic visible in real time.
def _log(*parts: Any) -> None:
    print("[whisper]", *parts, flush=True)


class WhisperLocalExtension(Extension):
    id = "whisper-local"
    name = "Whisper (Local)"
    description = (
        "Offline speech-to-text using faster-whisper. Once installed, "
        "the chat page's microphone gains an ESP32 option that transcribes "
        "UDP audio on the backend (no cloud APIs, no data leaves the host)."
    )
    version = "0.1.0"

    # Model name used for the first load. Size/quality/speed tradeoff:
    #   tiny    ~75 MB   fastest,    noticeably worse on accents / noise
    #   base    ~150 MB  fast,       OK in quiet rooms, hallucinates on noise
    #   small   ~490 MB  ~2× slower, big quality bump — our default
    #   medium  ~1.5 GB  ~4× slower, diminishing returns on CPU
    #   large-v3 ~3 GB   GPU-only realistically
    # `small` is the sweet spot for noisy ESP32 UDP audio on a CPU.
    DEFAULT_MODEL = "small"

    # Audio chunk settings — matches ESP32 UDP stream (16 kHz mono PCM16).
    SAMPLE_RATE = 16000
    CHUNK_SECONDS = 3.0           # transcribe every ~3 s of buffered audio
    BYTES_PER_SAMPLE = 2          # PCM16

    # Skip chunks whose RMS is below this threshold (pure noise floor).
    # Pushing sub-threshold audio into Whisper wastes CPU and invites
    # hallucinations (model "invents" text from tiny noise patterns).
    SILENCE_RMS_DB = -55.0

    # Target peak level after pre-amplification. -3 dBFS leaves a bit
    # of headroom so normalized audio doesn't clip the model's input.
    TARGET_PEAK_DBFS = -3.0

    # Decoder beam size. 1 is fastest; ~5 gives a clear quality bump
    # on noisy audio (evaluates more hypotheses before picking).
    # Cost is ~1.5× transcribe time on CPU — worth it for usability.
    BEAM_SIZE = 5

    def __init__(self):
        self._model = None
        self._model_name = self.DEFAULT_MODEL
        self._model_loading = False

        # Live state — populated in on_start, cleared on on_stop.
        self._conn_manager: Any = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._buffer = bytearray()
        self._ws_clients: Set[Any] = set()
        self._transcribe_inflight = False

        # Pinned transcription language (ISO 639-1). Set per ws-client
        # via `/ws/transcribe?lang=<BCP-47>` — frontend passes the
        # user's selected voiceLang. None = auto-detect (old behavior,
        # but much less reliable on noisy audio).
        self._active_lang: Optional[str] = None

        # Diagnostic counters — surfaced via `status()` and the
        # /api/extensions endpoint so you can tell from the frontend
        # whether UDP audio is reaching the extension at all.
        self._frame_count = 0          # total UDP frames received
        self._byte_count = 0           # total PCM bytes buffered
        self._chunk_count = 0          # chunks sent to transcribe
        self._transcribe_count = 0     # successful transcribe calls
        self._empty_chunk_count = 0    # transcriptions that returned ""
        self._drop_count = 0           # chunks dropped (in-flight busy)
        self._last_frame_at: Optional[float] = None
        self._last_transcribe_at: Optional[float] = None
        self._last_transcribe_ms: Optional[float] = None
        self._last_text: Optional[str] = None

    # -------- Install ------------------------------------------------------

    async def on_install(self, ctx: InstallContext) -> None:
        # Step 1: pip install. `sys.executable -m pip` pins the install
        # into *this* Python env (venv / conda / global all work).
        await ctx.log("=== Installing faster-whisper via pip ===")
        await ctx.progress(0.05)
        await self._run_pip_install(ctx, ["faster-whisper"])
        await ctx.progress(0.60)

        # Step 2: import + model load. First construction triggers a
        # HuggingFace download of the model weights.
        await ctx.log("=== Downloading Whisper model (first run only) ===")
        await ctx.log(
            "Note: progress reporting is best-effort — HuggingFace's "
            "downloader doesn't expose a stream; you may see this line "
            "linger for a minute or two."
        )

        # Invalidate the import cache so a module that failed to import
        # at backend startup (because it wasn't installed yet) can be
        # picked up without a process restart.
        importlib.invalidate_caches()

        await asyncio.to_thread(self._load_model_blocking)
        await ctx.progress(1.0)
        await ctx.log(
            f"Whisper '{self._model_name}' model loaded and ready "
            f"(sample rate: 16 kHz expected, matches ESP32 UDP stream)."
        )

    async def _run_pip_install(self, ctx: InstallContext, packages: list) -> None:
        """Install `packages` into the Python env running this backend.

        Order of attempts (fall through on failure):
          1. `sys.executable -m pip install --upgrade ...` — the normal
             path; works for stdlib venvs, conda, system Python.
          2. `uv pip install --python <sys.executable> --upgrade ...` —
             needed when the backend runs inside a uv-managed venv that
             was created without pip (uv's default behavior). Detected
             by ModuleNotFoundError: pip.

        Raises RuntimeError if both paths fail."""
        # Attempt 1: plain pip
        cmd = [sys.executable, "-m", "pip", "install", "--upgrade", *packages]
        code, output = await self._run_and_stream(ctx, cmd)
        if code == 0:
            return

        pip_missing = "No module named pip" in output
        if not pip_missing:
            raise RuntimeError(f"pip install failed (exit {code})")

        # Attempt 2: uv pip (common when backend runs under a uv venv)
        await ctx.log(
            "pip is not installed in this Python env — falling back to `uv pip install`."
        )
        cmd = [
            "uv", "pip", "install",
            "--python", sys.executable,
            "--upgrade",
            *packages,
        ]
        code, _ = await self._run_and_stream(ctx, cmd)
        if code == 0:
            return

        raise RuntimeError(
            f"Install failed (exit {code}). Neither `python -m pip` nor `uv pip` "
            "succeeded. Ensure either pip is available in this Python env "
            "(`python -m ensurepip`) or `uv` is on PATH."
        )

    async def _run_and_stream(
        self, ctx: InstallContext, cmd: list,
    ) -> tuple[int, str]:
        """Run `cmd` and stream its stdout/stderr to the SSE log. Returns
        (exit_code, captured_output) so callers can branch on specific
        failure modes (e.g. "No module named pip").

        Implementation: we use blocking `subprocess.Popen` in a worker
        thread rather than `asyncio.create_subprocess_exec`. Reason:
        `run.py` forces `WindowsSelectorEventLoopPolicy`, which on
        Windows does NOT support subprocess operations — the async
        variant raises NotImplementedError. A thread-based Popen
        sidesteps the event-loop policy entirely."""
        import subprocess
        import threading
        import queue as stdqueue

        await ctx.log("$ " + " ".join(cmd))

        # Spawn process (blocking call in a thread). bufsize=0 (unbuffered)
        # because line buffering isn't supported with binary-mode PIPE;
        # we read line-by-line ourselves via readline() below.
        def _spawn():
            try:
                return subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    bufsize=0,
                )
            except FileNotFoundError as e:
                return e

        proc_or_err = await asyncio.to_thread(_spawn)
        if isinstance(proc_or_err, FileNotFoundError):
            msg = f"Command not found: {cmd[0]} ({proc_or_err})"
            await ctx.log(msg)
            return 127, msg
        proc = proc_or_err
        assert proc.stdout is not None

        # Pump stdout in a worker thread, pushing each line into a queue
        # the async side drains and forwards to the SSE log.
        q: stdqueue.Queue = stdqueue.Queue()
        SENTINEL = object()

        def _pump():
            try:
                for raw_line in iter(proc.stdout.readline, b""):
                    if not raw_line:
                        break
                    q.put(raw_line)
            finally:
                q.put(SENTINEL)

        threading.Thread(target=_pump, name="pip-pump", daemon=True).start()

        captured_lines: list[str] = []
        loop = asyncio.get_running_loop()
        while True:
            # Use loop.run_in_executor + blocking get so we don't spin.
            item = await loop.run_in_executor(None, q.get)
            if item is SENTINEL:
                break
            try:
                text = item.decode("utf-8", errors="replace").rstrip()
            except Exception:
                text = repr(item)
            if text:
                captured_lines.append(text)
                await ctx.log(text)

        code = await asyncio.to_thread(proc.wait)
        return code, "\n".join(captured_lines)

    def _load_model_blocking(self) -> None:
        """Runs in a worker thread. Imports faster_whisper lazily so
        the module isn't required at backend cold-start (before the
        user has installed the extension)."""
        from faster_whisper import WhisperModel  # type: ignore

        self._model_loading = True
        try:
            # int8 quantization on CPU — ~4× smaller memory + faster
            # than float32, with negligible accuracy loss for speech.
            self._model = WhisperModel(
                self._model_name,
                device="cpu",
                compute_type="int8",
            )
        finally:
            self._model_loading = False

    # -------- Start / Stop / Status ---------------------------------------

    async def on_start(self, app: FastAPI) -> None:
        # Ensure the model is loaded after a backend restart. If the
        # import fails (e.g. the wheel was removed by hand), bubble up
        # so the manager marks the extension as errored rather than
        # silently ignoring it.
        if self._model is None:
            importlib.invalidate_caches()
            try:
                # First load of a new model size triggers a HuggingFace
                # download (`small` is ~490 MB, cached under
                # ~/.cache/huggingface/hub/). Log up-front so the user
                # doesn't think startup froze.
                _log(
                    f"Loading Whisper model '{self._model_name}' "
                    f"(device=cpu, int8) — may need to download weights "
                    f"on first run; subsequent starts read from the "
                    f"HuggingFace cache and are fast."
                )
                load_t0 = time.perf_counter()
                await asyncio.to_thread(self._load_model_blocking)
                elapsed = (time.perf_counter() - load_t0) * 1000
                _log(
                    f"Model '{self._model_name}' loaded in {elapsed:.0f} ms"
                )
            except ImportError as e:
                raise RuntimeError(
                    "faster-whisper is not importable. Reinstall the "
                    f"extension from Settings. Original error: {e}"
                ) from e

        # Subscribe to UDP audio frames. The callback runs on the UDP
        # reader thread; it only does a buffer append and then schedules
        # real work on the event loop.
        from app.main import get_conn_manager
        self._loop = asyncio.get_running_loop()
        self._conn_manager = get_conn_manager()
        if self._conn_manager and hasattr(self._conn_manager, "audio_bridge"):
            self._conn_manager.audio_bridge.add_audio_consumer(self._on_frame)
            _log("Subscribed to AudioBridge UDP audio stream")
        else:
            _log("WARN: no audio_bridge on conn_manager — cannot subscribe")

    async def on_stop(self) -> None:
        if self._conn_manager and hasattr(self._conn_manager, "audio_bridge"):
            try:
                self._conn_manager.audio_bridge.remove_audio_consumer(
                    self._on_frame,
                )
            except Exception:
                pass
        self._ws_clients.clear()
        self._buffer.clear()
        self._model = None
        self._loop = None
        self._conn_manager = None

    def status(self) -> dict:
        return {
            "model_name": self._model_name,
            "model_loaded": self._model is not None,
            "model_loading": self._model_loading,
            "ws_clients": len(self._ws_clients),
            "active_lang": self._active_lang or "auto-detect",
            "beam_size": self.BEAM_SIZE,
            "silence_rms_db": self.SILENCE_RMS_DB,
            # Live pipeline counters — poll via GET /api/extensions to
            # see whether UDP frames are reaching the extension and
            # whether transcribe is succeeding.
            "frames_received": self._frame_count,
            "buffer_bytes": len(self._buffer),
            "chunks_dispatched": self._chunk_count,
            "chunks_dropped_busy": self._drop_count,
            "transcribe_count": self._transcribe_count,
            "empty_transcribes": self._empty_chunk_count,
            "last_transcribe_ms": self._last_transcribe_ms,
            "last_text_preview": (
                (self._last_text[:60] + "…")
                if self._last_text and len(self._last_text) > 60
                else self._last_text
            ),
            "last_frame_age_sec": (
                round(time.perf_counter() - self._last_frame_at, 2)
                if self._last_frame_at is not None
                else None
            ),
        }

    # -------- Streaming transcription --------------------------------------
    #
    # Flow:
    #   UDP reader thread  ── _on_frame ──► (append to bytearray)
    #                                           │
    #                         (if len ≥ CHUNK)  │
    #                                           ▼
    #                         asyncio.run_coroutine_threadsafe
    #                                           │
    #                                           ▼
    #                         event loop: _transcribe_and_broadcast
    #                                           │
    #                         (to_thread)       ▼
    #                          WhisperModel.transcribe
    #                                           │
    #                                           ▼
    #                         send_json to every ws_client

    def _on_frame(self, frame: bytes) -> None:
        """UDP reader-thread callback. Keep cheap — no transcribe here."""
        # Drop audio when nobody's listening (saves CPU when chat is
        # open but the user hasn't started the ESP32 mic).
        if not self._ws_clients:
            return
        self._buffer.extend(frame)
        self._frame_count += 1
        self._byte_count += len(frame)
        self._last_frame_at = time.perf_counter()

        # Periodic heartbeat while receiving audio — every 200 frames
        # (≈ 3 s at the ESP32's typical 64-frames/s rate) so the log
        # proves UDP is live without spamming on every packet.
        if self._frame_count % 200 == 0:
            _log(
                f"rx frames={self._frame_count} "
                f"buffer={len(self._buffer)}B "
                f"ws_clients={len(self._ws_clients)}"
            )

        chunk_bytes = int(self.SAMPLE_RATE * self.CHUNK_SECONDS) * self.BYTES_PER_SAMPLE
        if len(self._buffer) < chunk_bytes:
            return

        # Slice a chunk and reset the buffer. If a transcribe is already
        # in-flight, drop this chunk entirely to avoid queueing up a
        # backlog — faster-whisper can't keep up with real-time on slow
        # hardware and stale transcripts are worse than gaps.
        chunk = bytes(self._buffer[:chunk_bytes])
        del self._buffer[:chunk_bytes]
        if self._transcribe_inflight:
            self._drop_count += 1
            _log(
                f"DROP chunk #{self._chunk_count + 1}: "
                f"{chunk_bytes}B — previous transcribe still running"
            )
            return

        if self._loop is None:
            _log("WARN: event loop missing, can't schedule transcribe")
            return
        self._chunk_count += 1
        _log(
            f"dispatch chunk #{self._chunk_count}: "
            f"{chunk_bytes}B ({self.CHUNK_SECONDS:.1f}s of PCM16 @ {self.SAMPLE_RATE} Hz)"
        )
        asyncio.run_coroutine_threadsafe(
            self._transcribe_and_broadcast(chunk),
            self._loop,
        )

    async def _transcribe_and_broadcast(self, chunk: bytes) -> None:
        self._transcribe_inflight = True
        t0 = time.perf_counter()
        try:
            text = await asyncio.to_thread(self.transcribe_pcm16, chunk)
        except Exception as e:
            elapsed = (time.perf_counter() - t0) * 1000
            _log(f"transcribe FAILED after {elapsed:.0f} ms: {type(e).__name__}: {e}")
            return
        finally:
            self._transcribe_inflight = False

        elapsed = (time.perf_counter() - t0) * 1000
        self._transcribe_count += 1
        self._last_transcribe_at = time.perf_counter()
        self._last_transcribe_ms = round(elapsed, 1)

        if not text:
            self._empty_chunk_count += 1
            _log(
                f"transcribe done in {elapsed:.0f} ms → "
                f"EMPTY (VAD filtered silence; "
                f"total empty={self._empty_chunk_count}/{self._transcribe_count})"
            )
            return

        self._last_text = text
        preview = text if len(text) <= 80 else text[:77] + "…"
        _log(
            f"transcribe done in {elapsed:.0f} ms → "
            f"text={preview!r}"
        )

        payload = {"kind": "partial", "text": text}
        # send_json can block on a dead socket; gather with
        # return_exceptions=True so one dead client doesn't stop the
        # broadcast.
        stale = []
        sent_ok = 0
        for ws in list(self._ws_clients):
            try:
                await ws.send_json(payload)
                sent_ok += 1
            except Exception as e:
                _log(f"broadcast: ws send failed ({type(e).__name__}), marking stale")
                stale.append(ws)
        _log(
            f"broadcast: delivered to {sent_ok}/{len(self._ws_clients)} clients"
            + (f", {len(stale)} dropped" if stale else "")
        )
        for ws in stale:
            self._ws_clients.discard(ws)

    # -------- WebSocket registration ---------------------------------------

    def add_ws_client(self, ws: Any) -> None:
        """Called by the /ws/transcribe handler. Flushes any buffered
        audio so the new client doesn't receive stale transcripts."""
        self._buffer.clear()
        self._ws_clients.add(ws)
        _log(
            f"ws client connected — total clients={len(self._ws_clients)}, "
            f"buffer reset, waiting for UDP frames"
        )

    def set_active_lang(self, lang: Optional[str]) -> None:
        """Pin transcription to a specific language (ISO 639-1 code).
        `None` restores auto-detect. Called by the /ws/transcribe
        handler when the frontend passes `?lang=<BCP-47>`."""
        prev = self._active_lang
        self._active_lang = lang
        if prev != lang:
            _log(
                f"active transcription language: {prev or 'auto'} → "
                f"{lang or 'auto'}"
            )

    def remove_ws_client(self, ws: Any) -> None:
        self._ws_clients.discard(ws)
        _log(
            f"ws client disconnected — total clients={len(self._ws_clients)}"
        )
        if not self._ws_clients:
            # No listeners left — release buffered audio.
            self._buffer.clear()
            _log("no clients left — cleared buffer, stopping chunking")

    # -------- Public helpers -----------------------------------------------

    def transcribe_pcm16(self, pcm_bytes: bytes, sample_rate: int = 16000) -> str:
        """Blocking: run one transcription. Caller should await via
        asyncio.to_thread so the event loop isn't blocked.

        Pipeline:
          1. PCM16 → float32 in [-1, 1]
          2. Measure RMS + peak
          3. Skip if RMS below SILENCE_RMS_DB (saves CPU, avoids
             hallucinated text from pure noise)
          4. Pre-amplify quiet audio to TARGET_PEAK_DBFS so the model
             sees a consistent dynamic range regardless of input gain
          5. Decode with pinned language (or auto-detect) + beam search
        """
        import numpy as np  # type: ignore

        if self._model is None:
            raise RuntimeError("Whisper model not loaded yet")
        audio = (
            np.frombuffer(pcm_bytes, dtype=np.int16).astype("float32") / 32768.0
        )
        if audio.size == 0:
            return ""

        rms = float(np.sqrt(np.mean(audio ** 2)) + 1e-10)
        peak = float(np.max(np.abs(audio)) + 1e-10)
        rms_db = 20 * np.log10(rms)
        peak_db = 20 * np.log10(peak)
        _log(
            f"transcribe start: {len(pcm_bytes)}B / "
            f"{audio.size / sample_rate:.2f}s @ {sample_rate}Hz, "
            f"RMS={rms_db:.1f}dB peak={peak_db:.1f}dB"
        )

        # (3) Skip noise-floor-only chunks. Without this, the model
        # pattern-matches random noise onto whatever tokens are most
        # probable in its training distribution — usually short words
        # in random languages. This is the #1 source of "天天 show with
        # you ты тут все..." garbage output.
        if rms_db < self.SILENCE_RMS_DB:
            _log(
                f"  → skipped (RMS {rms_db:.1f}dB below threshold "
                f"{self.SILENCE_RMS_DB:.0f}dB — pure noise, not transcribing)"
            )
            return ""

        # (4) Pre-amplify quiet audio. Matches what a "well-recorded"
        # training sample looks like so the model doesn't have to
        # extrapolate from under-level input.
        target_peak = 10 ** (self.TARGET_PEAK_DBFS / 20.0)
        if peak < target_peak:
            gain = target_peak / peak
            gain_db = 20 * np.log10(gain)
            audio = audio * gain
            _log(f"  → pre-amp gain +{gain_db:.1f}dB (new peak ≈ {self.TARGET_PEAK_DBFS:.0f}dBFS)")

        # (5) Decode. Language pin (when set) + beam search.
        segments, info = self._model.transcribe(
            audio,
            beam_size=self.BEAM_SIZE,
            language=self._active_lang,  # None → auto-detect
            vad_filter=True,
        )
        text = "".join(s.text for s in segments).strip()
        lang = getattr(info, "language", "?")
        lang_prob = getattr(info, "language_probability", 0.0)
        _log(
            f"transcribe model result: lang={lang} ({lang_prob:.2f}), "
            f"pinned={self._active_lang or 'no'}, chars={len(text)}"
        )
        return text
