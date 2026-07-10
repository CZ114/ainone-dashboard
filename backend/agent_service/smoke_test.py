"""agent_service 冒烟测试 — 对 :8100 实调 (需要服务已启动 + venice key 可用)。

用法: .venv\\Scripts\\python.exe -m agent_service.smoke_test
覆盖: health / oneshot / neutral chat 流(含工具) / compat chat 流 / 权限桥 / sessions / 续聊 / rag 501
"""

import json
import sys
import threading

import httpx

BASE = "http://127.0.0.1:8100"
PASS, FAIL = "  [PASS]", "  [FAIL]"
failures = []


def check(label, cond, detail=""):
    print(f"{PASS if cond else FAIL} {label}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(label)


def stream_chat(path, body, on_event=None):
    """POST NDJSON 流, 返回事件列表。on_event(evt) 可做旁路动作 (如批准权限)。"""
    events = []
    with httpx.Client(timeout=180) as c:
        with c.stream("POST", f"{BASE}{path}", json=body) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if not line.strip():
                    continue
                evt = json.loads(line)
                events.append(evt)
                if on_event:
                    on_event(evt)
    return events


def main():
    # 1. health
    r = httpx.get(f"{BASE}/api/agent/health", timeout=10)
    h = r.json()
    check("health", r.status_code == 200 and h["ok"],
          f"{h['provider']}/{h['model']} tools={h['tools']}")

    # 2. oneshot (日记链路的依赖)
    r = httpx.post(f"{BASE}/api/agent/oneshot", timeout=120, json={
        "message": "用一句话介绍你自己。",
        "systemPrompt": "你是测试助手, 回答不超过30字。",
    })
    d = r.json()
    check("oneshot", r.status_code == 200 and bool(d.get("text")),
          f"{d.get('duration_ms')}ms: {str(d.get('text'))[:60]}")

    # 3. neutral chat — 强制走工具 (read_file)
    events = stream_chat("/api/agent/chat", {
        "message": "用 read_file 工具读仓库根目录的 README.md 前几行, 然后告诉我这个项目是做什么的, 一句话。",
        "requestId": "smoke-neutral-1",
    })
    kinds = [e["type"] for e in events]
    sid = next((e["sessionId"] for e in events if e["type"] == "session"), None)
    check("neutral: session 事件", sid is not None, f"sid={sid}")
    check("neutral: 有 delta", "delta" in kinds)
    check("neutral: 走了 tool_call", "tool_call" in kinds,
          str([e.get("name") for e in events if e["type"] == "tool_call"]))
    check("neutral: 有 tool_result 且 ok", any(
        e["type"] == "tool_result" and e.get("ok") for e in events))
    check("neutral: done 收尾", kinds[-1] == "done")

    # 4. 续聊同一 session (resume 路径走内存)
    events2 = stream_chat("/api/agent/chat", {
        "message": "很好, 再用一句话总结你刚才读到了什么。",
        "requestId": "smoke-neutral-2",
        "sessionId": sid,
    })
    final_text = "".join(e.get("text", "") for e in events2 if e["type"] == "delta")
    check("neutral: 续聊", events2[-1]["type"] == "done" and len(final_text) > 0,
          final_text[:60])

    # 5. compat chat — 前端兼容 wire + 权限桥 (write_file 触发审批, 旁路线程批准)
    def approver(evt):
        if evt["type"] == "permission_request":
            pid = evt["permission"]["id"]
            def do():
                httpx.post(f"{BASE}/api/compat/chat/permission", timeout=10,
                           json={"id": pid, "decision": {"behavior": "allow"}})
            threading.Thread(target=do).start()

    events3 = stream_chat("/api/compat/chat", {
        "message": ("请立刻调用 write_file 工具 (不要只回答文字, 必须发起工具调用), "
                    "把文字 'smoke ok' 写到 backend/data/agent_service/smoke_probe.txt, "
                    "写完后告诉我结果。"),
        "requestId": "smoke-compat-1",
    }, on_event=approver)
    types3 = [e["type"] for e in events3]
    datas = [e.get("data", {}) for e in events3 if e["type"] == "claude_json"]
    check("compat: system/init", any(
        d.get("type") == "system" and d.get("subtype") == "init" and d.get("session_id")
        for d in datas))
    check("compat: content_block_delta", any(
        d.get("type") == "content_block_delta" for d in datas))
    check("compat: permission_request 触发", "permission_request" in types3)
    check("compat: tool_use 事件", any(
        d.get("type") == "assistant" and any(
            c.get("type") == "tool_use" for c in d.get("message", {}).get("content", []))
        for d in datas))
    tool_results = [c for d in datas if d.get("type") == "user"
                    for c in d.get("message", {}).get("content", [])
                    if c.get("type") == "tool_result"]
    check("compat: tool_result 且非 error",
          bool(tool_results) and not tool_results[-1].get("is_error"),
          str(tool_results[-1].get("content"))[:60] if tool_results else "无")
    check("compat: result + done 收尾",
          any(d.get("type") == "result" for d in datas) and types3[-1] == "done")

    from pathlib import Path
    probe = Path(__file__).parent.parent / "data" / "agent_service" / "smoke_probe.txt"
    check("write_file 确实落盘", probe.is_file() and probe.read_text(encoding="utf-8") == "smoke ok")

    # 6. 权限拒绝路径
    def denier(evt):
        if evt["type"] == "permission_request":
            pid = evt["permission"]["id"]
            def do():
                httpx.post(f"{BASE}/api/compat/chat/permission", timeout=10,
                           json={"id": pid, "decision": {"behavior": "deny",
                                                          "message": "测试拒绝"}})
            threading.Thread(target=do).start()

    events4 = stream_chat("/api/compat/chat", {
        "message": "用 write_file 把 'x' 写到 backend/data/agent_service/deny_probe.txt",
        "requestId": "smoke-compat-2",
    }, on_event=denier)
    datas4 = [e.get("data", {}) for e in events4 if e["type"] == "claude_json"]
    tr4 = [c for d in datas4 if d.get("type") == "user"
           for c in d.get("message", {}).get("content", [])
           if c.get("type") == "tool_result"]
    check("权限拒绝: tool_result 是 error", bool(tr4) and tr4[0].get("is_error"),
          str(tr4[0].get("content"))[:70] if tr4 else "无")
    probe_deny = Path(__file__).parent.parent / "data" / "agent_service" / "deny_probe.txt"
    check("权限拒绝: 文件没被写", not probe_deny.exists())

    # 7. sessions 列表 (两种协议)
    r = httpx.get(f"{BASE}/api/agent/sessions", timeout=10)
    check("neutral sessions 列表", r.status_code == 200 and len(r.json()["sessions"]) >= 2)
    r = httpx.get(f"{BASE}/api/compat/sessions", timeout=30)
    ss = r.json()["sessions"]
    check("compat sessions (SessionSummary)", r.status_code == 200 and ss
          and all(k in ss[0] for k in ("sessionId", "firstMessage", "messageCount", "updatedAt")))
    r = httpx.get(f"{BASE}/api/compat/sessions/{sid}/messages", timeout=10)
    check("compat 历史消息", r.status_code == 200 and len(r.json()["messages"]) >= 3)

    # 8. RAG 预留 501
    r = httpx.get(f"{BASE}/api/agent/rag/collections", timeout=10)
    check("rag 占位 501", r.status_code == 501)

    print()
    if failures:
        print(f"共 {len(failures)} 项失败: {failures}")
        sys.exit(1)
    print("全部通过 ✔")


if __name__ == "__main__":
    main()
