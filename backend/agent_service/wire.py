"""线协议序列化 — 内部事件 → NDJSON 行。

两种出线格式:
- neutral: SOD 03-protocol.md 定义的 provider 中立协议 (新前端/联调用)
- compat:  原前端 useStreamParser 消费的 claude_json 兼容 shape
           (字段清单来自前端消费面分析, 网关副本纯透传, 前端零改动)

内部事件 kind: session / text / tool_call / tool_result / permission_request /
done / error / aborted — 与 Agent.stream() 的 yield 一一对应 (session/permission/
error/aborted 由服务层补充)。
"""

import json
import re
import time


def _line(obj):
    return json.dumps(obj, ensure_ascii=False, default=str) + "\n"


def _parse_args(arguments_json):
    try:
        return json.loads(arguments_json or "{}")
    except json.JSONDecodeError:
        return {"_raw": arguments_json}


def _result_is_error(content):
    try:
        parsed = json.loads(content)
        return isinstance(parsed, dict) and "error" in parsed
    except (json.JSONDecodeError, TypeError):
        return False


# ─── References 提取 (Phase 2, gap 3 — chat 与 workflow 共用) ─────────

def extract_references(tool_name, content):
    """tool_result content → (query, hits) 或 None。

    统一的"答案根据什么"提取器, 三类来源:
    - retrieve 工具结果 (RAG): {query, hits:[{source, score, text}]} — 按 shape 识别,
      不需要工具名 (workflow 节点的 tool 消息里拿不到名字)
    - read_recording: 引用到具体录音 session
    - read_file: 引用到具体文件路径
    """
    try:
        data = json.loads(content or "")
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict) or "error" in data:
        return None
    if isinstance(data.get("hits"), list):          # retrieve 结果 (shape 识别)
        hits = [{"source": h.get("source"), "score": h.get("score"),
                 "preview": (h.get("text") or "")[:150]}
                for h in data["hits"] if isinstance(h, dict)]
        return (data.get("query"), hits) if hits else None
    if tool_name == "read_recording" and data.get("id"):
        q = data.get("quality") or {}
        preview = (f"录音 {q.get('duration_s')}s @{q.get('sample_rate_hz')}Hz, "
                   f"{q.get('rows')}行（Recording, {q.get('rows')} rows）"
                   if q.get("duration_s") is not None else "录音（Recording）")
        return (None, [{"source": f"recording:{data['id']}", "preview": preview}])
    if tool_name == "read_file" and data.get("path"):
        return (None, [{"source": data.get("path"),
                        "preview": (data.get("content") or "")[:120]}])
    return None


def _collect_refs(payload, ctx):
    """tool_result 事件 → 攒进 ctx["refs"] (done 时统一发一条 references)。"""
    name = ctx["tool_names"].get(payload.get("tool_call_id"))
    ref = extract_references(name, payload.get("content"))
    if ref:
        query, hits = ref
        ctx["ref_query"] = query or ctx.get("ref_query")
        ctx["refs"].extend(hits)


def _references_line(ctx):
    """去重(按 source)+封顶 8 条, 生成统一 references 事件行。"""
    seen, hits = set(), []
    for h in ctx["refs"]:
        key = h.get("source")
        if key in seen:
            continue
        seen.add(key)
        hits.append(h)
        if len(hits) >= 8:
            break
    line = _line({"type": "references", "agent": "chat",
                  "query": ctx.get("ref_query"), "hits": hits})
    ctx["refs"], ctx["ref_query"] = [], None
    return line


_THINK_SPLIT_RE = re.compile(r"^\s*<think>(.*?)</think>\s*", re.DOTALL)


def split_think(text):
    """拆推理模型 (MiniMax-M3 等) 开头的 <think>…</think> 块。

    Returns:
        (thinking, rest) — 非推理输出时 thinking 为 None, rest 原样。
    """
    if not isinstance(text, str) or "<think>" not in text[:16]:
        return None, text
    m = _THINK_SPLIT_RE.match(text)
    if not m:
        return None, text
    return m.group(1).strip(), text[m.end():]


def strip_think(text):
    """只要正文不要思考 (日记 oneshot / 工作流变量池等场景)。"""
    return split_think(text)[1]


def iter_strip_think(pieces):
    """流式剥 <think> (语音场景 — 推理过程不该被 TTS 朗读出来)。

    开头攒缓冲判断是否 <think> 块: 是 → 吞到 </think> 再放行其余;
    不是 → 原样流出。中途不再检查 (think 块只出现在开头)。
    """
    buf, mode = "", "detect"   # detect → think → pass
    for p in pieces:
        if mode == "pass":
            yield p
            continue
        buf += p
        if mode == "detect":
            s = buf.lstrip()
            if not s:
                continue
            probe = "<think>"
            if s.startswith(probe):
                mode = "think"
            elif probe.startswith(s[:len(probe)]):
                continue          # 可能是 "<thi" 这种残片, 继续攒
            else:
                mode = "pass"
                yield buf
                buf = ""
                continue
        if mode == "think":
            end = buf.find("</think>")
            if end != -1:
                rest = buf[end + len("</think>"):].lstrip("\n")
                mode, buf = "pass", ""
                if rest:
                    yield rest
    if buf and mode != "think":
        yield buf


def new_stream_ctx(session_id, model, tool_names):
    return {
        "session_id": session_id,
        "model": model,
        "tools": tool_names,
        "start": time.time(),
        "text_buf": [],        # compat: 本轮文本缓冲 (轮次边界整体 flush)
        "tool_names": {},      # tool_call_id -> name (tool_result 回填用)
        "refs": [],            # Phase 2 gap 3: 本次请求攒的引用命中
        "ref_query": None,
    }


def serialize(kind, payload, ctx, fmt):
    """返回 NDJSON 行列表 (一个内部事件可能映射成多行)。"""
    if kind == "tool_result":
        _collect_refs(payload, ctx)     # 两种 fmt 共用的引用收集
    if fmt == "compat":
        out = _compat(kind, payload, ctx)
    else:
        out = _neutral(kind, payload, ctx)
    # done 边界: 有引用则在最终 done 行之前发一条统一 references 事件
    # (独立顶层事件, 不塞进 assistant 气泡 — 见 03-protocol 的 compat flush 教训)
    if kind == "done" and ctx["refs"]:
        out.insert(max(len(out) - 1, 0), _references_line(ctx))
    return out


# ─── neutral (SOD 03) ────────────────────────────────────────────────

def _neutral(kind, payload, ctx):
    if kind == "session":
        return [_line({"type": "session", "sessionId": ctx["session_id"]})]
    if kind == "text":
        return [_line({"type": "delta", "text": payload})]
    if kind == "tool_call":
        ctx["tool_names"][payload["id"]] = payload["function"]["name"]
        return [_line({
            "type": "tool_call",
            "id": payload["id"],
            "name": payload["function"]["name"],
            "arguments": _parse_args(payload["function"]["arguments"]),
        })]
    if kind == "tool_result":
        tcid = payload.get("tool_call_id")
        return [_line({
            "type": "tool_result",
            "id": tcid,
            "name": ctx["tool_names"].get(tcid),
            "ok": not _result_is_error(payload.get("content")),
            "content": payload.get("content"),
        })]
    if kind == "permission_request":
        return [_line({
            "type": "permission_request",
            "id": payload["id"],
            "tool": payload["toolName"],
            "arguments": payload["input"],
        })]
    if kind == "done":
        return [_line({"type": "done"})]
    if kind == "error":
        return [_line({"type": "error", "error": str(payload)})]
    if kind == "aborted":
        return [_line({"type": "aborted"})]
    return []


# ─── compat (前端 useStreamParser 消费面) ────────────────────────────
#
# 重要: 不发 content_block_delta! 前端的 delta 分支闭包捕获过期 messages 快照,
# 每条 delta 都会 addMessage 新气泡 (useStreamParser.ts:113-131, 实测刷屏)。
# 原版 Claude SDK 走的是"每轮一条完整 assistant 消息"路径 (:140), 这里对齐它:
# 文本先进 ctx["text_buf"], 在轮次边界 (tool_call / permission / done / error)
# 整体 flush 成一条 {"type":"assistant", content:[{type:"text",...}]}。

def _cj(data):
    return _line({"type": "claude_json", "data": data})


def _flush_text(ctx):
    if not ctx["text_buf"]:
        return []
    raw = "".join(ctx["text_buf"])
    ctx["text_buf"] = []
    # 推理模型 (MiniMax-M3 等): <think> 块拆成前端原生支持的 thinking
    # 内容块 → 聊天页渲染成折叠的"思考气泡", 正文照常
    thinking, text = split_think(raw)
    content = []
    if thinking:
        content.append({"type": "thinking", "thinking": thinking})
    if text.strip():
        content.append({"type": "text", "text": text})
    if not content:
        return []
    return [_cj({
        "type": "assistant",
        "message": {"content": content},
    })]


def _compat(kind, payload, ctx):
    if kind == "session":
        return [_cj({
            "type": "system",
            "subtype": "init",
            "session_id": ctx["session_id"],
            "model": ctx["model"],
            "tools": ctx["tools"],
            "cwd": "",
            "permissionMode": "default",
        })]
    if kind == "text":
        ctx["text_buf"].append(payload)
        return []
    if kind == "tool_call":
        ctx["tool_names"][payload["id"]] = payload["function"]["name"]
        return [
            *_flush_text(ctx),
            _cj({
                "type": "assistant",
                "message": {"content": [{
                    "type": "tool_use",
                    "id": payload["id"],
                    "name": payload["function"]["name"],
                    "input": _parse_args(payload["function"]["arguments"]),
                }]},
            }),
        ]
    if kind == "tool_result":
        return [_cj({
            "type": "user",
            "message": {"content": [{
                "type": "tool_result",
                "tool_use_id": payload.get("tool_call_id"),
                "content": payload.get("content"),
                "is_error": _result_is_error(payload.get("content")),
            }]},
        })]
    if kind == "permission_request":
        return [
            *_flush_text(ctx),
            _line({
                "type": "permission_request",
                "permission": {
                    "id": payload["id"],
                    "toolName": payload["toolName"],
                    "toolUseId": payload["toolUseId"],
                    "input": payload["input"],
                    "title": f"Agent 请求执行 {payload['toolName']} / "
                             f"Agent requests to run {payload['toolName']}",
                    "displayName": payload["toolName"],
                },
            }),
        ]
    if kind == "done":
        return [
            *_flush_text(ctx),
            _cj({
                "type": "result",
                "result": {"content": "done"},
                "duration_ms": int((time.time() - ctx["start"]) * 1000),
            }),
            _line({"type": "done"}),
        ]
    if kind == "error":
        return [*_flush_text(ctx), _line({"type": "error", "error": str(payload)})]
    if kind == "aborted":
        return [*_flush_text(ctx), _line({"type": "aborted"})]
    return []
