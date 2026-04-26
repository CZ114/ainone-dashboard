"""
Audio API routes
"""
from fastapi import APIRouter, HTTPException
from app.models.schemas import AudioStartRequest, AudioStatus

router = APIRouter()


def get_connection_manager():
    from app.main import get_conn_manager
    return get_conn_manager()


@router.post("/start")
async def start_audio(request: AudioStartRequest):
    """Start UDP audio listener"""
    conn = get_connection_manager()

    if conn.audio_is_connected():
        conn.audio_stop()

    success = conn.audio_start(request.port)

    if not success:
        raise HTTPException(status_code=400, detail="Failed to start audio listener")

    return {"connected": True, "port": request.port}


@router.post("/stop")
async def stop_audio():
    """Stop UDP audio listener"""
    conn = get_connection_manager()
    conn.audio_stop()
    return {"connected": False}


@router.get("/status")
async def get_audio_status():
    """Get audio connection status"""
    conn = get_connection_manager()
    connected = conn.audio_is_connected()

    rms_db, peak_db = -100.0, -100.0
    if connected:
        rms_db, peak_db = conn.audio_bridge.get_levels()

    return {
        "connected": connected,
        "rms_db": rms_db,
        "peak_db": peak_db
    }