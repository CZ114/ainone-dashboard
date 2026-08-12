"""SessionManager — HTTP 级会话生命周期: 内存缓存 + 锁 + TTL 淘汰 + AuditLog 重建。

一个 session = 一个 Agent 实例 + 一个 audit JSONL 文件 (SESSIONS_DIR/<sid>.jsonl)。
进程重启或 TTL 淘汰后, 请求带旧 sessionId 到来 → 从 audit 文件 Agent.resume() 重建。
同一 session 同时只允许一个进行中请求 (entry.lock)。
"""

import json
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
        # M3 归属: session_id → owner (患者编号 / staff 用户名)。side-car
        # JSON, 因为 session 本体是 audit .jsonl (消息历史), 不宜塞元数据。
        self._owners = self._load_owners()
        # M3 for-whom: session_id → patient_id (服务对象)。跟 owner (发起人) 分开 —
        # 医生为患者开的会话 owner=医生用户名, patient_id=患者编号。另一个 side-car。
        self._patients = self._load_patients()

    _OWNERS_PATH = SESSIONS_DIR.parent / "session_owners.json"
    _PATIENTS_PATH = SESSIONS_DIR.parent / "session_patients.json"

    @classmethod
    def _load_owners(cls):
        try:
            return json.loads(cls._OWNERS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_owners(self):
        try:
            self._OWNERS_PATH.write_text(
                json.dumps(self._owners, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def owner_of(self, session_id):
        return self._owners.get(session_id)

    @classmethod
    def _load_patients(cls):
        try:
            return json.loads(cls._PATIENTS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_patients(self):
        try:
            self._PATIENTS_PATH.write_text(
                json.dumps(self._patients, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def patient_of(self, session_id):
        return self._patients.get(session_id)

    @staticmethod
    def _audit_path(session_id):
        return SESSIONS_DIR / f"{session_id}.jsonl"

    @staticmethod
    def _new_session_id():
        return datetime.now().strftime("%Y%m%dT%H%M%S") + "_" + uuid.uuid4().hex[:6]

    def get_or_create(self, session_id=None, agent_id=None, create_if_missing=False,
                      owner=None, patient_id=None):
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
            # 首次见到该 session 且调用方带了 owner → 记归属 (幂等)。
            if owner and session_id not in self._owners:
                self._owners[session_id] = owner
                self._save_owners()
            # for-whom 患者 (幂等, 首次记)。医生切换"当前患者"后新开的会话才带新值。
            if patient_id and session_id not in self._patients:
                self._patients[session_id] = patient_id
                self._save_patients()
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

    def list_sessions(self, owner=None):
        """按最近更新排序的 [{sessionId, updatedAt, owner}]。

        owner 给定 (患者) → 只返回该 owner 名下的会话; owner=None (医生/
        开发者) → 全部。归属未知的旧会话 (无 owner 记录) 只对 owner=None
        可见 — 患者严格只见自己的, 不会漏看到他人或迁移前的孤立会话。
        """
        out = []
        for p in SESSIONS_DIR.glob("*.jsonl"):
            sid = p.stem
            sid_owner = self._owners.get(sid)
            if owner is not None and sid_owner != owner:
                continue
            out.append({
                "sessionId": sid,
                "updatedAt": datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
                "owner": sid_owner,
                "patientId": self._patients.get(sid),
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
