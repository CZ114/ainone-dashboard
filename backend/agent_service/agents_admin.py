"""multi-agent 配置管理 — 读写 agents.json (与日记系统共享同一文件/schema)。

文件结构 (对齐 agent_gateway/diary/agentStore.ts):
    {"version": 1, "secrets": {...}, "agents": {id: AgentConfig}}

AgentConfig 字段 (全部可选, 缺省回落到运行时默认配置):
    name / description / provider / model / system_prompt
    sampling: {temperature, max_tokens}
    retrieval: {collection, top_k} | null      ← RAG 挂载
    env: {KEY: "${SECRET_NAME}"}               ← secrets 引用 (值不在此文件明文出现时)

注意: secrets 块可能含明文 key — 本模块任何返回值都不携带 secrets。
"""

import json
import os
import re
import tempfile
import threading

from .config import AGENTS_JSON

_lock = threading.Lock()
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,39}$")
RESERVED_IDS = {"default"}

_AGENT_FIELDS = {
    "name", "description", "provider", "model", "system_prompt",
    "sampling", "retrieval", "env",
}


def _load_doc() -> dict:
    try:
        doc = json.loads(AGENTS_JSON.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        doc = {}
    doc.setdefault("version", 1)
    doc.setdefault("secrets", {})
    doc.setdefault("agents", {})
    return doc


def _save_doc(doc: dict) -> None:
    AGENTS_JSON.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(AGENTS_JSON.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        os.replace(tmp, AGENTS_JSON)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _sanitize(cfg: dict) -> dict:
    out = {k: v for k, v in cfg.items() if k in _AGENT_FIELDS and v is not None}
    if "sampling" in out and not isinstance(out["sampling"], dict):
        del out["sampling"]
    retrieval = out.get("retrieval")
    if retrieval is not None:
        if not isinstance(retrieval, dict) or not retrieval.get("collection"):
            out.pop("retrieval", None)
        else:
            out["retrieval"] = {
                "collection": str(retrieval["collection"]),
                "top_k": int(retrieval.get("top_k", 5)),
            }
    if not isinstance(out.get("env"), dict):
        # 网关的 diary UI 假定 env 恒存在 (agentStore.ts) — 总是写空 dict 兜底
        out["env"] = {}
    return out


def list_agents(runtime_cfg: dict) -> list[dict]:
    """全部 agent 定义。首位是合成的 default (来自运行时配置, 只读),
    其后是 agents.json 里的自定义定义。"""
    out = [{
        "id": "default",
        "builtin": True,
        "name": "Default",
        "description": "服务默认 agent — 跟随设置页的模型路由配置 / Built-in default agent — follows the model-routing settings",
        "provider": runtime_cfg["provider"],
        "model": runtime_cfg["model"],
        "sampling": {"temperature": runtime_cfg["temperature"]},
        "retrieval": None,
    }]
    for agent_id, cfg in _load_doc()["agents"].items():
        entry = {"id": agent_id, "builtin": False, "retrieval": None, **_sanitize(dict(cfg))}
        out.append(entry)
    return out


def upsert_agent(agent_id: str, cfg: dict) -> dict:
    if agent_id in RESERVED_IDS:
        raise ValueError(f"'{agent_id}' 是内置 agent, 不可覆盖 — 请到模型路由设置里改默认配置"
                         f"（'{agent_id}' is a built-in agent and cannot be overridden — "
                         f"change the defaults in the model-routing settings）")
    if not _ID_RE.match(agent_id):
        raise ValueError(f"非法 agent id: {agent_id!r} (2-40 位小写字母/数字/_/-, 字母数字开头)"
                         f"（Invalid agent id: 2-40 chars of lowercase letters/digits/_/-, "
                         f"starting with a letter or digit）")
    clean = _sanitize(cfg)
    with _lock:
        doc = _load_doc()
        doc["agents"][agent_id] = clean
        _save_doc(doc)
    return {"id": agent_id, "builtin": False, **clean}


def delete_agent(agent_id: str) -> None:
    if agent_id in RESERVED_IDS:
        raise ValueError(f"内置 agent 不可删除: {agent_id}（Built-in agent cannot be deleted）")
    with _lock:
        doc = _load_doc()
        if agent_id not in doc["agents"]:
            raise KeyError(f"未知 agent: {agent_id}（Unknown agent）")
        del doc["agents"][agent_id]
        _save_doc(doc)
