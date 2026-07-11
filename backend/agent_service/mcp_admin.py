"""MCP 工具源管理 — data/agent_service/mcp.json + 注册状态缓存。

server 定义: {transport: "stdio"|"url", command|url, enabled}
- stdio: command 字符串 — 单个 .py 路径原样传库 (fastmcp 用 python 起),
         否则 shlex 拆成命令列表
- url:   HTTP/SSE 地址, 库自动识别

生效点: factory.build_chat_agent 调 apply_to_registry(reg) — 每个 server
独立 try/except, 一个挂了不拖垮聊天; 结果进 _status 缓存供 UI 展示。
库内部按 source 缓存长连接, 多会话重复注册零成本。改动对新会话生效。
"""

import json
import os
import re
import shlex
import tempfile
import threading
import time
from pathlib import Path

from .config import DATA_DIR

MCP_JSON = DATA_DIR / "mcp.json"
_lock = threading.Lock()
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,39}$")

# name -> {"ok": bool, "tools": [...], "error": str|None, "checked_at": iso}
_status: dict = {}


def _load_doc() -> dict:
    try:
        doc = json.loads(MCP_JSON.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        doc = {}
    doc.setdefault("version", 1)
    doc.setdefault("servers", {})
    return doc


def _save_doc(doc: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(DATA_DIR), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        os.replace(tmp, MCP_JSON)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _validate(cfg: dict) -> dict:
    transport = cfg.get("transport")
    out = {"transport": transport, "enabled": bool(cfg.get("enabled", True))}
    if transport == "stdio":
        command = (cfg.get("command") or "").strip()
        if not command:
            raise ValueError("stdio server 需要 command (如 'python path/to/server.py')")
        out["command"] = command
    elif transport == "url":
        url = (cfg.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            raise ValueError("url server 需要 http(s):// 地址")
        out["url"] = url
    else:
        raise ValueError(f"transport 需为 stdio 或 url, 收到: {transport!r}")
    return out


def _source_of(cfg: dict):
    """server 定义 → 库 register_mcp_server 的 source 形态。"""
    if cfg["transport"] == "url":
        return cfg["url"]
    command = cfg["command"]
    p = Path(command)
    if command.endswith(".py") and p.is_file():
        return str(p)                       # 单个 py 文件 → 库原生 stdio 形态
    return shlex.split(command)             # 其余 → 命令列表


def list_servers() -> list[dict]:
    out = []
    for name, cfg in _load_doc()["servers"].items():
        out.append({"name": name, **cfg, "status": _status.get(name)})
    return out


def upsert_server(name: str, cfg: dict) -> dict:
    if not _ID_RE.match(name):
        raise ValueError(f"非法 server 名: {name!r} (2-40 位小写字母/数字/_/-)")
    clean = _validate(cfg)
    with _lock:
        doc = _load_doc()
        doc["servers"][name] = clean
        _save_doc(doc)
    _status.pop(name, None)
    return {"name": name, **clean}


def delete_server(name: str) -> None:
    with _lock:
        doc = _load_doc()
        if name not in doc["servers"]:
            raise KeyError(f"未知 MCP server: {name}")
        del doc["servers"][name]
        _save_doc(doc)
    _status.pop(name, None)


REGISTER_TIMEOUT_S = 20   # 单个 server 注册硬超时 (坏地址的连接挂起不能拖住聊天)


def _register_with_timeout(registry, source, prefix, timeout_s):
    """fastmcp 对坏地址可能长时间挂起 — 丢进工作线程, 到点直接放弃
    (孤儿线程为 daemon, 自生自灭; 成功了也只是暖了库的连接缓存)。"""
    from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout
    from agent.tools.mcp import register_mcp_server  # 延迟 — fastmcp 较重
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        fut = pool.submit(register_mcp_server, registry, source, prefix)
        try:
            return fut.result(timeout=timeout_s)
        except FutTimeout:
            raise TimeoutError(f"连接超时 (>{timeout_s}s)")
    finally:
        pool.shutdown(wait=False)


def apply_to_registry(registry) -> None:
    """把全部 enabled server 的工具注册进 registry。逐个隔离失败;
    已知失败的 server 不在每次会话构建时反复重试 (upsert/test 会清状态重来)。"""
    servers = _load_doc()["servers"]
    if not servers:
        return
    for name, cfg in servers.items():
        if not cfg.get("enabled", True):
            continue
        cached = _status.get(name)
        if cached is not None and not cached["ok"]:
            continue  # 上次失败 → 跳过, 免得每个新会话都吃一次超时
        try:
            tools = _register_with_timeout(
                registry, _source_of(cfg), f"{name}_", REGISTER_TIMEOUT_S)
            _status[name] = {"ok": True, "tools": tools, "error": None,
                             "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        except Exception as e:
            _status[name] = {"ok": False, "tools": [], "checked_at":
                             time.strftime("%Y-%m-%dT%H:%M:%S"),
                             "error": f"{type(e).__name__}: {e}"}


def test_server(name: str) -> dict:
    """现场连一次列工具 (独立临时 registry, 不影响会话)。结果写进状态缓存
    — 修好的 server 测一下就能在下个会话恢复挂载。"""
    cfg = _load_doc()["servers"].get(name)
    if cfg is None:
        raise KeyError(f"未知 MCP server: {name}")
    from agent import create_registry
    started = time.time()
    try:
        tools = _register_with_timeout(
            create_registry(), _source_of(cfg), f"{name}_", 30)
    except Exception as e:
        _status[name] = {"ok": False, "tools": [], "checked_at":
                         time.strftime("%Y-%m-%dT%H:%M:%S"),
                         "error": f"{type(e).__name__}: {e}"}
        return {"ok": False, "latency_ms": int((time.time() - started) * 1000),
                "error": f"{type(e).__name__}: {e}"}
    _status[name] = {"ok": True, "tools": tools, "error": None,
                     "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    return {"ok": True, "latency_ms": int((time.time() - started) * 1000),
            "tools": tools}
