"""Extension base class + install context.

Subclasses override `on_install`, optionally `on_start` / `on_stop`,
and expose class-level metadata (`id`, `name`, `description`, `version`).
"""
from typing import Any, Awaitable, Callable, Dict, List, Optional


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

    # If False, the manager retains the instance after `disable` instead
    # of letting it fall out of scope. Use this when an extension owns
    # a native resource whose destructor is unsafe to run mid-process
    # (e.g. faster-whisper / CT2 segfaults on CUDA model GC on Windows).
    # Default True keeps existing extensions GC'd promptly.
    release_on_stop: bool = True

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

    @classmethod
    def get_config_schema(cls) -> List[Dict[str, Any]]:
        """Optional: declarative description of configurable fields, used
        by the frontend to render a settings UI without bespoke code per
        extension. Each entry shape:
            {
              "key": "model_name",          # path into the config dict
              "type": "select" | "slider",  # widget kind
              "label": "Model",             # UI label
              "default": <any>,             # value when not set
              # For type=='select' — at least ONE of these:
              "options": [...],             # flat list of values
              "option_groups": [            # grouped — renders as <optgroup>
                {"label": "...", "options": [...]},
                ...
              ],
              # For type=='slider':
              "min": ..., "max": ..., "step": ...,
              "requires_reload": bool,      # see note below
              "help": "..."                 # tooltip / hint
            }

        `requires_reload`: true means the field can't be applied
        in-process — the frontend persists the value but shows a
        "Restart required" badge until the running runtime value
        catches up. Triggering an actual restart is a separate user
        action via POST /api/system/restart.

        Empty list (the default) means the extension exposes no config
        UI."""
        return []

    async def on_config_change(self, config: Dict[str, Any]) -> None:
        """Called by the manager AFTER the persisted config has been
        merged with the API patch. Receives the FULL merged config, not
        just the patch — so subclasses can trust it as the new ground
        truth without re-reading state.

        Subclasses apply the change: update internal fields for hot
        params (chunk size, beam, thresholds), reload heavy subsystems
        for cold params (model swap). Default: no-op so existing
        extensions don't have to care."""
        return

    async def delete_cache_entry(self, key: str) -> Dict[str, Any]:
        """Optional: remove one of the extension's on-disk cache
        entries. Used by the Settings UI to surface a per-cache delete
        action (e.g. each Whisper model under
        ~/.cache/huggingface/hub/). Subclasses that own no deletable
        caches should leave the default below; the API endpoint maps
        NotImplementedError to a 400 with a clear message.

        Returns a dict describing what was freed; the frontend uses it
        for the toast/feedback ("freed 1.5 GB")."""
        raise NotImplementedError(
            f"Extension '{self.id}' does not expose any deletable caches"
        )
