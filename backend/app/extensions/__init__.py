"""Pluggable extension system.

An `Extension` is a self-contained unit with install / enable / disable /
uninstall hooks. Each extension declares its own Python package
dependencies and may register FastAPI routes, WebSocket handlers, or
subscribe to in-process events (e.g. AudioBridge frames) on start.

State is persisted to `backend/extensions_state.json` so installs and
enable/disable flags survive restarts. On FastAPI `lifespan` startup,
`ExtensionManager.init_from_state` brings enabled extensions back up.
"""
from app.extensions.base import Extension, InstallContext
from app.extensions.manager import get_manager, ExtensionManager

__all__ = ["Extension", "InstallContext", "get_manager", "ExtensionManager"]
