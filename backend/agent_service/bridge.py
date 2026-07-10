"""跨请求桥接原语 — 权限审批 (PermissionBroker) 与中止 (AbortRegistry)。

agent 库的 approval_callback 是同步阻塞函数 (executor.py dispatch_one 内调用),
这里用 threading.Event 把它桥接到 HTTP: 工具线程阻塞等待, 前端 POST 决定后唤醒。
与原版 Hono chat.ts 用 Promise 挂起 canUseTool 是同一模式, 换成线程原语。
"""

import threading
import uuid


class PendingPermission:
    def __init__(self, request_id, tool_name, arguments, tool_call_id):
        self.id = uuid.uuid4().hex[:12]
        self.request_id = request_id
        self.tool_name = tool_name
        self.arguments = arguments
        self.tool_call_id = tool_call_id
        self.event = threading.Event()
        self.decision = None  # {"approved": bool, "reason": str}


class PermissionBroker:
    def __init__(self):
        self._pending = {}
        self._lock = threading.Lock()

    def create(self, request_id, tool_name, arguments, tool_call_id):
        p = PendingPermission(request_id, tool_name, arguments, tool_call_id)
        with self._lock:
            self._pending[p.id] = p
        return p

    def resolve(self, perm_id, approved, reason=""):
        """前端决定到达。返回 False 表示 id 不存在/已处理过。"""
        with self._lock:
            p = self._pending.pop(perm_id, None)
        if p is None:
            return False
        p.decision = {"approved": approved, "reason": reason}
        p.event.set()
        return True

    def wait(self, pending, timeout):
        """工具线程阻塞至前端决定或超时。超时按拒绝处理 (与 Hono 行为一致)。"""
        if not pending.event.wait(timeout):
            with self._lock:
                self._pending.pop(pending.id, None)
            return {"approved": False, "reason": f"审批超时 ({timeout}s), 默认拒绝"}
        return pending.decision

    def deny_all_for_request(self, request_id, reason="请求已中止"):
        """abort 时解除该请求下所有挂起审批, 防止工具线程永久阻塞。"""
        with self._lock:
            targets = [p for p in self._pending.values() if p.request_id == request_id]
            for p in targets:
                self._pending.pop(p.id, None)
        for p in targets:
            p.decision = {"approved": False, "reason": reason}
            p.event.set()


class AbortRegistry:
    def __init__(self):
        self._flags = {}
        self._lock = threading.Lock()

    def register(self, request_id):
        ev = threading.Event()
        with self._lock:
            self._flags[request_id] = ev
        return ev

    def abort(self, request_id):
        with self._lock:
            ev = self._flags.get(request_id)
        if ev is None:
            return False
        ev.set()
        return True

    def unregister(self, request_id):
        with self._lock:
            self._flags.pop(request_id, None)
