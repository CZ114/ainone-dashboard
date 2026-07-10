"""
Voice transcription HTTP routes — paired with the /call frontend page.

Provides one endpoint:

    POST /api/voice/transcribe
        Body: raw audio bytes (any container faster-whisper / pyav can
              decode — WebM/Opus, OGG, WAV, MP3, …). Browser
              MediaRecorder defaults to WebM/Opus, which is what we
              expect from the frontend.
        Query: ?lang=<BCP-47>  (optional; e.g. en-US, zh-CN)
        Returns: { text, language, language_probability,
                   duration_seconds, transcribe_ms }

The hot path is faster-whisper's `transcribe(BinaryIO)` which uses pyav
under the hood for the codec decode — no ffmpeg subprocess, no temp
files. We just hand it the bytes.

Streaming live ESP32 audio uses a different path (`/ws/transcribe`
WebSocket fed by UDP); see `app/api/websocket.py`. This file is only
for one-shot blob uploads.
"""
from fastapi import APIRouter, HTTPException, Query, Request

from app.extensions.manager import get_manager
from app.api.websocket import bcp47_to_whisper

router = APIRouter()


@router.post("/clip/start")
async def clip_start():
    """Begin buffering ESP32 UDP audio into a one-shot clip. Pair with
    POST /api/voice/clip/stop to finalise + transcribe.

    Used by the call page's record-then-transcribe ESP32 mode. The
    live `/ws/transcribe` WebSocket path is independent and unaffected
    by clip recording — both can run simultaneously in theory."""
    ext = get_manager().get_instance("whisper-local")
    if ext is None:
        raise HTTPException(
            status_code=503,
            detail="Whisper-local extension is not enabled.",
        )
    ext.start_voice_clip()
    return {"ok": True}


@router.post("/clip/stop")
async def clip_stop(lang: str = Query("")):
    """Stop buffering, transcribe the captured clip, return text."""
    ext = get_manager().get_instance("whisper-local")
    if ext is None:
        raise HTTPException(
            status_code=503,
            detail="Whisper-local extension is not enabled.",
        )
    data = ext.stop_voice_clip()
    if not data:
        # No audio captured (clip was never started, or UDP feed was
        # silent). Return an empty transcript rather than 4xx so the
        # frontend can proceed gracefully.
        return {
            "text": "",
            "language": None,
            "language_probability": 0.0,
            "duration_seconds": 0.0,
            "transcribe_ms": 0.0,
        }

    whisper_lang = bcp47_to_whisper(lang) or None
    try:
        return ext.transcribe_pcm_clip(data, lang=whisper_lang)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {type(e).__name__}: {e}",
        )


@router.post("/transcribe-pcm")
async def transcribe_pcm(request: Request, lang: str = Query("")):
    """Raw PCM16 mono 16 kHz blob → transcript.

    Used by the Call page's mic source via an AudioWorklet capture path.
    Mirrors the ESP32 clip flow: the browser decimates getUserMedia to
    16 kHz mono Int16 with a rolling preroll, ships the raw PCM, and
    we hand it directly to faster-whisper without a codec round-trip.

    Body: raw PCM16 little-endian bytes, mono, 16 kHz. Empty body is
    treated as 'no speech' and returns an empty transcript (same shape
    as /clip/stop with no audio captured), so a misfire doesn't 4xx.
    """
    ext = get_manager().get_instance("whisper-local")
    if ext is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Whisper-local extension is not enabled. "
                "Install/enable it from Settings."
            ),
        )

    data = await request.body()
    if not data:
        return {
            "text": "",
            "language": None,
            "language_probability": 0.0,
            "duration_seconds": 0.0,
            "transcribe_ms": 0.0,
        }

    # 20 MB ≈ 10 minutes of PCM16 16 kHz mono — well past anything the
    # call page should ever produce. Cap protects against runaway buffers
    # or accidental file uploads.
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail="Audio too large (max 20 MB).",
        )

    whisper_lang = bcp47_to_whisper(lang) or None
    try:
        return ext.transcribe_pcm_clip(data, lang=whisper_lang)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {type(e).__name__}: {e}",
        )


@router.post("/transcribe")
async def transcribe(request: Request, lang: str = Query("")):
    """One-shot blob → transcript. The body is the raw audio bytes;
    we don't insist on a particular Content-Type since faster-whisper
    figures the codec out from the data itself."""
    ext = get_manager().get_instance("whisper-local")
    if ext is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Whisper-local extension is not enabled. "
                "Install/enable it from Settings."
            ),
        )

    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Empty body")

    # Cap upload size at ~10 MB so a runaway recorder can't OOM the
    # backend. ~10 minutes of WebM/Opus is well under that.
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail="Audio too large (max 10 MB).",
        )

    whisper_lang = bcp47_to_whisper(lang) or None
    try:
        result = ext.transcribe_blob(data, lang=whisper_lang)
    except RuntimeError as e:
        # Model still warming up.
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        # Decode failures land here. faster-whisper's underlying pyav
        # raises pretty cryptic errors; log them server-side and
        # return a generic 500 with the type name so the user sees
        # something actionable.
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {type(e).__name__}: {e}",
        )

    return result
