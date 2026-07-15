# agent_service（自研 Agent 后端，:8100）

设计文档：`docs/agent-migration-sod/`。状态（2026-07-10）：**已打通并实测**。

## 架构

```
React :5173 ──(原前端零改动)──► agent_gateway :3000 ──纯透传──► agent_service :8100
                                 (backend/claude 的去SDK副本)      │
backend/app :8080 (硬件/录音) ◄──── list_recordings 工具 / 上下文注入
                                                                  │
                                              Music!!! agent 库 (editable install)
                                                    └─ venice / deepseek-v4-flash
```

- `/api/agent/*` — SOD 03 中立协议（oneshot 给日记、chat 给未来新前端）
- `/api/compat/*` — 原前端 claude_json 兼容协议（网关透传，前端 useStreamParser 直接消费）
- 权限桥：工具 `requires_approval=True` → 流里发 `permission_request` → 前端 POST 决定
  → threading.Event 唤醒工具线程（120s 超时=拒绝）
- 会话：`backend/data/agent_service/sessions/<sid>.jsonl`（AuditLog "both" 模式），
  进程重启后带旧 sessionId 自动 resume

## 模块

| 文件 | 职责 |
|---|---|
| config.py | 路径 / .env / key 命名映射（DEEPSEEK_KEY→DEEPSEEK_API_KEY 等）/ 默认 provider·model |
| factory.py | AgentFactory：default/diary_observer/agents.json 定义 → Agent 实例（multi-agent 落点） |
| sessions.py | SessionManager（TTL、锁、resume）+ abort 后历史修补 |
| bridge.py | PermissionBroker + AbortRegistry（线程原语桥 HTTP） |
| agent_tools.py | read_file / write_file(审批) / list_recordings / delegate(占位) + 录音上下文 provider |
| wire.py | 内部事件 → neutral / compat 两种 NDJSON |
| main.py | FastAPI 端点（含 rag 501 占位） |
| smoke_test.py | 21 项冒烟（真实 LLM 实调） |

## 运行

```powershell
# 单独起 (backend/ 目录下)
.venv\Scripts\python.exe -m agent_service.run
# 或整套: 仓库根目录 start_agent.bat (8080 + 8100 + gateway:3000 + 5173)

# 冒烟 (服务已启动时)
.venv\Scripts\python.exe -m agent_service.smoke_test
```

Key：agent 库自动加载 `Music!!!\project\agent\.env`（VENICE_API_KEY）。
换模型：环境变量 `AGENT_MODEL`（须在 venice 上支持 function calling）；
换 provider：`AGENT_PROVIDER` + 相应 key。

## 预留接口（见 SOD 04）

- multi-agent：请求 `agentId` 字段 + agents.json schema + `delegate` 工具占位
- RAG：cfg `retrieval` 字段与 `/api/agent/rag/*` 均返回 501，实现后即插
