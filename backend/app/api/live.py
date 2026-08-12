"""
Live-stream ownership — which patient the single connected device streams for.

The 8080 backend holds ONE device connection at a time and broadcasts that one
stream to every dashboard. Without a claim, a doctor viewing patient B would see
patient A's live glove data mislabeled as B's. When a patient connects their
glove the frontend claims the stream here; the dashboard reads it and refuses to
render the stream under a different patient. In-memory + process-wide, matching
the single-device model — it clears on backend restart or on disconnect.

Honest boundary: this is a coordination signal, not access control. It stops
accidental cross-patient mislabeling; it does not (and cannot) make one glove
stream to two patients at once.
"""
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# Process-wide single owner, or None when nobody has claimed the live stream.
_owner: Optional[dict] = None


class LiveOwner(BaseModel):
    patient_id: str
    patient_name: Optional[str] = None


@router.get("/owner")
async def get_owner():
    """Current live-stream owner, or {"owner": null} when unclaimed."""
    return {"owner": _owner}


@router.post("/owner")
async def set_owner(body: LiveOwner):
    """Claim the live stream for a patient (called when their glove connects)."""
    global _owner
    _owner = {"patient_id": body.patient_id, "patient_name": body.patient_name or ""}
    return {"ok": True, "owner": _owner}


@router.delete("/owner")
async def clear_owner():
    """Release the claim (called on disconnect)."""
    global _owner
    _owner = None
    return {"ok": True}
