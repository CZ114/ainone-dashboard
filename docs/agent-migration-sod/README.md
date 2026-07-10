# SOD：自研 Agent 接入迁移方案（Claude SDK → Music!!! Agent）

> 状态：已定稿，待动工（2026-07-10）
> 目标：把本平台 AI 功能的后端从 `@anthropic-ai/claude-agent-sdk` 迁移到自研 Python agent 库
> （位于 `D:\Imperial\individual\Music!!!\project\agent`），并为 multi-agent 与 RAG 预留接口。

## 文档索引

| 文件 | 内容 |
|---|---|
| [01-current-state.md](01-current-state.md) | 两侧现状盘点：dashboard 的 SDK 依赖清单 + 自研 agent 的可接出面 |
| [02-migration-plan.md](02-migration-plan.md) | 四步迁移方案 M1–M4 及技术要点 |
| [03-protocol.md](03-protocol.md) | agent service 的 HTTP 端点与 NDJSON 流式事件协议（前后端契约） |
| [04-reserved-interfaces.md](04-reserved-interfaces.md) | 预留接口：multi-agent、RAG、memory、MCP |
| [05-task-checklist.md](05-task-checklist.md) | 动工任务清单（按落地顺序） |

## 一句话结论

现有 Claude 依赖全部集中在 Node 层（`backend/claude/`），Python 层（`backend/app/`）和前端本身是干净的。
方案：**新建 Python agent service（FastAPI，:8100），复刻 NDJSON 流式协议，前端设置页加 provider 开关，
双链路并存可随时回退**。不模仿 SDK 的 `claude_json` 消息格式（私有 shape，脆）。

## 落地顺序

**M3（日记，验证打通）→ M1（agent service 核心）→ M2（前端开关）→ 预留接口随 M1 埋入。**
M4（语音）可无限期推迟——其直连路径本来就不走 SDK。
