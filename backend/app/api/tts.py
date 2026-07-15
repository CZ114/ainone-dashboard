"""
Text-to-speech HTTP route — paired with the /call frontend page.

Provides:

    POST /api/tts/synthesize
        Body: { "text": "...", "lang": "en"|"zh", "voice"?: "..." }
        Response: audio/mpeg stream (MP3)

Uses `edge-tts`, a pure-python wrapper around Microsoft Edge's free
voice synthesis endpoint. No model downloads, no GPU, no API key —
just a websocket call to Microsoft's cloud. Quality is good enough
that listeners stop noticing it's TTS for short utterances; both
zh-CN-XiaoxiaoNeural and en-US-AriaNeural sound natural.

Why a built-in route rather than an extension: edge-tts has zero
heavy dependencies (no PyTorch / numpy / GPU), so the
"only if user installs it" pattern that whisper-local uses doesn't
buy us much. Keeping it built-in avoids the extension lifecycle
overhead for a feature most demos want.

Voice selection:
    - The frontend sends `lang: "en" | "zh"` and we map to a sensible
      default voice. An explicit `voice` field overrides the default
      so power users can pick "en-GB-RyanNeural" etc. without us
      shipping a voice picker UI yet.

Streaming:
    edge-tts emits MP3 chunks (~10–30 KB each) as the synthesis
    progresses. We forward them with `StreamingResponse` so the
    browser can start playing before the whole reply finishes
    rendering server-side. Latency from request to first byte is
    typically ~150 ms.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter()


class TTSRequest(BaseModel):
    text: str
    lang: str = "en"
    voice: Optional[str] = None


# Curated defaults: pick the most natural-sounding voice for each
# supported UI language.
#
# en-US-AvaMultilingualNeural — Microsoft's 2024 "Multilingual" tier
#   sounds noticeably more human than the older Aria — better prosody,
#   warmer phrasing, less "news anchor". Used to be hidden behind
#   Azure-only access; edge-tts unblocks it via the same free
#   websocket API as the legacy voices.
# zh-CN-XiaoxiaoNeural — kept; the multilingual tier doesn't add much
#   for Chinese, and Xiaoxiao is already very natural.
#
# Power users can override per-request via the `voice` field.
_DEFAULT_VOICES: dict[str, str] = {
    "en": "en-US-AvaMultilingualNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
}


# Cap input length so a runaway client can't tie up the websocket for
# minutes. ~3000 chars is well past anything the call page generates.
_MAX_TEXT_CHARS = 3000


@router.post("/synthesize")
async def synthesize(req: TTSRequest):
    """Synthesize `text` to MP3 via Microsoft Edge's voice cloud.

    Returns the audio bytes streamed as `audio/mpeg`. The frontend
    plays this through a plain `<audio>` element with a Blob URL.
    """
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text.")
    if len(text) > _MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"Text too long (max {_MAX_TEXT_CHARS} chars).",
        )

    voice = req.voice or _DEFAULT_VOICES.get(req.lang, _DEFAULT_VOICES["en"])

    # edge_tts is imported lazily so the rest of the API still boots
    # if the user hasn't run `pip install -r requirements.txt` after
    # we added the dep. Without this, the import error would crash
    # FastAPI on startup with a misleading traceback.
    try:
        import edge_tts  # type: ignore
    except ImportError as e:
        raise HTTPException(
            status_code=503,
            detail=(
                "edge-tts package not installed. Run "
                "`pip install -r backend/requirements.txt` and restart."
            ),
        ) from e

    communicate = edge_tts.Communicate(text, voice)

    async def stream():
        try:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    yield chunk["data"]
        except Exception as e:
            # We can't raise an HTTPException once the response has
            # started streaming — log and end the stream so the
            # browser's `<audio>` element fires `error` cleanly.
            import traceback
            traceback.print_exc()
            print(f"[tts] synth failed mid-stream: {e}")
            return

    return StreamingResponse(
        stream(),
        media_type="audio/mpeg",
        # Disable nginx-style buffering so the browser starts playing
        # as soon as the first chunk arrives rather than waiting for
        # the whole MP3 to land.
        headers={"X-Accel-Buffering": "no"},
    )
