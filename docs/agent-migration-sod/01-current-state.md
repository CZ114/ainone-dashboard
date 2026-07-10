# 01 · 现状盘点

## 1. Dashboard 侧（本仓库）

三个服务：

| 层 | 技术 | 端口 | 职责 |
|---|---|---|---|
| `backend/app/` | FastAPI + uvicorn | 8080 | 串口/BLE/UDP 硬件 I/O、录音管理、50Hz WebSocket |
| `backend/claude/` | Hono + Node 20 | 3000 | 包装 `@anthropic-ai/claude-agent-sdk`：chat / 日记 / 语音 |
| `frontend/` | React 18 + Vite + Zustand | 5173 | /dashboard /chat /diary /settings |

### Claude SDK 依赖清单（全部在 `backend/claude/`）

| 功能 | 文件 | 用法 | 迁移难度 |
|---|---|---|---|
| Chat | `handlers/chat.ts`（~700 行） | SDK `query()` 异步迭代器 + `canUseTool` 权限回调；NDJSON 流回前端 | ★★★ 最重 |
| 语音 | `handlers/voice_chat.ts`（402 行） | 双路径：有 key 直连 `/v1/messages`（claude-haiku-4-5，无 thinking）；无 key 走 SDK | ★★ |
| 日记 | `diary/runner.ts` | spawn `claude -p` 一次性运行；`contextBuilder.ts` 注入录音数据表格 | ★ 最容易 |

### 前后端契约（`backend/shared/types.ts`）

- `POST /api/chat` → NDJSON 流，事件：`claude_json | permission_request | done | error | aborted`
- 权限回填：`POST /api/chat/permission` `{id, decision}`
- 中止：`POST /api/abort/:requestId`
- 会话存储：`~/.claude/projects/<encodedCwd>/<sessionId>.jsonl`（CLI 私有，后端只读）；
  内存 `sessionRegistry: Map<sessionId, cwd>`
- 前端 client：`frontend/src/api/claudeApi.ts`（489 行，大部分是 NDJSON 读流逻辑，可复用）、
  `frontend/src/api/diaryApi.ts`；状态在 `frontend/src/store/chatStore.ts` / `diaryStore.ts`

### 关键资产：日记系统已有 agent 管理基建

`backend/data/diary/agents.json` + `diary/agentStore.ts` + `/api/diary/agents/*` CRUD +
secrets 管理（UI 粘贴 > .env > process.env 三级解析 `${NAME}` 占位符）。
Agent 定义 schema：`{name, description, model, env, system_prompt, sampling{temperature,max_tokens}}`。
**这是 multi-agent 定义的现成落点，迁移时零改动复用。**

### 传感器数据进入 prompt 的路径

`diary/contextBuilder.ts` → `GET http://localhost:8080/api/recordings/list`（超时 4s）→
最近 3 条录音格式化为 markdown 表格 → 前置到 user prompt。约束：禁医疗结论、禁编造数据。

## 2. 自研 Agent 侧（`D:\Imperial\individual\Music!!!\project\agent`）

纯 Python 库，`from agent import Agent, AgentDeploy, create_registry` 即可用；核心依赖仅
`openai>=1.40` + `python-dotenv`。RAG 可选依赖 chromadb + sentence-transformers。

### 可接出面

| 组件 | 文件 | 入口 | 说明 |
|---|---|---|---|
| Agent 主循环 | `agent/core/agent.py`（Agent，73-457 行） | `.send(text)->str` 阻塞；`.stream(text)` yield `(kind, payload)`，kind ∈ text/tool_call/tool_result/done | stream 与 NDJSON 天然对应 |
| 会话恢复 | 同上 + `agent/core/audit.py` | `.resume(session_id)`；AuditLog JSONL：list_sessions / read_session / read_last_state_snapshot | 不依赖 CLI session 文件 |
| 权限 | Agent 构造参数 `approval_callback` | per-tool `requires_approval` 布尔 | 对应 dashboard 的 canUseTool 弹窗 |
| LLM 客户端 | `agent/core/llm.py`（AgentDeploy） | `invoke()` / `stream_invoke_with_tools()` / `think()`（纯文本流） | 支持 openai/deepseek/qwen/kimi/zhipu/venice/ollama/custom，表驱动 |
| 工具 | `agent/tools/registry.py` + `executor.py` | `@reg.tool(...)` 装饰器；`dispatch_all()` 并行执行（ThreadPool 8 workers） | Registry per-agent 隔离，无全局状态 |
| 上下文注入 | `agent/core/context/manager.py` | `watch_state / watch_callable / watch_timestamped / share_state` | 替代 contextBuilder.ts |
| 记忆 | `agent/core/memory/` | FileMemoryStore，三层披露 + remember/recall 工具自动注册 | markdown 文件持久化 |
| RAG | `agent/retrieval/`（store/embed/tools） | `Agent(retrieval=ChromaStore(...), embedder=...)` 自动注册 retrieve 工具；`retrieval=None` 优雅降级 | **未完善，接口已可预留** |
| MCP | `agent/tools/mcp.py` | `register_mcp_server(registry, source)`，支持 stdio/HTTP/SSE | |

### 缺口（agent service 要补的）

- ❌ HTTP 端点层（无 FastAPI/任何 server 包装）
- ❌ async（全同步，openai sync client）
- ❌ `stream()` 内权限暂停点的跨请求桥接
- ❌ HTTP 级会话管理（AuditLog 只管持久化，不管实例生命周期）
- ❌ 内置文件工具（SDK 的 claude_code 全家桶 Read/Write/Bash 没有对应物，按需在 Registry 补）
