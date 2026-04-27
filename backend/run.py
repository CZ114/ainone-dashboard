#!/usr/bin/env python3
"""
AinOne Dashboard Backend — entry point + supervisor.

Runs uvicorn as a child process. When the child exits with
RESTART_EXIT_CODE (42), the supervisor respawns it; any other exit
code terminates the supervisor too. This is how the "apply Whisper
model change" UX works:
  1. User clicks Apply → ConfigPanel POSTs the new config
  2. User clicks "Restart now" → frontend POSTs /api/system/restart
  3. Backend responds 200, then triggers os._exit(42) ~1 s later
  4. This script sees the 42 and respawns uvicorn with the same args
  5. The fresh process boots with the persisted (now-new) config

Why supervisor + subprocess instead of os.execv:
  - Windows's os.execv is actually _spawnv internally; the new
    process detaches stdout/stderr from the original terminal,
    so logs vanish.
  - subprocess.Popen inherits parent file handles cleanly on both
    Unix and Windows.
  - The supervisor stays under 50 lines and is stateless, so the
    "restart" path has effectively zero residual state to leak.
"""
import os
import subprocess
import sys
import time

# Must match the value in app.api.system. The two files agree by
# convention only — extracting it to a shared config is overkill for
# a single magic number.
RESTART_EXIT_CODE = 42


def _spawn_server() -> int:
    """Spawn the uvicorn child. Blocks until the child exits and
    returns its exit code.

    Why `python -m uvicorn` instead of importing uvicorn here: the
    supervisor stays minimal and survives whatever the child does
    to its own state (signal handlers, asyncio loop policy, etc).
    Restarts are reliable because we never share interpreter state."""
    here = os.path.dirname(os.path.abspath(__file__))
    cmd = [
        sys.executable, "-m", "uvicorn",
        "app.main:app",
        "--host", "0.0.0.0",
        "--port", "8080",
        "--log-level", "info",
    ]
    proc = subprocess.Popen(cmd, cwd=here)
    try:
        return proc.wait()
    except KeyboardInterrupt:
        # Ctrl+C in the supervisor's terminal — forward to child,
        # wait for graceful shutdown, return non-restart code so we
        # exit cleanly instead of looping.
        proc.terminate()
        try:
            return proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            return proc.wait()


def main() -> None:
    print("=" * 50)
    print("AinOne Dashboard - Backend Supervisor")
    print("=" * 50)
    print()

    while True:
        code = _spawn_server()
        if code == RESTART_EXIT_CODE:
            print(
                f"\n[supervisor] backend requested restart "
                f"(exit code {code}); respawning in 1 s..."
            )
            time.sleep(1)
            continue
        print(
            f"\n[supervisor] backend exited with code {code}; "
            f"supervisor exiting too"
        )
        sys.exit(code)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
