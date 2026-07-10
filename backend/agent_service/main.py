"""agent_service — 自研 Agent 的 HTTP 服务 (FastAPI, :8100)。

端点分两组:
- /api/agent/*  : SOD 03 的中立协议 (oneshot 给日记网关, chat 给未来新前端)
- /api/compat/* : 原前端 claude_json 兼容协议 (agent_gateway 纯透传给 React chat 页)

同步 Agent → 异步 HTTP 的桥接: 每个 chat 请求起一个 worker 线程跑 agent.stream(),
事件经 queue 流出; 权限审批经 PermissionBroker 阻塞工具线程等前端 POST;
abort 置 Event, worker 在事件边界退出并修补历史。
"""

import queue
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from .agent_tools import build_registry
from .bridge import AbortRegistry, PermissionBroker
from .config import DEFAULT_MODEL, DEFAULT_PROVIDER, PERMISSION_TIMEOUT_S, REPO_ROOT
from .factory import build_oneshot_agent
from .sessions import SessionManager, repair_history
from .wire import new_stream_ctx, serialize

app = FastAPI(title="agent_service", version="0.1.0")

broker = PermissionBroker()
aborts = AbortRegistry()
manager = SessionManager()


# ─── 请求模型 ────────────────────────────────────────────────────────

class ChatBody(BaseModel):
    message: str
    requestId: str | None = None
    sessionId: str | None = None
    agentId: str | None = None


class PermissionBody(BaseModel):
    id: str
    decision: str | dict     # neutral: "allow"/"deny"; compat: {behavior, message?}
    message: str | None = None


class OneshotBody(BaseModel):
    message: str
    agentId: str | None = None
    systemPrompt: str | None = None
    lang: str | None = None


class ResetBody(BaseModel):
    scope: str = "messages"


# ─── chat 流核心 (neutral 与 compat 共用) ────────────────────────────

def _chat_response(body: ChatBody, fmt: str) -> StreamingResponse:
    try:
        # compat: 前端新会话带临时 id ("new-session-*"), 未知 id 视为新建
        session_id, entry = manager.get_or_create(
            body.sessionId, body.agentId, create_if_missing=(fmt == "compat"))
    except KeyError as e:
        raise HTTPException(404, str(e))
    except NotImplementedError as e:
        raise HTTPException(501, str(e))

    if not entry.lock.acquire(blocking=False):
        raise HTTPException(409, f"session {session_id} 有进行中的请求")

    request_id = body.requestId or uuid.uuid4().hex[:12]
    abort_ev = aborts.register(request_id)
    q: queue.Queue = queue.Queue()
    agent = entry.agent
    worker_started = False

    def approval_cb(name, args, tcid):
        p = broker.create(request_id, name, args, tcid)
        q.put(("permission_request",
               {"id": p.id, "toolName": name, "input": args, "toolUseId": tcid}))
        return broker.wait(p, PERMISSION_TIMEOUT_S)

    agent.approval_callback = approval_cb  # entry.lock 保证同一时刻只有一个请求在写

    def worker():
        try:
            for kind, payload in agent.stream(body.message):
                if abort_ev.is_set():
                    repair_history(agent)
                    q.put(("aborted", None))
                    return
                q.put((kind, payload))
        except Exception as e:
            q.put(("error", f"{type(e).__name__}: {e}"))
        finally:
            entry.last_active = time.time()
            entry.lock.release()
            aborts.unregister(request_id)
            q.put(("__end__", None))

    def gen():
        nonlocal worker_started
        ctx = new_stream_ctx(
            session_id, agent.client.model,
            [t["name"] for t in agent.registry.list_tools()],
        )
        try:
            yield from serialize("session", None, ctx, fmt)
            threading.Thread(target=worker, daemon=True, name=f"chat-{request_id}").start()
            worker_started = True
            while True:
                try:
                    kind, payload = q.get(timeout=0.5)
                except queue.Empty:
                    # worker 卡在 LLM 调用里收不到事件时, abort 也要能即时回给前端
                    if abort_ev.is_set():
                        yield from serialize("aborted", None, ctx, fmt)
                        return
                    continue
                if kind == "__end__":
                    return
                yield from serialize(kind, payload, ctx, fmt)
                if kind == "aborted":
                    return
        finally:
            if not worker_started:
                entry.lock.release()
                aborts.unregister(request_id)
            # 无论流怎么断, 挂起的审批都解除, 防工具线程滞留到超时
            broker.deny_all_for_request(request_id, reason="连接已断开或请求中止")

    return StreamingResponse(gen(), media_type="application/x-ndjson")


def _resolve_permission(body: PermissionBody):
    if isinstance(body.decision, dict):   # compat: {behavior: "allow"|"deny", message?}
        approved = body.decision.get("behavior") == "allow"
        reason = body.decision.get("message") or ""
    else:                                 # neutral: "allow"|"deny"
        approved = body.decision == "allow"
        reason = body.message or ""
    ok = broker.resolve(body.id, approved, reason)
    return {"ok": ok}


# ─── neutral 端点 (/api/agent/*) ─────────────────────────────────────

@app.post("/api/agent/chat")
def agent_chat(body: ChatBody):
    return _chat_response(body, "neutral")


@app.post("/api/agent/permission")
def agent_permission(body: PermissionBody):
    return _resolve_permission(body)


@app.post("/api/agent/abort/{request_id}")
def agent_abort(request_id: str):
    ok = aborts.abort(request_id)
    broker.deny_all_for_request(request_id)
    return {"ok": ok}


@app.post("/api/agent/oneshot")
def agent_oneshot(body: OneshotBody):
    try:
        agent = build_oneshot_agent(body.agentId, body.systemPrompt)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except NotImplementedError as e:
        raise HTTPException(501, str(e))
    started = time.time()
    text = agent.send(body.message)
    return {
        "text": text,
        "model": agent.client.model,
        "provider": agent.client.provider,
        "duration_ms": int((time.time() - started) * 1000),
    }


@app.get("/api/agent/sessions")
def agent_sessions():
    return {"sessions": manager.list_sessions()}


@app.get("/api/agent/sessions/{session_id}/messages")
def agent_session_messages(session_id: str):
    try:
        return {"messages": manager.read_messages(session_id)}
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.post("/api/agent/sessions/{session_id}/reset")
def agent_session_reset(session_id: str, body: ResetBody):
    try:
        manager.reset(session_id, body.scope)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


@app.get("/api/agent/health")
def agent_health():
    return {
        "ok": True,
        "provider": DEFAULT_PROVIDER,
        "model": DEFAULT_MODEL,
        "tools": [t["name"] for t in build_registry().list_tools()],
    }


# ─── RAG 预留 (SOD 04, 统一 501) ─────────────────────────────────────

_RAG_501 = "RAG 系统尚未接入 — 预留接口, 见 docs/agent-migration-sod/04-reserved-interfaces.md"


@app.post("/api/agent/rag/ingest")
def rag_ingest():
    return JSONResponse({"error": _RAG_501}, status_code=501)


@app.get("/api/agent/rag/collections")
def rag_collections():
    return JSONResponse({"error": _RAG_501}, status_code=501)


@app.delete("/api/agent/rag/collections/{name}")
def rag_delete(name: str):
    return JSONResponse({"error": _RAG_501}, status_code=501)


# ─── compat 端点 (/api/compat/*, 供 agent_gateway 透传) ──────────────

@app.post("/api/compat/chat")
def compat_chat(body: ChatBody):
    return _chat_response(body, "compat")


@app.post("/api/compat/chat/permission")
def compat_permission(body: PermissionBody):
    return _resolve_permission(body)


@app.post("/api/compat/abort/{request_id}")
def compat_abort(request_id: str):
    return agent_abort(request_id)


def _first_content(messages, role):
    for m in messages:
        if m.get("role") == role and isinstance(m.get("content"), str) and m["content"]:
            return m["content"]
    return ""


@app.get("/api/compat/sessions")
def compat_sessions():
    """前端 sidebar 的 SessionSummary shape。"""
    out = []
    for meta in manager.list_sessions():
        sid = meta["sessionId"]
        try:
            msgs = manager.read_messages(sid)
        except (KeyError, ValueError):
            continue
        chat_msgs = [m for m in msgs if m.get("role") in ("user", "assistant")]
        texts = [m for m in chat_msgs if isinstance(m.get("content"), str) and m["content"]]
        out.append({
            "sessionId": sid,
            "cwd": str(REPO_ROOT),
            "firstMessage": _first_content(msgs, "user"),
            "lastMessage": texts[-1]["content"] if texts else "",
            "firstAssistantMessage": _first_content(msgs, "assistant"),
            "messageCount": len(chat_msgs),
            "updatedAt": meta["updatedAt"],
        })
    return {"sessions": out}


@app.get("/api/compat/sessions/{session_id}/messages")
def compat_session_messages(session_id: str):
    try:
        msgs = manager.read_messages(session_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    out = [
        {
            "type": "message",
            "role": m["role"],
            "content": m["content"],
            "timestamp": m.get("_ts", ""),
        }
        for m in msgs
        if m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str) and m["content"]
    ]
    return {"messages": out, "cwd": str(REPO_ROOT)}
