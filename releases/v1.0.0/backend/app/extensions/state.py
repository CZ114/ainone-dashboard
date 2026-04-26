"""Extension state persistence.

Single JSON file at BASE_DIR / extensions_state.json:

    {
      "whisper-local": {
        "installed": true,
        "enabled": true,
        "installed_at": "2026-04-24T10:30:00",
        "version": "0.1.0",
        "config": {"model": "base"}
      }
    }

Writes go through `update_extension_state` (merge + atomic-ish replace).
Concurrent writers are rare (single backend process) so we don't lock.
"""
import json
from pathlib import Path
from typing import Dict, Any

from app.config import BASE_DIR

STATE_FILE: Path = BASE_DIR / "extensions_state.json"


def load_state() -> Dict[str, Dict[str, Any]]:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8")) or {}
    except Exception as e:
        print(f"[Extensions] Failed to read state file: {e}")
        return {}


def save_state(state: Dict[str, Dict[str, Any]]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Write to a temp neighbour then replace — avoids a partially-written
    # file if the process is killed mid-save.
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(state, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    tmp.replace(STATE_FILE)


def get_extension_state(ext_id: str) -> Dict[str, Any]:
    return load_state().get(ext_id, {})


def update_extension_state(ext_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    state = load_state()
    current = state.get(ext_id, {})
    current.update(patch)
    state[ext_id] = current
    save_state(state)
    return current


def delete_extension_state(ext_id: str) -> None:
    state = load_state()
    if ext_id in state:
        del state[ext_id]
        save_state(state)
