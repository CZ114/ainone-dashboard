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


def _session_entry(ts: str) -> dict:
    csv_path = CSV_DIR / f"sensor_{ts}.csv"
    audio_path = AUDIO_DIR / f"audio_{ts}.wav"

    csv_info = None
    if csv_path.is_file():
        csv_info = {
            "filename": csv_path.name,
            "size_bytes": csv_path.stat().st_size,
            "rows": _count_csv_rows(csv_path),
        }

    audio_info = None
    if audio_path.is_file():
        audio_info = {
            "filename": audio_path.name,
            "size_bytes": audio_path.stat().st_size,
            "duration_seconds": _wav_duration_seconds(audio_path),
        }

    return {
        "id": ts,
        "timestamp": ts,
        "started_at_iso": _parse_iso(ts),
        "csv": csv_info,
        "audio": audio_info,
    }


@router.get("/list")
async def list_recordings():
    """Newest first. A session exists if either CSV or WAV is present."""
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
