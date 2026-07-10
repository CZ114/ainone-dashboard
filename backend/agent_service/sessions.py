"""SessionManager — HTTP 级会话生命周期: 内存缓存 + 锁 + TTL 淘汰 + AuditLog 重建。

一个 session = 一个 Agent 实例 + 一个 audit JSONL 文件 (SESSIONS_DIR/<sid>.jsonl)。
进程重启或 TTL 淘汰后, 请求带旧 sessionId 到来 → 从 audit 文件 Agent.resume() 重建。
同一 session 同时只允许一个进行中请求 (entry.lock)。
"""

import threading
import time
import uuid
from datetime import datetime

from agent import AuditLog

from .config import SESSION_TTL_S, SESSIONS_DIR
from .factory import build_chat_agent


class SessionEntry:
    def __init__(self, agent):
        self.agent = agent
        self.lock = threading.Lock()
        self.last_active = time.time()


class SessionManager:
    def __init__(self):
        self._sessions = {}
        self._lock = threading.Lock()

    @staticmethod
    def _audit_path(session_id):
        return SESSIONS_DIR / f"{session_id}.jsonl"

    @staticmethod
    def _new_session_id():
        return datetime.now().strftime("%Y%m%dT%H%M%S") + "_" + uuid.uuid4().hex[:6]

    def get_or_create(self, session_id=None, agent_id=None, create_if_missing=False):
        """返回 (session_id, entry)。

        - session_id=None → 新会话
        - 在内存 → 直接用
        - 不在内存但 audit 文件存在 → 重建 + resume
        - 都没有 → create_if_missing 时忽略给定 id 新建 (compat: 前端新会话会带
          "new-session-<ts>" 临时 id, 等 init 回真实 id 再替换); 否则 KeyError (→404)
        """
        with self._lock:
            self._evict_stale_locked()

            if session_id and session_id in self._sessions:
                entry = self._sessions[session_id]
                entry.last_active = time.time()
                return session_id, entry

            if session_id and not self._audit_path(session_id).exists():
                if create_if_missing:
                    session_id = None
                else:
                    raise KeyError(f"未知 session: {session_id}")

            if session_id:
                agent = build_chat_agent(session_id, agent_id)
                agent.resume(session_id)
            else:
                session_id = self._new_session_id()
                agent = build_chat_agent(session_id, agent_id)

            entry = SessionEntry(agent)
            self._sessions[session_id] = entry
            return session_id, entry

    def peek(self, session_id):
        with self._lock:
            return self._sessions.get(session_id)

    def _evict_stale_locked(self):
        now = time.time()
        for sid in list(self._sessions):
            entry = self._sessions[sid]
            # 进行中的请求持有 lock, 不淘汰
            if now - entry.last_active > SESSION_TTL_S and entry.lock.acquire(blocking=False):
                entry.lock.release()
                del self._sessions[sid]

    # ─── 只读查询 (直接走磁盘, 不触碰内存实例) ──────────────────────

    def list_sessions(self):
        """按最近更新排序的 [{sessionId, updatedAt}]。"""
        out = []
        for p in SESSIONS_DIR.glob("*.jsonl"):
            out.append({
                "sessionId": p.stem,
                "updatedAt": datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
            })
        out.sort(key=lambda s: s["updatedAt"], reverse=True)
        return out

    def read_messages(self, session_id):
        """干净对话历史 (含 _ts)。session 不存在 → KeyError。"""
        path = self._audit_path(session_id)
        if not path.exists():
            raise KeyError(f"未知 session: {session_id}")
        audit = AuditLog(path, session_id=session_id, mode="both")
        return audit.read_session(session_id)

    def reset(self, session_id, scope="messages"):
        entry = self.peek(session_id)
        if entry is None:
            raise KeyError(f"session 不在内存中 (已淘汰或不存在): {session_id}")
        with entry.lock:
            entry.agent.reset(scope)
        return True


def repair_history(agent):
    """abort 中断后修补历史: 末尾 assistant 带 tool_calls 却缺 tool 回应时补上,
    否则下一轮发给 OpenAI 兼容 API 会 400 (tool_calls 必须跟 tool 消息)。"""
    msgs = agent.messages
    i = len(msgs) - 1
    while i >= 0 and msgs[i].get("role") == "tool":
        i -= 1
    if i < 0 or msgs[i].get("role") != "assistant" or not msgs[i].get("tool_calls"):
        return
    answered = {m.get("tool_call_id") for m in msgs[i + 1:]}
    for tc in msgs[i]["tool_calls"]:
        if tc["id"] not in answered:
            msgs.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": '{"error": "aborted by user"}',
                "_ts": datetime.now().isoformat(),
            })
