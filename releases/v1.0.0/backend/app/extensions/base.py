"""Extension base class + install context.

Subclasses override `on_install`, optionally `on_start` / `on_stop`,
and expose class-level metadata (`id`, `name`, `description`, `version`).
"""
from typing import Awaitable, Callable, Optional


class InstallContext:
    """Passed to `Extension.on_install`. Provides async-safe channels
    for the extension to emit log lines and progress ticks, which the
    manager forwards to an HTTP SSE stream so the frontend can render
    live install feedback.
    """

    def __init__(
        self,
        log_cb: Callable[[str], Awaitable[None]],
        progress_cb: Callable[[float], Awaitable[None]],
    ):
        self._log_cb = log_cb
        self._progress_cb = progress_cb

    async def log(self, line: str) -> None:
        await self._log_cb(line)

    async def progress(self, pct: float) -> None:
        """Report 0.0–1.0 completion. Only advisory — not all steps
        have accurate progress (pip is famously opaque)."""
        await self._progress_cb(max(0.0, min(1.0, float(pct))))


class Extension:
    """Base class. Concrete extensions live under `app/extensions/`.

    Lifecycle: install → (enable) → start → stop → (disable) → uninstall.
    Install is idempotent — re-running should no-op if already installed.
    """

    id: str = ""
    name: str = ""
    description: str = ""
    version: str = ""

    async def on_install(self, ctx: InstallContext) -> None:
        """Heavy work: pip install deps, download model weights, etc.
        Raise on failure; the manager will record `error` into state."""
        raise NotImplementedError

    async def on_start(self, app) -> None:
        """Register routes / subscribe to bridges / spin up workers.
        Must be idempotent: may be called on each FastAPI boot."""

    async def on_stop(self) -> None:
        """Release resources. Manager calls this before process
        shutdown and when the user disables the extension."""

    def status(self) -> dict:
        """Optional: return runtime status for the /api/extensions
        response. Keep keys JSON-serializable."""
        return {}
