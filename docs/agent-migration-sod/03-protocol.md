# 03 · agent service 协议（端点 + NDJSON 事件）

服务：`backend/agent_service/`，FastAPI，`http://localhost:8100`。

## 端点

| 端点 | 方法 | Body | 返回 |
|---|---|---|---|
| `/api/agent/chat` | POST | `AgentChatRequest` | NDJSON 流（`AgentStreamEvent`） |
| `/api/agent/permission` | POST | `{id, decision: "allow"\|"deny"}` | `{ok}` |
| `/api/agent/abort/:requestId` | POST | — | `{ok}` |
| `/api/agent/oneshot` | POST | `AgentOneshotRequest` | `{text, usage?, session_id}`（阻塞 JSON，给日记用） |
| `/api/agent/sessions` | GET | — | `{sessions: [{id, last_active}]}`（AuditLog.list_sessions） |
| `/api/agent/sessions/:id/messages` | GET | — | `{messages: [...]}`（AuditLog.read_session，干净历史） |
| `/api/agent/sessions/:id/reset` | POST | `{scope: "messages"\|"state"\|"all"}` | `{ok}` |
| `/api/agent/health` | GET | — | `{ok, provider, model, tools: [...]}` |
| `/api/agent/rag/*`、`/api/agent/agents/*` | — | — | 预留，见 04（未实现返回 501） |

## 请求类型

```typescript
interface AgentChatRequest {
  message: string;
  requestId: string;          // 用于 abort 与 permission 关联
  sessionId?: string;         // 缺省则新建；存在则 resume/复用
  agentId?: string;           // 【预留】multi-agent，当前恒 "default"
  // 不透传 effort/thinking/permissionMode —— 自研 agent 无对应概念，
  // 采样参数走服务端 agent config，前端不逐请求控制
}

interface AgentOneshotRequest {
  message: string;
  agentId?: string;           // 映射 agents.json 里的定义（M3 日记用）
  systemPrompt?: string;      // 显式覆盖（优先于 agentId 的定义）
  lang?: "en" | "zh";
}
```

## NDJSON 流事件（AgentStreamEvent）

每行一个 JSON 对象。与 `Agent.stream()` 的 `(kind, payload)` 映射：

| 事件 | 来源 | 字段 |
|---|---|---|
| `{type:"session", sessionId}` | 流开始时发出（新建或恢复后） | |
| `{type:"delta", text}` | kind=`text` | 文本增量 |
| `{type:"tool_call", id, name, arguments}` | kind=`tool_call` | arguments 为 JSON 对象 |
| `{type:"tool_result", id, name, ok, content}` | kind=`tool_result` | content 截断至 output_limit |
| `{type:"permission_request", id, tool, arguments}` | approval_callback 触发 | 前端弹窗，回填 `/permission` |
| `{type:"references", agent, query?, hits}` | done 边界前 (2026-08-21, gap 3) | 本次回答的引用依据: retrieve 命中 / read_recording / read_file; hits=[{source, score?, preview}], 去重封顶 8 条; 与 workflow 的 references 事件同 shape (提取器共用 wire.extract_references) |
| `{type:"done", usage?}` | kind=`done` | 流正常结束 |
| `{type:"error", error}` | 异常 | |
| `{type:"aborted"}` | abort 触发 | |

设计原则：

0. **compat 格式不发 content_block_delta**（2026-07-10 实测教训）：前端
   `useStreamParser.ts` 的 delta 分支闭包捕获过期 messages 快照，每条 delta 都会
   新建气泡（刷屏 bug）；原版 SDK 走的是"每轮一条完整 assistant 消息"。因此 compat
   侧把文本缓冲在 `ctx.text_buf`，在轮次边界（tool_call / permission_request /
   done / error / aborted）整体 flush 成一条完整 assistant 消息——与原版行为一致，
   等待期由前端的 "thinking" 状态覆盖。neutral 格式仍保留真正的逐 token delta。
1. **provider 中立**——不携带任何 SDK 私有结构；未来换模型/换 agent 实现，前端不动。
2. 与现有 `StreamResponse`（`claude_json/permission_request/done/error/aborted`）风格一致，
   前端读流循环可复用 `claudeApi.ts` 中的 NDJSON parser。
3. 类型定义落在 `backend/shared/types.ts`（TS 侧）与 `backend/agent_service/schemas.py`
   （Pydantic 侧）**双份，以 shared/types.ts 为准**。

## 权限桥时序

```
agent 线程                    HTTP 层                       前端
────────────                 ────────────                  ────────────
tool requires_approval
→ 生成 permission_id
→ push permission_request ─→ NDJSON 流发出 ─────────────→ 弹窗
→ Event.wait(120s) 阻塞
                             POST /api/agent/permission ←─ 用户点击 allow/deny
                             → pending[id].decision = ...
                             → Event.set()
← 唤醒，返回 True/False
（超时 = deny，流内继续）
```

## Abort 时序

`POST /api/agent/abort/:requestId` → 置 `abort_flags[requestId]` →
流式循环每次 yield 前检查 flag → 发 `{type:"aborted"}` 并停止迭代
（当前工具执行完成后才停；不做线程强杀）。
