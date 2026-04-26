"""Extension manager singleton.

Owns:
  - Running `Extension` instances keyed by id
  - In-flight `InstallJob`s (for SSE progress streaming)
  - Startup / shutdown orchestration driven by FastAPI lifespan

The manager is a pure in-process object; no threads, no subprocesses
(individual extensions may spawn those themselves during on_install).
"""
import asyncio
import datetime
from typing import Dict, List, Optional

from fastapi import FastAPI

from app.extensions.base import Extension, InstallContext
from app.extensions.registry import get_extension_class, list_registry
from app.extensions.state import (
    load_state,
    update_extension_state,
    delete_extension_state,
)


class InstallJob:
    """Async queue-backed install job. SSE consumers read `queue`;
    `done` flips when `on_install` returns (success or failure)."""

    def __init__(self, ext_id: str):
        self.ext_id = ext_id
        self.queue: asyncio.Queue = asyncio.Queue()
        self.done: bool = False
        self.success: bool = False
        self.error: Optional[str] = None
        self.started_at = datetime.datetime.now()

    async def push_log(self, line: str) -> None:
        await self.queue.put({"kind": "log", "line": line})

    async def push_progress(self, pct: float) -> None:
        await self.queue.put({"kind": "progress", "pct": pct})

    def mark_done(self, success: bool, error: Optional[str] = None) -> None:
        self.done = True
        self.success = success
        self.error = error
        # Sentinel — wakes any consumer blocked on queue.get()
        self.queue.put_nowait(
            {"kind": "done", "success": success, "error": error}
        )


class ExtensionManager:
    def __init__(self):
        self._instances: Dict[str, Extension] = {}
        self._install_jobs: Dict[str, InstallJob] = {}
        self._app: Optional[FastAPI] = None

    # -------- Lifespan hooks ------------------------------------------------

    async def init_from_state(self, app: FastAPI) -> None:
        """FastAPI lifespan startup: start all enabled extensions."""
        self._app = app
        state = load_state()
        for ext_id, info in state.items():
            if not (info.get("installed") and info.get("enabled")):
                continue
            cls = get_extension_class(ext_id)
            if cls is None:
                print(f"[Extensions] Skipping unknown id in state: {ext_id}")
                continue
            try:
                inst = cls()
                await inst.on_start(app)
                self._instances[ext_id] = inst
                print(f"[Extensions] Started: {ext_id}")
            except Exception as e:
                print(f"[Extensions] Failed to start {ext_id}: {e}")

    async def shutdown(self) -> None:
        for ext_id, inst in list(self._instances.items()):
            try:
                await inst.on_stop()
            except Exception as e:
                print(f"[Extensions] Stop error {ext_id}: {e}")
        self._instances.clear()

    # -------- Status snapshots ---------------------------------------------

    def get_instance(self, ext_id: str) -> Optional[Extension]:
        return self._instances.get(ext_id)

    def get_status_dict(self, ext_id: str) -> Dict:
        cls = get_extension_class(ext_id)
        if cls is None:
            return {}
        state = load_state()
        info = state.get(ext_id, {})
        job = self._install_jobs.get(ext_id)
        out = {
            "id": cls.id,
            "name": cls.name,
            "description": cls.description,
            "version": cls.version,
            "installed": bool(info.get("installed")),
            "enabled": bool(info.get("enabled")),
            "installing": bool(job and not job.done),
            "installed_at": info.get("installed_at"),
            "config": info.get("config", {}),
            "last_error": info.get("last_error"),
        }
        inst = self._instances.get(ext_id)
        if inst:
            try:
                out["runtime"] = inst.status()
            except Exception as e:
                out["runtime"] = {"status_error": str(e)}
        return out

    def list_all_status(self) -> List[Dict]:
        return [self.get_status_dict(cls.id) for cls in list_registry()]

    def get_install_job(self, ext_id: str) -> Optional[InstallJob]:
        return self._install_jobs.get(ext_id)

    # -------- Operations ---------------------------------------------------

    async def install(self, ext_id: str) -> InstallJob:
        cls = get_extension_class(ext_id)
        if cls is None:
            raise ValueError(f"Unknown extension: {ext_id}")

        existing = self._install_jobs.get(ext_id)
        if existing and not existing.done:
            # Concurrent install: just return the in-flight job so the
            # new caller's SSE stream can piggyback on the same queue.
            return existing

        job = InstallJob(ext_id)
        self._install_jobs[ext_id] = job
        inst = cls()
        # Fire-and-forget; caller consumes progress via `job.queue`.
        asyncio.create_task(self._run_install(inst, job))
        return job

    async def _run_install(self, inst: Extension, job: InstallJob) -> None:
        ctx = InstallContext(
            log_cb=job.push_log,
            progress_cb=job.push_progress,
        )
        # Clear any previous failure the moment we start so a successful
        # retry doesn't leave stale "Last error: ..." breadcrumbs on the
        # card. The success branch below still writes `last_error: None`
        # but this covers the case where the job fails AGAIN later.
        update_extension_state(inst.id, {"last_error": None})
        try:
            await job.push_log(f"Starting install: {inst.id}")
            await inst.on_install(ctx)
            update_extension_state(inst.id, {
                "installed": True,
                "enabled": True,
                "installed_at": datetime.datetime.now().isoformat(),
                "version": inst.version,
                "last_error": None,
            })
            # Start immediately so the user doesn't need a second click.
            if self._app is not None:
                await inst.on_start(self._app)
                self._instances[inst.id] = inst
            await job.push_log("Install complete")
            job.mark_done(success=True)
        except Exception as e:
            err_str = str(e) or repr(e)
            update_extension_state(inst.id, {"last_error": err_str})
            await job.push_log(f"Install failed: {err_str}")
            job.mark_done(success=False, error=err_str)

    async def enable(self, ext_id: str) -> None:
        cls = get_extension_class(ext_id)
        if cls is None:
            raise ValueError(f"Unknown extension: {ext_id}")
        info = load_state().get(ext_id, {})
        if not info.get("installed"):
            raise ValueError("Extension not installed")
        if self._instances.get(ext_id) is not None:
            update_extension_state(ext_id, {"enabled": True})
            return
        update_extension_state(ext_id, {"enabled": True})
        inst = cls()
        if self._app is not None:
            await inst.on_start(self._app)
        self._instances[ext_id] = inst

    async def disable(self, ext_id: str) -> None:
        update_extension_state(ext_id, {"enabled": False})
        inst = self._instances.pop(ext_id, None)
        if inst is not None:
            try:
                await inst.on_stop()
            except Exception as e:
                print(f"[Extensions] Stop during disable failed: {e}")

    async def uninstall(self, ext_id: str) -> None:
        """Mark as not installed. We deliberately do NOT `pip uninstall`
        — pip's package cache stays so reinstall is fast, and we avoid
        potentially breaking other things in shared site-packages."""
        await self.disable(ext_id)
        update_extension_state(ext_id, {"installed": False, "enabled": False})


# -------- Singleton accessor ----------------------------------------------

_manager: Optional[ExtensionManager] = None


def get_manager() -> ExtensionManager:
    global _manager
    if _manager is None:
        _manager = ExtensionManager()
    return _manager
