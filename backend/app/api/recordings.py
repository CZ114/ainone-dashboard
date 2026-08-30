"""
Recordings Library API — list and fetch saved recording sessions.

Pairs CSV + WAV files by the YYYYMMDD_HHMMSS timestamp embedded in their
filename. This is distinct from the /api/recording/* router (live
recording control: start / stop / status).

Security: filename whitelist via regex. Only names matching our own
writer's convention are accepted, which eliminates path traversal
without needing a separate check.
"""
import re
import wave
import csv as csv_module
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, FileResponse

from app.config import CSV_DIR, AUDIO_DIR

router = APIRouter()

# Patient-attribution sidecars written by RecordingService (recordings/meta/<ts>.json).
META_DIR = CSV_DIR.parent / "meta"

CSV_NAME_RE = re.compile(r'^sensor_(\d{8}_\d{6})\.csv$')
AUDIO_NAME_RE = re.compile(r'^audio_(\d{8}_\d{6})\.wav$')
TIMESTAMP_RE = re.compile(r'^\d{8}_\d{6}$')


def _parse_iso(ts: str) -> Optional[str]:
    try:
        return datetime.strptime(ts, "%Y%m%d_%H%M%S").isoformat()
    except ValueError:
        return None


def _count_csv_rows(path: Path) -> Optional[int]:
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            n = sum(1 for _ in f)
            return max(0, n - 1)
    except Exception:
        return None


def _csv_channels(path: Path) -> Optional[list]:
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            reader = csv_module.reader(f)
            header = next(reader, None)
            if not header:
                return None
            return [h for h in header if h != 'timestamp']
    except Exception:
        return None


def _wav_duration_seconds(path: Path) -> Optional[float]:
    try:
        with wave.open(str(path), 'rb') as w:
            frames = w.getnframes()
            rate = w.getframerate()
            if rate > 0:
                return frames / float(rate)
    except Exception:
        return None
    return None


# ── Quality metadata (Phase 1, gap 6 — quality-aware context) ─────────
# Firmware's fused 12-column frame order (see hardware survey / integrated_esp32.ino).
# Recorded CSVs usually carry generic CH1..CH12 names (DataProcessor auto-naming),
# so when the width matches we re-label columns with their real modality names.
FIRMWARE_12COL_NAMES = [
    "t_ms", "gsr_filtered", "ppg_ir", "hr_bpm_avg",
    "imu_ax_mps2", "imu_ay_mps2", "imu_az_mps2", "imu_steps",
    "env_temp_c", "env_humidity_rh", "env_pressure_pa", "env_altitude_m",
]
# Columns where a constant value is expected/benign (monotonic counter or clock),
# excluded from "flat channel" suspicion.
_FLAT_OK = {"t_ms", "imu_steps"}
_QUALITY_MAX_ROWS = 500_000  # hard cap; beyond this we stop and mark truncated


def _parse_wall_ts(s: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _compute_csv_quality(path: Path) -> dict:
    """Single pass over the CSV → time range, rate, per-channel stats & flags.

    Pure computation, no caching; see _quality_cached for the sidecar cache.
    """
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        reader = csv_module.reader(f)
        header = next(reader, None) or []
        raw_names = header[1:] if header and header[0] == "timestamp" else header

        # Re-label generic CH1..CHn with firmware modality names when width matches.
        generic = all(re.fullmatch(r"CH\d+", n) for n in raw_names) if raw_names else False
        mapped = generic and len(raw_names) == len(FIRMWARE_12COL_NAMES)
        names = FIRMWARE_12COL_NAMES if mapped else raw_names

        n = len(names)
        stats = [{"n": 0, "missing": 0, "zeros": 0, "min": None, "max": None, "sum": 0.0}
                 for _ in range(n)]
        rows = 0
        truncated = False
        first_ts = last_ts = None

        for row in reader:
            if rows >= _QUALITY_MAX_ROWS:
                truncated = True
                break
            rows += 1
            if row:
                if first_ts is None:
                    first_ts = row[0]
                last_ts = row[0]
            for i in range(n):
                st = stats[i]
                val = row[i + 1] if i + 1 < len(row) else ""
                try:
                    v = float(val)
                except (TypeError, ValueError):
                    st["missing"] += 1
                    continue
                st["n"] += 1
                if v == 0.0:
                    st["zeros"] += 1
                st["min"] = v if st["min"] is None else min(st["min"], v)
                st["max"] = v if st["max"] is None else max(st["max"], v)
                st["sum"] += v

    t0, t1 = _parse_wall_ts(first_ts or ""), _parse_wall_ts(last_ts or "")
    duration_s = (t1 - t0).total_seconds() if (t0 and t1) else None
    rate = (rows / duration_s) if (duration_s and duration_s > 0) else None

    per_channel, suspects = [], []
    for name, st in zip(names, stats):
        total = st["n"] + st["missing"]
        flat = st["n"] > 1 and st["min"] == st["max"]
        all_zero = st["n"] > 0 and st["zeros"] == st["n"]
        entry = {
            "name": name,
            "min": st["min"], "max": st["max"],
            "mean": (st["sum"] / st["n"]) if st["n"] else None,
            "missing_pct": round(st["missing"] / total, 4) if total else 1.0,
            "zero_pct": round(st["zeros"] / st["n"], 4) if st["n"] else None,
            "flat": flat,
        }
        per_channel.append(entry)
        if all_zero and name not in _FLAT_OK:
            suspects.append({"name": name, "reason": "all_zero"})
        elif flat and name not in _FLAT_OK:
            suspects.append({"name": name, "reason": "flat"})
        elif total and st["missing"] / total > 0.05:
            suspects.append({"name": name, "reason": "missing_gt_5pct"})

    # Device-clock duration cross-check (whenever the first column is t_ms —
    # either natively named by newer firmware or re-labelled above).
    device_duration_s = None
    if (names and names[0] == "t_ms" and per_channel
            and per_channel[0]["min"] is not None):
        device_duration_s = round((per_channel[0]["max"] - per_channel[0]["min"]) / 1000.0, 2)

    return {
        "rows": rows,
        "truncated": truncated,
        "channels": names,
        "firmware_mapped": mapped,
        "t_start": t0.isoformat() if t0 else None,
        "t_end": t1.isoformat() if t1 else None,
        "duration_s": round(duration_s, 2) if duration_s is not None else None,
        "device_duration_s": device_duration_s,
        "sample_rate_hz": round(rate, 2) if rate else None,
        "expected_rate_hz": 50.0,
        "per_channel": per_channel,
        "suspect_channels": suspects,
    }


def _json_safe(obj):
    """Replace non-finite floats with None so the response can be serialised.

    A channel that is entirely NaN (e.g. env_altitude_m in some captures) made
    the stats come out as NaN, which json/FastAPI reject outright - the whole
    quality endpoint 500'd instead of reporting the channel as missing. None is
    the honest encoding: the value is absent, not zero.
    """
    import math
    if isinstance(obj, float):
        return None if not math.isfinite(obj) else obj
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    return obj


def _quality_cached(ts: str) -> Optional[dict]:
    """Compute-or-load quality for a session; sidecar cache keyed by CSV size+mtime."""
    import json
    csv_path = CSV_DIR / f"sensor_{ts}.csv"
    if not csv_path.is_file():
        return None
    st = csv_path.stat()
    qpath = META_DIR / f"{ts}.quality.json"
    if qpath.is_file():
        try:
            cached = json.loads(qpath.read_text(encoding="utf-8"))
            if (cached.get("csv_size") == st.st_size
                    and cached.get("csv_mtime") == int(st.st_mtime)):
                return cached["quality"]
        except Exception:
            pass
    q = _json_safe(_compute_csv_quality(csv_path))
    try:
        META_DIR.mkdir(parents=True, exist_ok=True)
        qpath.write_text(
            json.dumps({"csv_size": st.st_size, "csv_mtime": int(st.st_mtime),
                        "quality": q}, ensure_ascii=False),
            encoding="utf-8")
    except Exception:
        pass
    return q


def _read_patient(ts: str) -> dict:
    """Read the patient sidecar for a session; {patient_id,patient_name} or Nones."""
    try:
        p = META_DIR / f"{ts}.json"
        if p.is_file():
            import json
            m = json.loads(p.read_text(encoding="utf-8"))
            return {"patient_id": m.get("patient_id"), "patient_name": m.get("patient_name")}
    except Exception:
        pass
    return {"patient_id": None, "patient_name": None}


def _session_entry(ts: str) -> dict:
    csv_path = CSV_DIR / f"sensor_{ts}.csv"
    audio_path = AUDIO_DIR / f"audio_{ts}.wav"

    # `path` is the absolute path on disk. Surfaced so the chat-side
    # attachment flow can hand Claude a real path to Read instead of a
    # display label (the prior behaviour produced "file not found" when
    # Claude's CWD differed from <repo>/backend/data/csv/).
    csv_info = None
    if csv_path.is_file():
        csv_info = {
            "filename": csv_path.name,
            "path": str(csv_path.resolve()),
            "size_bytes": csv_path.stat().st_size,
            "rows": _count_csv_rows(csv_path),
        }

    audio_info = None
    if audio_path.is_file():
        audio_info = {
            "filename": audio_path.name,
            "path": str(audio_path.resolve()),
            "size_bytes": audio_path.stat().st_size,
            "duration_seconds": _wav_duration_seconds(audio_path),
        }

    return {
        "id": ts,
        "timestamp": ts,
        "started_at_iso": _parse_iso(ts),
        "csv": csv_info,
        "audio": audio_info,
        **_read_patient(ts),
    }


@router.get("/list")
async def list_recordings(
    patient_id: Optional[str] = Query(
        None, description="Only return recordings tagged to this patient (P-xxx)."
    ),
):
    """Newest first. A session exists if either CSV or WAV is present.

    Optional ?patient_id= filters to one patient's recordings (attribution comes
    from the sidecar meta written at capture time; untagged sessions have null).
    """
    timestamps = set()

    if CSV_DIR.exists():
        for p in CSV_DIR.iterdir():
            m = CSV_NAME_RE.match(p.name)
            if m:
                timestamps.add(m.group(1))

    if AUDIO_DIR.exists():
        for p in AUDIO_DIR.iterdir():
            m = AUDIO_NAME_RE.match(p.name)
            if m:
                timestamps.add(m.group(1))

    sessions = [_session_entry(ts) for ts in sorted(timestamps, reverse=True)]
    if patient_id:
        sessions = [s for s in sessions if s.get("patient_id") == patient_id]
    return {"sessions": sessions, "count": len(sessions)}


@router.get("/meta/{session_id}")
async def get_session_meta(session_id: str):
    if not TIMESTAMP_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")

    entry = _session_entry(session_id)
    if entry["csv"] is None and entry["audio"] is None:
        raise HTTPException(status_code=404, detail="Session not found")

    if entry["csv"]:
        csv_path = CSV_DIR / entry["csv"]["filename"]
        entry["csv"]["channels"] = _csv_channels(csv_path)

    return entry


@router.get("/quality/{session_id}")
async def get_session_quality(session_id: str):
    """Quality metadata for one session's CSV (Phase 1, gap 6).

    Time range, sample rate vs expected 50 Hz, per-channel stats, and
    suspect channels (all-zero / flat / >5% missing). Computed once per
    CSV and cached in meta/<ts>.quality.json keyed by size+mtime, so
    repeat calls are cheap. 404 if the session has no CSV.
    """
    import asyncio as _asyncio

    if not TIMESTAMP_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")

    quality = await _asyncio.to_thread(_quality_cached, session_id)
    if quality is None:
        raise HTTPException(status_code=404, detail="Session has no CSV")

    return {
        "id": session_id,
        "started_at_iso": _parse_iso(session_id),
        **_read_patient(session_id),
        "quality": quality,
    }


@router.get("/csv/{filename}", response_class=PlainTextResponse)
async def get_csv_content(
    filename: str,
    head: Optional[int] = Query(
        None, ge=1, le=100000,
        description="If set, return only header + first N data rows (preview mode)."
    ),
):
    if not CSV_NAME_RE.match(filename):
        raise HTTPException(status_code=400, detail="Invalid filename")

    path = CSV_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    if head is None:
        return path.read_text(encoding='utf-8', errors='replace')

    lines = []
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for i, line in enumerate(f):
            if i > head:
                break
            lines.append(line.rstrip('\n'))
    return '\n'.join(lines)


@router.get("/audio/{filename}")
async def get_audio_file(filename: str):
    if not AUDIO_NAME_RE.match(filename):
        raise HTTPException(status_code=400, detail="Invalid filename")

    path = AUDIO_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(path, media_type="audio/wav", filename=filename)


@router.post("/transcribe/{filename}")
async def transcribe_audio(filename: str):
    """Run the saved WAV through the Whisper extension and return the
    text. Batch mode (NOT streaming) — we feed the entire file in one
    call. Typical latency: 0.5-2 s per minute of audio on GPU; 2-10x
    slower on CPU.

    Status codes:
      400  filename doesn't match our writer's pattern
      404  file doesn't exist on disk
      503  Whisper extension isn't enabled / model isn't loaded yet
      400  WAV format not what we expect (not 16k mono PCM16)
      500  unexpected failure inside the model
    """
    import asyncio as _asyncio

    if not AUDIO_NAME_RE.match(filename):
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = AUDIO_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    # Lazy import to avoid creating a hard dependency on the extension
    # for the recordings router. If the user has Whisper uninstalled
    # the rest of /api/recordings still works fine.
    from app.extensions.manager import get_manager

    inst = get_manager().get_instance("whisper-local")
    if inst is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Whisper extension is not enabled. "
                "Install/enable it from Settings → Extensions."
            ),
        )

    try:
        # transcribe_audio_file is synchronous (blocks on the GPU/CPU
        # decode). Run in a worker thread so we don't stall the
        # event loop while a long file decodes.
        result = await _asyncio.to_thread(inst.transcribe_audio_file, path)
    except RuntimeError as e:
        # "model not loaded yet" lives here
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Transcription failed: {e}",
        )
    return {"filename": filename, **result}
