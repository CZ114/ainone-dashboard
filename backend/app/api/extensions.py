"""Extensions management API.

Routes:
    GET  /api/extensions                           list all + status
    GET  /api/extensions/{id}                      single status
    POST /api/extensions/{id}/install              start async install
    GET  /api/extensions/{id}/install-progress     SSE progress stream
    POST /api/extensions/{id}/enable
    POST /api/extensions/{id}/disable
    POST /api/extensions/{id}/uninstall
    POST /api/extensions/{id}/config               update extension config
    POST /api/extensions/{id}/cache/delete         delete one cache entry
"""
import asyncio
import json
from typing import Any, AsyncGenerator, Dict

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import StreamingResponse

from app.extensions.manager import get_manager, InstallJob

router = APIRouter()


@router.get("")
async def list_extensions():
    """List all known extensions with current install/enable state."""
    return {"extensions": get_manager().list_all_status()}


@router.get("/{ext_id}")
async def get_extension(ext_id: str):
    status = get_manager().get_status_dict(ext_id)
    if not status:
        raise HTTPException(status_code=404, detail="Unknown extension")
    return status


@router.post("/{ext_id}/install")
async def install_extension(ext_id: str):
    manager = get_manager()
    try:
        job = await manager.install(ext_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {
        "ext_id": ext_id,
        "started": True,
        "already_running": job.started_at != job.started_at,  # never true, kept for future
    }


@router.get("/{ext_id}/install-progress")
async def install_progress(ext_id: str):
    """SSE stream of install events. Each event is a JSON object:
        {"kind": "log", "line": "..."}
        {"kind": "progress", "pct": 0.42}
        {"kind": "done", "success": true, "error": null}
    The stream closes after the "done" event.

    Safe to connect after the job has finished — the sentinel is still
    in the queue, and subsequent `get`s will block forever, so we guard
    by checking `job.done` before entering the loop.
    """
    manager = get_manager()
    job = manager.get_install_job(ext_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail="No install job for this extension. Start one first.",
        )

    return StreamingResponse(
        _sse_stream(job),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable buffering behind proxies
        },
    )


async def _sse_stream(job: InstallJob) -> AsyncGenerator[bytes, None]:
    # If the job already finished before the consumer connected, emit a
    # single terminal event and close. This matches what a mid-install
    # consumer sees when it catches up to the sentinel in the queue.
    if job.done:
        payload = {"kind": "done", "success": job.success, "error": job.error}
        yield _sse_frame(payload)
        return

    while True:
        try:
            event = await asyncio.wait_for(job.queue.get(), timeout=60.0)
        except asyncio.TimeoutError:
            # Heartbeat to keep intermediaries from closing the connection.
            yield b": ping\n\n"
            continue
        yield _sse_frame(event)
        if event.get("kind") == "done":
            return


def _sse_frame(obj: dict) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")


@router.post("/{ext_id}/enable")
async def enable_extension(ext_id: str):
    try:
        await get_manager().enable(ext_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ext_id": ext_id, "enabled": True}


@router.post("/{ext_id}/disable")
async def disable_extension(ext_id: str):
    await get_manager().disable(ext_id)
    return {"ext_id": ext_id, "enabled": False}


@router.post("/{ext_id}/uninstall")
async def uninstall_extension(ext_id: str):
    await get_manager().uninstall(ext_id)
    return {"ext_id": ext_id, "installed": False}


@router.post("/{ext_id}/config")
async def update_extension_config(
    ext_id: str, body: Dict[str, Any] = Body(...),
):
    """Merge `body` into the extension's persisted config and notify the
    running instance. Body is a partial patch — only the keys present
    are updated; existing config keys not in the patch are preserved.

    Returns the FULL merged config so the frontend can replace its
    pending state with what the backend now considers authoritative."""
    try:
        new_config = await get_manager().update_config(ext_id, body)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ext_id": ext_id, "config": new_config}


@router.post("/{ext_id}/cache/delete")
async def delete_extension_cache(
    ext_id: str, body: Dict[str, Any] = Body(...),
):
    """Delete one cache entry owned by the extension. Body shape:
        {"key": "<entry-id-the-extension-understands>"}
    For whisper-local the key is a model name like 'medium'.

    Status codes:
      400  bad input (missing key, can't delete active model, etc.)
      404  unknown extension id
      501  extension exposes no deletable caches"""
    key = body.get("key")
    if not isinstance(key, str) or not key:
        raise HTTPException(
            status_code=400, detail="Body must include 'key' (string)",
        )
    try:
        result = await get_manager().delete_cache_entry(ext_id, key)
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except ValueError as e:
        # Both "unknown id" and "active model" map to 400 here; the
        # message text disambiguates. 404 would be ambiguous for the
        # active-model case (the resource exists, just isn't deletable).
        raise HTTPException(status_code=400, detail=str(e))
    return result
