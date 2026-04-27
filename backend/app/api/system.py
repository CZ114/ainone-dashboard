"""System-level operations exposed to the frontend.

Currently just one route: trigger a backend restart. Lives in its
own module rather than under /api/extensions because the action is
process-wide, not extension-scoped — any caller (or future feature)
that needs a fresh process can hit the same endpoint."""
import asyncio
import os

from fastapi import APIRouter

router = APIRouter()

# Must match RESTART_EXIT_CODE in backend/run.py. The supervisor
# script watches for this specific value and respawns the child.
# Picked 42 (not 0/1) so it can never be confused with a normal exit
# or a generic "something failed" code.
RESTART_EXIT_CODE = 42


@router.post("/restart")
async def restart_backend():
    """Exit the backend process with code 42, which run.py's
    supervisor recognises as 'restart me'. Used when in-process
    config application isn't safe (e.g. Whisper model swap, where
    CT2 + CUDA can segfault during destruction).

    Returns 200 immediately; the actual exit fires after a 1 s
    delay so the HTTP response has time to flush. Frontend behaviour
    after calling this:
      1. Show a "restarting" overlay
      2. Poll /api/extensions every 1-2 s
      3. Hide the overlay when a poll succeeds (~10-30 s typical;
         longer if Whisper has to download a fresh model)"""
    async def _delayed_exit() -> None:
        await asyncio.sleep(1)
        # os._exit (NOT sys.exit) bypasses Python cleanup hooks,
        # which can hang on background threads or asyncio loops with
        # pending tasks. The supervisor + OS handle file handles and
        # sockets cleanly at process death; we don't need polite
        # tear-down here.
        os._exit(RESTART_EXIT_CODE)

    asyncio.create_task(_delayed_exit())
    return {
        "restarting": True,
        "exit_code": RESTART_EXIT_CODE,
        "delay_seconds": 1,
    }
