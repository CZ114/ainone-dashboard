"""
Recording API routes
"""
from fastapi import APIRouter, HTTPException
from app.models.schemas import RecordingStartRequest, RecordingStatus

router = APIRouter()


def get_connection_manager():
    from app.main import get_conn_manager
    return get_conn_manager()


@router.post("/start")
async def start_recording(request: RecordingStartRequest):
    """Start recording sensor data and/or audio"""
    conn = get_connection_manager()

    if conn.recording_service.is_currently_recording():
        raise HTTPException(status_code=400, detail="Recording already in progress")

    success = conn.recording_start(
        duration=request.duration_seconds,
        include_audio=request.include_audio
    )

    return {
        "started": True,
        "duration_seconds": request.duration_seconds,
        "include_audio": request.include_audio
    }


@router.post("/stop")
async def stop_recording():
    """Stop recording"""
    conn = get_connection_manager()

    if not conn.recording_service.is_currently_recording():
        raise HTTPException(status_code=400, detail="No recording in progress")

    result = conn.recording_stop()

    return {
        "stopped": True,
        "elapsed_seconds": result['elapsed_seconds'],
        "csv_path": result['csv_path'],
        "audio_path": result['audio_path']
    }


@router.get("/status")
async def get_recording_status():
    """Get recording status"""
    conn = get_connection_manager()
    return conn.recording_status()