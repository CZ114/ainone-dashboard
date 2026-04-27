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
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI

from app.config import BASE_DIR
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

    # Model size/quality/speed tradeoff:
    #   tiny           ~75 MB   fastest, hallucinates on noise
    #   base           ~150 MB  CPU-friendly, weak on accents
    #   small          ~490 MB  CPU-default-grade quality
    #   medium         ~1.5 GB  diminishing returns on CPU
    #   large-v3       ~3 GB    GPU-only realistically
    #   large-v3-turbo ~1.5 GB  ~near large-v3 quality, ~6× faster
    #   distil-large-v3 ~1.5 GB similar perf to turbo, English-leaning
    # The ACTIVE name is picked per-platform/GPU in _smart_default_model
    # and exposed as the schema default; users can override via the UI.
    MODEL_OPTIONS = [
        "tiny", "base", "small", "medium",
        "large-v3", "large-v3-turbo", "distil-large-v3",
    ]

    # Defaults for runtime-tunable knobs. Every one of these is also a
    # config field exposed through get_config_schema; the class consts
    # are just the "initial" values used until persisted state overrides
    # them. Hot-reloadable: changing chunk/overlap/beam takes effect on
    # the next dispatched chunk, no model reload.
    DEFAULT_CHUNK_SECONDS = 1.5
    DEFAULT_OVERLAP_SECONDS = 0.3
    DEFAULT_BEAM_SIZE = 5

    # Audio invariants — never user-tunable. Match the ESP32 UDP stream
    # (16 kHz mono PCM16). Changing these requires firmware changes too,
    # so they stay class-level.
    SAMPLE_RATE = 16000
    BYTES_PER_SAMPLE = 2

    # Where downloaded model weights live. Project-local instead of the
    # default HuggingFace cache (~/.cache/huggingface/hub) so everything
    # stays inside the repo — easier to back up, ship to a colleague,
    # or wipe when iterating. The HF cache layout is preserved
    # (models--<org>--<repo>/snapshots/...) so faster-whisper resolves
    # paths normally; we just override the parent dir via download_root.
    # BASE_DIR resolves to the project root (esp32_sensor_dashboard/),
    # NOT backend/ — see app.config.
    MODELS_DIR = BASE_DIR / "VoiceModel"

    # Skip chunks whose RMS is below this threshold (pure noise floor).
    # Pushing sub-threshold audio into Whisper wastes CPU and invites
    # hallucinations (model "invents" text from tiny noise patterns).
    # Not exposed in the UI — 99% of users wouldn't know what to set.
    SILENCE_RMS_DB = -55.0

    # Target peak level after pre-amplification. -3 dBFS leaves a bit
    # of headroom so normalized audio doesn't clip the model's input.
    TARGET_PEAK_DBFS = -3.0

    # ---------- Platform / GPU detection helpers ----------------------

    @classmethod
    def _smart_default_model(cls) -> str:
        """Pick a sensible default for this machine. Conservative on
        CPU-only setups so the user gets a working baseline; aggressive
        when CUDA is available.

        Priority order:
          - macOS Apple Silicon: 'small' (faster-whisper has no MPS, so
            CPU only; small is the largest model that's still snappy)
          - macOS Intel: 'base' (older hardware, conservative)
          - Windows / Linux + CUDA: 'large-v3-turbo'
          - Anything else: 'small'

        Failure-tolerant: if ctranslate2 isn't installed yet (extension
        hasn't been installed) we can't probe for CUDA. We pick a
        safe-on-any-machine default ('base') and let on_config_change
        fix it once the user actually installs."""
        if sys.platform == "darwin":
            import platform as _pl
            return "small" if _pl.machine() in ("arm64", "aarch64") else "base"
        try:
            import ctranslate2  # type: ignore
            if ctranslate2.get_cuda_device_count() > 0:
                return "large-v3-turbo"
        except ImportError:
            return "base"
        return "small"

    @classmethod
    def _platform_help(cls) -> str:
        """Short hint shown beside the model dropdown in the UI. Tells
        the user what to expect from their hardware before they pick."""
        if sys.platform == "darwin":
            import platform as _pl
            arm = _pl.machine() in ("arm64", "aarch64")
            chip = "Apple Silicon" if arm else "Intel Mac"
            return (
                f"{chip} detected (CPU-only, faster-whisper has no MPS). "
                f"Defaults to 'small'. Larger models work but get slow."
            )
        try:
            import ctranslate2  # type: ignore
            if ctranslate2.get_cuda_device_count() > 0:
                return (
                    "CUDA GPU detected — 'large-v3-turbo' runs in "
                    "real-time. Smaller models also fine."
                )
        except ImportError:
            pass
        return (
            "No CUDA detected. CPU is fine for 'base' / 'small'; larger "
            "models will lag. If you have an NVIDIA GPU, install "
            "nvidia-cublas-cu12 + nvidia-cudnn-cu12."
        )

    # ---------- Config schema ----------------------------------------

    @classmethod
    def get_config_schema(cls) -> List[Dict[str, Any]]:
        return [
            {
                "key": "model_name",
                "type": "select",
                "label": "Model",
                # Flat list kept for older frontends that don't
                # know about option_groups — they fall back to this.
                "options": cls.MODEL_OPTIONS,
                # Grouped view: separates the CPU-friendly tier from
                # the GPU-recommended tier so the user can tell at a
                # glance which models are safe on a laptop and which
                # will demand significant download + VRAM. The
                # frontend uses the group label "GPU recommended" as
                # a heuristic to surface a heavyweight-load warning
                # before applying.
                "option_groups": [
                    {
                        "label": "CPU-friendly",
                        "options": ["tiny", "base", "small"],
                    },
                    {
                        "label": "GPU recommended",
                        "options": [
                            "medium", "large-v3",
                            "large-v3-turbo", "distil-large-v3",
                        ],
                    },
                ],
                "default": cls._smart_default_model(),
                "requires_reload": True,
                "help": cls._platform_help(),
            },
            {
                "key": "chunk_seconds",
                "type": "slider",
                "label": "Window length (s)",
                "min": 0.8, "max": 5.0, "step": 0.1,
                "default": cls.DEFAULT_CHUNK_SECONDS,
                "requires_reload": False,
                "help": (
                    "Lower = lower latency, less acoustic context per "
                    "decode. Below 1.0 s accuracy drops noticeably."
                ),
            },
            {
                "key": "overlap_seconds",
                "type": "slider",
                "label": "Overlap (s)",
                "min": 0.0, "max": 1.0, "step": 0.05,
                "default": cls.DEFAULT_OVERLAP_SECONDS,
                "requires_reload": False,
                "help": (
                    "Audio shared between consecutive windows so words "
                    "straddling a boundary aren't split. Should be < window."
                ),
            },
            {
                "key": "beam_size",
                "type": "slider",
                "label": "Beam size",
                "min": 1, "max": 10, "step": 1,
                "default": cls.DEFAULT_BEAM_SIZE,
                "requires_reload": False,
                "help": (
                    "Decoder search width. Higher = more accurate, slower. "
                    "On GPU the cost is small; on CPU keep at 1-3."
                ),
            },
        ]

    def __init__(self):
        self._model = None
        # All four are runtime-tunable via on_config_change; class consts
        # / smart defaults are just the seed values used before any
        # persisted config has been applied.
        self._model_name = self._smart_default_model()
        self._chunk_seconds = self.DEFAULT_CHUNK_SECONDS
        self._overlap_seconds = self.DEFAULT_OVERLAP_SECONDS
        self._beam_size = self.DEFAULT_BEAM_SIZE
        self._model_loading = False
        # Background-load task handle. on_start fires the load
        # asynchronously so FastAPI's lifespan completes immediately
        # and the backend starts serving HTTP/WS within seconds, even
        # when the model needs a 1.5 GB download. on_stop / on_config_change
        # cancel this if it's still running.
        self._load_task: Optional["asyncio.Task[None]"] = None
        # Chunks dropped because they arrived while the model was still
        # loading (initial boot or mid-swap). Surfaced via status() so
        # the frontend can show "X chunks lost while model was loading".
        self._not_ready_drop_count = 0

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
        # Raw model output of the previous chunk, kept verbatim (no dedup
        # applied). Two distinct uses: (a) fed into the next call as
        # `initial_prompt` so the decoder has linguistic context across
        # the OVERLAP_SECONDS window; (b) compared against the next raw
        # output to find the duplicated overlap region and strip it
        # before broadcasting. Must NOT be confused with _last_text,
        # which is post-dedup and is what the user sees.
        self._last_raw_text: Optional[str] = None

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
        user has installed the extension).

        Device selection: try CUDA first; fall back to CPU on any
        construction error. CUDA needs the nvidia-cublas-cu12 +
        nvidia-cudnn-cu12 pip packages alongside a working NVIDIA
        driver — if either is missing, CT2 raises and we silently
        downgrade rather than refusing to start."""
        # Windows-only: make CUDA support DLLs from the nvidia-* pip
        # packages discoverable. CT2 can construct a CUDA model using
        # just nvcuda.dll (already in C:\Windows\System32), so the load
        # step misleadingly succeeds. The first real matmul then needs
        # cublas64_12.dll, which lives at
        #   <venv>/Lib/site-packages/nvidia/cublas/bin/
        # — a path NOT on the default DLL search path. Failure mode is
        # nasty: warmup raises a clean RuntimeError, but actual
        # transcribe() runs through CT2's internal worker thread, where
        # the same DLL miss causes the generator iteration to hang
        # forever instead of bubbling the error. So a missing DLL
        # silently freezes the entire pipeline.
        #
        # Why PATH and not just os.add_dll_directory: the latter is
        # honored by Python's LoadLibraryEx with LOAD_LIBRARY_SEARCH_USER_DIRS,
        # but CT2's native code uses bare LoadLibrary, which only
        # consults the legacy DLL search order (PATH being the last
        # entry). Verified empirically that add_dll_directory alone is
        # insufficient. Belt-and-suspenders: PATH covers CT2,
        # add_dll_directory covers any future caller using modern flags.
        #
        # macOS / Linux skip this entirely: CT2 ships .dylib / .so
        # bundled inside the ctranslate2 wheel, and the OS dynamic
        # loader resolves them via @rpath / RPATH without external help.
        if sys.platform == "win32":
            import os
            from pathlib import Path
            nvidia_root = (
                Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
            )
            extra_paths = [
                str(p) for p in nvidia_root.glob("*/bin") if p.is_dir()
            ]
            if extra_paths:
                os.environ["PATH"] = (
                    os.pathsep.join(extra_paths)
                    + os.pathsep
                    + os.environ.get("PATH", "")
                )
                if hasattr(os, "add_dll_directory"):
                    for p in extra_paths:
                        try:
                            os.add_dll_directory(p)
                        except (OSError, FileNotFoundError):
                            pass
                _log(
                    f"registered CUDA DLL dirs (PATH + add_dll_directory): "
                    f"{[Path(p).parent.name for p in extra_paths]}"
                )

        from faster_whisper import WhisperModel  # type: ignore
        import ctranslate2  # type: ignore

        # Materialise the project-local model dir before either
        # WhisperModel call. faster-whisper's download_root expects a
        # path that exists; otherwise the HF downloader silently falls
        # back to its default cache and the user thinks the override
        # worked when it didn't.
        self.MODELS_DIR.mkdir(parents=True, exist_ok=True)
        download_root = str(self.MODELS_DIR)
        _log(f"model cache root: {download_root}")

        self._model_loading = True
        try:
            loaded = False
            if ctranslate2.get_cuda_device_count() > 0:
                # GPU path: float16 is the sweet spot on Ada/Ampere — it
                # halves memory bandwidth vs float32 and is natively
                # accelerated by tensor cores. int8_float16 is ~10%
                # faster but slightly less robust on noisy audio, so we
                # default to plain float16.
                try:
                    self._model = WhisperModel(
                        self._model_name,
                        device="cuda",
                        compute_type="float16",
                        download_root=download_root,
                    )
                    _log(
                        f"loaded on CUDA (float16) — model={self._model_name}"
                    )
                    loaded = True
                except Exception as e:
                    _log(
                        f"CUDA load failed ({type(e).__name__}: {e}); "
                        f"falling back to CPU int8"
                    )
            if not loaded:
                # CPU fallback: int8 is ~4× smaller memory + faster than
                # float32, with negligible accuracy loss for speech.
                self._model = WhisperModel(
                    self._model_name,
                    device="cpu",
                    compute_type="int8",
                    download_root=download_root,
                )
                _log(f"loaded on CPU (int8) — model={self._model_name}")
            # Warmup pass — runs *before* the extension exposes itself
            # as ready, so the JIT cost is hidden inside the existing
            # boot wait instead of stealing the user's first utterance.
            self._warmup_blocking()
        finally:
            self._model_loading = False

    def _warmup_blocking(self) -> None:
        """Drive one dummy transcribe through the freshly-loaded model so
        CUDA kernel JIT, cuDNN handle init, and CT2 internal allocators
        all happen *now* instead of during the user's first real chunk.

        Without this, the first call after model load takes 5-10 s on a
        cold GPU; while it runs, the UDP buffer keeps filling and we
        end up dropping every chunk that arrives during that window
        (the `DROP chunk #N: previous transcribe still running` log).

        Costs ~3-8 s on a CUDA 4060 / ~1-2 s on CPU, paid once at boot."""
        import numpy as np  # type: ignore

        if self._model is None:
            return
        try:
            # Low-amplitude white noise rather than pure silence so the
            # decoder definitely runs. vad_filter=False guards against
            # silero-vad swallowing the buffer before it reaches the
            # encoder, which would defeat the whole point.
            warmup_audio = (
                np.random.randn(self.SAMPLE_RATE).astype("float32") * 0.01
            )
            t0 = time.perf_counter()
            segments, _ = self._model.transcribe(
                warmup_audio,
                beam_size=self._beam_size,
                language=None,
                vad_filter=False,
            )
            # faster-whisper's segments is a generator — exhaust it so
            # the actual decode happens in this call.
            list(segments)
            warmup_ms = (time.perf_counter() - t0) * 1000
            _log(
                f"warmup transcribe complete in {warmup_ms:.0f} ms — "
                f"kernels primed, first user chunk will be steady-state speed"
            )
        except Exception as e:
            # Warmup is opportunistic; never block the extension from
            # starting just because the dummy decode hiccupped.
            _log(
                f"warmup transcribe failed (non-fatal): "
                f"{type(e).__name__}: {e}"
            )

    # -------- Start / Stop / Status ---------------------------------------

    async def on_start(self, app: FastAPI) -> None:
        # Critical: this method is awaited by FastAPI's lifespan. Anything
        # we await here delays the moment the backend starts accepting
        # HTTP / WS connections. The Whisper model load can take 1-3
        # minutes on first run (1.5 GB download), so we MUST NOT block
        # on it — instead we subscribe to audio first (so future arrivals
        # are at least seen), then fire the load as a background task and
        # return. _on_frame drops chunks while the model is None, so
        # nothing crashes during the load window.
        from app.main import get_conn_manager
        self._loop = asyncio.get_running_loop()
        self._conn_manager = get_conn_manager()
        if self._conn_manager and hasattr(self._conn_manager, "audio_bridge"):
            self._conn_manager.audio_bridge.add_audio_consumer(self._on_frame)
            _log("Subscribed to AudioBridge UDP audio stream")
        else:
            _log("WARN: no audio_bridge on conn_manager — cannot subscribe")

        # Spawn the model load. asyncio.create_task schedules it on the
        # current loop; we hold a reference in self._load_task so it
        # isn't garbage-collected mid-flight (asyncio docs explicitly
        # warn about losing task refs). on_stop cancels this if needed.
        if self._model is None and not self._model_loading:
            importlib.invalidate_caches()
            self._load_task = asyncio.create_task(self._load_model_async())

    async def _load_model_async(self) -> None:
        """Background-task wrapper around _load_model_blocking. Keeps
        the lifespan path clean (just create_task, no await) and
        centralises the logging + error handling for both initial boot
        loads and runtime model swaps.

        On failure: log loudly but DON'T re-raise. The extension stays
        registered and reachable; transcribe just produces nothing
        until the user fixes the situation via the Settings UI
        (typically by switching back to a model that works)."""
        _log(
            f"Loading Whisper model '{self._model_name}' in background "
            f"(may need to download ~1.5 GB on first run; cached after)"
        )
        load_t0 = time.perf_counter()
        try:
            await asyncio.to_thread(self._load_model_blocking)
            elapsed = (time.perf_counter() - load_t0) * 1000
            _log(
                f"Model '{self._model_name}' loaded in {elapsed:.0f} ms — "
                f"transcription is now ready"
            )
        except asyncio.CancelledError:
            # Cancellation = user changed model mid-load (on_config_change
            # path) or backend is shutting down. Either way, propagate
            # so callers awaiting the task see the cancellation.
            _log("model load cancelled (config change or shutdown)")
            raise
        except ImportError as e:
            _log(
                f"faster-whisper not importable: {e}. "
                f"Reinstall the extension from Settings."
            )
        except Exception as e:
            _log(
                f"Background model load FAILED: {type(e).__name__}: {e}. "
                f"Switch to a working model in Settings to recover."
            )

    async def on_stop(self) -> None:
        # Cancel any in-flight background load before tearing down the
        # rest of the state. Otherwise the load task could finish AFTER
        # on_stop returns, set self._model to a fresh WhisperModel, and
        # leak a CUDA context with no owner.
        if self._load_task is not None and not self._load_task.done():
            self._load_task.cancel()
            try:
                await self._load_task
            except (asyncio.CancelledError, Exception):
                pass
        self._load_task = None

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

    # -------- Cache enumeration / deletion ---------------------------------

    @staticmethod
    def _human_size(n: int) -> str:
        """Bytes → '1.5 GB' style. Local helper so we don't pull in a
        dependency just for a one-line formatter."""
        size = float(n)
        for unit in ("B", "KB", "MB", "GB"):
            if size < 1024:
                return f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} TB"

    def _enumerate_cached_models(self) -> List[Dict[str, Any]]:
        """Walk MODELS_DIR for any 'faster-whisper-*' repo and return
        a list with name + on-disk size. Matches BOTH org prefixes
        that ship faster-whisper builds (Systran for the official
        lineage, mobiuslabsgmbh for large-v3-turbo, plus any future
        repackagers)."""
        out: List[Dict[str, Any]] = []
        if not self.MODELS_DIR.is_dir():
            return out
        for path in self.MODELS_DIR.glob("models--*--faster-whisper-*"):
            if not path.is_dir():
                continue
            # Repo dir name is "models--{org}--faster-whisper-{name}".
            # Splitting on the literal substring is more robust than
            # counting dashes — model names can contain dashes too
            # (e.g. "large-v3", "distil-large-v3").
            parts = path.name.split("--faster-whisper-", 1)
            if len(parts) != 2:
                continue
            name = parts[1]
            try:
                total = sum(
                    f.stat().st_size for f in path.rglob("*") if f.is_file()
                )
            except OSError:
                # Permissions / file-in-use — skip rather than fail the
                # whole status call.
                total = 0
            out.append({
                "name": name,
                "size_bytes": total,
                "size_human": self._human_size(total),
                # Active = name matches AND model is loaded (not just
                # configured). Frontend uses this to disable the
                # delete button for the live model.
                "is_active": (
                    name == self._model_name and self._model is not None
                ),
            })
        return sorted(out, key=lambda e: e["name"])

    async def delete_cache_entry(self, key: str) -> Dict[str, Any]:
        """Remove the on-disk model cache (under MODELS_DIR) for one
        Whisper model. Refuses to delete the currently-loaded model —
        caller (frontend) should switch to a different model first.

        Why we don't transparently switch: deleting an active model
        while it's being used would yank VRAM-mapped files mid-inference
        and CT2 would crash hard. Forcing the user to switch first makes
        the dependency explicit and the failure mode predictable."""
        import shutil

        if key == self._model_name and self._model is not None:
            raise ValueError(
                f"Cannot delete '{key}': it's the currently loaded model. "
                f"Switch the model in the dropdown first, then delete."
            )

        candidates = list(
            self.MODELS_DIR.glob(f"models--*--faster-whisper-{key}")
        )
        if not candidates:
            raise ValueError(f"No cache found for '{key}'")

        deleted_paths: List[str] = []
        freed = 0
        for path in candidates:
            try:
                size = sum(
                    f.stat().st_size for f in path.rglob("*") if f.is_file()
                )
            except OSError:
                size = 0
            shutil.rmtree(path, ignore_errors=False)
            freed += size
            deleted_paths.append(str(path))

        _log(
            f"deleted cache for '{key}': "
            f"{len(deleted_paths)} dir(s), {self._human_size(freed)} freed"
        )
        return {
            "key": key,
            "deleted_paths": deleted_paths,
            "freed_bytes": freed,
            "freed_human": self._human_size(freed),
        }

    async def on_config_change(self, config: Dict[str, Any]) -> None:
        """Apply a settings update from the UI.

        Hot-reload knobs (chunk / overlap / beam) are simple field
        assignments that the next dispatched chunk picks up — no
        downtime. Cold knob (model_name) triggers a model reload, which
        on a fresh model means the HuggingFace download stage; in-flight
        transcribes during the reload return empty (model is None) but
        the pipeline self-recovers within a couple of seconds.

        Called via two distinct paths:
          1. Boot path: manager calls this BEFORE on_start, so we just
             update fields. self._model is None at this point, so the
             model_name branch updates the field without trying to
             reload — the upcoming on_start handles the actual load.
          2. Runtime path: manager calls this AFTER on_start while the
             extension is live. self._model is set, so a model_name
             change triggers a reload on the spot.

        Receives the FULL merged config (manager merged the API patch
        with persisted state); checks via `if key in config` so a
        partial schema rollout doesn't crash."""
        if "chunk_seconds" in config:
            self._chunk_seconds = float(config["chunk_seconds"])
        if "overlap_seconds" in config:
            # Clamp: overlap >= chunk would mean the buffer never
            # advances and we'd transcribe the same audio forever.
            new_overlap = float(config["overlap_seconds"])
            self._overlap_seconds = min(new_overlap, self._chunk_seconds - 0.1)
        if "beam_size" in config:
            self._beam_size = max(1, int(config["beam_size"]))

        new_model = config.get("model_name")
        if new_model and new_model != self._model_name:
            old_model = self._model_name
            self._model_name = new_model
            _log(
                f"model_name change: {old_model} → {new_model} "
                f"(model_currently_loaded={self._model is not None})"
            )

            if self._loop is None:
                # Boot path: manager calls on_config_change BEFORE
                # on_start, so no model is loaded yet and on_start will
                # pick up the new name when it spawns the load.
                _log("  (boot path: load deferred to on_start)")
            else:
                # Runtime path: in-process model swap is DISABLED.
                #
                # We've tried twice (sync reload + gc.collect, then
                # async load + gc.collect) and both crash CT2 native
                # code on certain transitions on Windows + CUDA. The
                # CUDA destructor of the outgoing model can segfault
                # when forced to run near a fresh allocation —
                # uncatchable from Python, takes the whole backend
                # process down.
                #
                # Persistence is already done: manager.update_config
                # wrote `config.model_name` to disk BEFORE calling us,
                # so the next backend boot will load the new model
                # automatically (init_from_state runs on_config_change
                # before on_start). The user just needs to restart.
                #
                # The frontend's `requires_reload: true` schema flag
                # surfaces this — its badge reads "Restart required",
                # not "Will reload now".
                _log(
                    f"  in-process swap is disabled — restart backend "
                    f"to load '{new_model}'. Current model '{old_model}' "
                    f"keeps running until then."
                )
                # Critical: revert _model_name so the running model
                # name in status() matches the actually-loaded model.
                # The persisted config keeps the new value (that's what
                # boot will pick up); only the in-memory mirror reverts.
                self._model_name = old_model

        _log(
            f"config applied: model={self._model_name}, "
            f"chunk={self._chunk_seconds}s, overlap={self._overlap_seconds}s, "
            f"beam={self._beam_size}"
        )

    def status(self) -> dict:
        return {
            "model_name": self._model_name,
            "model_loaded": self._model is not None,
            "model_loading": self._model_loading,
            "ws_clients": len(self._ws_clients),
            "active_lang": self._active_lang or "auto-detect",
            # Live values, may differ from defaults if the user has
            # adjusted them via the Settings UI.
            "chunk_seconds": self._chunk_seconds,
            "overlap_seconds": self._overlap_seconds,
            "beam_size": self._beam_size,
            "silence_rms_db": self.SILENCE_RMS_DB,
            # On-disk HuggingFace cache enumeration. The frontend uses
            # this to render a "delete" button per cached model so the
            # user can reclaim disk without leaving the Settings UI.
            "cached_models": self._enumerate_cached_models(),
            # Live pipeline counters — poll via GET /api/extensions to
            # see whether UDP frames are reaching the extension and
            # whether transcribe is succeeding.
            "frames_received": self._frame_count,
            "buffer_bytes": len(self._buffer),
            "chunks_dispatched": self._chunk_count,
            "chunks_dropped_busy": self._drop_count,
            # Counts chunks discarded because the model wasn't loaded
            # yet — typically nonzero only during the first few seconds
            # after backend boot or right after a model swap.
            "chunks_dropped_not_ready": self._not_ready_drop_count,
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

        chunk_bytes = int(self.SAMPLE_RATE * self._chunk_seconds) * self.BYTES_PER_SAMPLE
        overlap_bytes = int(self.SAMPLE_RATE * self._overlap_seconds) * self.BYTES_PER_SAMPLE
        # Slide the window forward by (chunk - overlap), NOT by the full
        # chunk: the trailing overlap stays in the buffer so it becomes
        # the leading audio of the next chunk. A spoken word that
        # straddles a boundary therefore appears whole in at least one
        # chunk, instead of being sliced mid-syllable in both.
        advance_bytes = chunk_bytes - overlap_bytes
        if len(self._buffer) < chunk_bytes:
            return

        # Slice the chunk *without* removing the overlap tail. If a
        # transcribe is already in-flight, drop this chunk entirely to
        # avoid queueing a backlog — faster-whisper can't keep up with
        # real-time on slow hardware and stale transcripts are worse
        # than gaps.
        chunk = bytes(self._buffer[:chunk_bytes])
        del self._buffer[:advance_bytes]

        # Model not ready yet (initial async load, or mid-swap). Drop
        # silently — dispatching would just hit
        # transcribe_pcm16's "Whisper model not loaded yet" raise and
        # spam the log. Log every 20th drop so you can still see
        # there's audio piling up while we wait.
        if self._model is None:
            self._not_ready_drop_count += 1
            if (
                self._not_ready_drop_count == 1
                or self._not_ready_drop_count % 20 == 0
            ):
                _log(
                    f"DROP chunk: model not ready "
                    f"(loading={self._model_loading}); "
                    f"total dropped while loading={self._not_ready_drop_count}"
                )
            return

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
            f"{chunk_bytes}B ({self._chunk_seconds:.1f}s of PCM16 @ {self.SAMPLE_RATE} Hz)"
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

        # Raw text feeds the next chunk's initial_prompt and is the
        # reference for the next dedup. Broadcast text has the overlap
        # region stripped so each spoken word reaches the user once.
        prev_raw = self._last_raw_text or ""
        broadcast_text = self._strip_overlap_prefix(prev_raw, text)
        self._last_raw_text = text
        self._last_text = broadcast_text

        if not broadcast_text:
            # Whole new chunk's content was inside the overlap with the
            # previous chunk — user has already seen these words. Skip
            # the broadcast but keep _last_raw_text updated for the next
            # round's prompt + dedup.
            _log(
                f"transcribe done in {elapsed:.0f} ms → "
                f"FULLY DEDUPED (raw={text!r}); skipping broadcast"
            )
            return

        stripped_chars = len(text) - len(broadcast_text)
        preview = (
            broadcast_text if len(broadcast_text) <= 80
            else broadcast_text[:77] + "…"
        )
        _log(
            f"transcribe done in {elapsed:.0f} ms → "
            f"text={preview!r}"
            + (f" (deduped {stripped_chars} chars from overlap)" if stripped_chars else "")
        )

        payload = {"kind": "partial", "text": broadcast_text}
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
        audio so the new client doesn't receive stale transcripts.
        Also clears _last_raw_text so a previous session's words don't
        leak into the new client's first chunk via initial_prompt."""
        self._buffer.clear()
        self._last_raw_text = None
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

    def transcribe_audio_file(self, path: Path) -> Dict[str, Any]:
        """Batch-transcribe one already-saved WAV (NOT for streaming).

        Used by the Recordings drawer: user clicks a saved recording,
        we run the whole file through Whisper in one shot and return
        the transcript.

        Differs from the streaming path (transcribe_pcm16) in three
        ways:
          1. No silence gate / pre-amp — we trust offline audio is
             well-recorded enough to feed straight to the model.
          2. No initial_prompt continuity — each file is independent;
             carrying state from the live stream would pollute results.
          3. Single decode pass instead of chunk-by-chunk — faster-whisper
             handles long audio internally via its own VAD-driven
             segmentation.

        The expected file format matches what RecordingService writes:
        16 kHz mono PCM16. Anything else raises ValueError so the API
        layer can return 400 to the frontend.

        Returns: {text, language, language_probability, duration_seconds,
                  transcribe_ms}. The frontend renders text + duration.
        """
        import wave
        import numpy as np  # type: ignore

        if self._model is None:
            raise RuntimeError(
                "Whisper model not loaded yet — try again in a few seconds."
            )

        with wave.open(str(path), "rb") as w:
            n_chan = w.getnchannels()
            sw = w.getsampwidth()
            sr = w.getframerate()
            n_frames = w.getnframes()
            if sw != 2 or n_chan != 1 or sr != self.SAMPLE_RATE:
                raise ValueError(
                    f"Expected mono 16-bit PCM @ {self.SAMPLE_RATE} Hz, "
                    f"got {n_chan}ch {sw*8}-bit @ {sr} Hz"
                )
            raw = w.readframes(n_frames)

        audio = np.frombuffer(raw, dtype=np.int16).astype("float32") / 32768.0
        duration_seconds = len(audio) / float(self.SAMPLE_RATE)
        _log(
            f"transcribe_file: {path.name} ({duration_seconds:.1f} s, "
            f"{len(audio)} samples)"
        )

        t0 = time.perf_counter()
        segments, info = self._model.transcribe(
            audio,
            beam_size=self._beam_size,
            language=self._active_lang,  # None → auto-detect
            vad_filter=True,
        )
        text = "".join(s.text for s in segments).strip()
        elapsed_ms = (time.perf_counter() - t0) * 1000
        _log(
            f"transcribe_file done in {elapsed_ms:.0f} ms → "
            f"lang={getattr(info, 'language', '?')}, "
            f"chars={len(text)}"
        )
        return {
            "text": text,
            "language": getattr(info, "language", None),
            "language_probability": float(
                getattr(info, "language_probability", 0.0)
            ),
            "duration_seconds": duration_seconds,
            "transcribe_ms": round(elapsed_ms, 1),
        }

    @staticmethod
    def _strip_overlap_prefix(prev: str, new: str) -> str:
        """Drop the leading characters of `new` that duplicate the trailing
        characters of `prev`. The OVERLAP_SECONDS audio is decoded in two
        consecutive chunks — without this dedup the user sees the boundary
        words twice.

        Strategy: find the longest k where prev[-k:] == new[:k], with a
        4-char minimum so we don't strip on incidental short matches like
        a shared "the" or "了". Char-level (not word-level) so the same
        code path works for CJK and space-separated languages.

        Capped at 60 chars (≈ 0.5 s of speech worth of text in either
        script) — more than the overlap window can plausibly produce."""
        if not prev or not new:
            return new
        max_len = min(len(prev), len(new), 60)
        for k in range(max_len, 3, -1):
            if prev[-k:] == new[:k]:
                return new[k:].lstrip()
        return new

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

        # (5) Decode. Language pin (when set) + beam search + previous
        # chunk's raw text as initial_prompt for cross-window context
        # over the OVERLAP_SECONDS region. Truncate to the trailing
        # ~120 chars: Whisper's prompt slot is ~224 tokens, and only the
        # recent tail is relevant for continuity — older text dilutes the
        # signal.
        prompt = self._last_raw_text[-120:] if self._last_raw_text else None
        segments, info = self._model.transcribe(
            audio,
            beam_size=self._beam_size,
            language=self._active_lang,  # None → auto-detect
            vad_filter=True,
            initial_prompt=prompt,
        )
        text = "".join(s.text for s in segments).strip()
        lang = getattr(info, "language", "?")
        lang_prob = getattr(info, "language_probability", 0.0)
        _log(
            f"transcribe model result: lang={lang} ({lang_prob:.2f}), "
            f"pinned={self._active_lang or 'no'}, chars={len(text)}"
        )
        return text
