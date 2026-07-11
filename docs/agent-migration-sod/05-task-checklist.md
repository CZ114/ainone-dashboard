# 05 · 动工任务清单

按落地顺序。每项完成后勾选并记日期。

## 阶段 0：环境准备
- [x] （2026-07-10）修复 backend/.venv：原 uv venv 基座 Python 丢失导致 FastAPI :8080 起不来，
      已用 Python 3.12.12 重建并重装 requirements.txt，全部依赖导入通过
- [x] （2026-07-10）给 `Music!!!\project` 补 `pyproject.toml`（发行名 music-agent，只打包 agent/*），
      editable 安装进 backend/.venv，`from agent import Agent, AgentDeploy` 验证通过
- [x] （2026-07-10）`backend/agent_service/` 目录 + README（HTTP 客户端定为 httpx，venv 已有）
- [x] （2026-07-10）LLM key 落定：用 `Music!!!\project\agent\.env` 的 `VENICE_API_KEY`
      （agent 库 import 时自动加载该 .env），provider=venice，默认模型
      `deepseek-v4-flash`（function calling ✓，1M ctx；可用 `AGENT_MODEL` 环境变量换）
- [x] （2026-07-10）命名映射已实现：`agent_service/config.py` 的 `KEY_ALIASES` 把
      dashboard 惯例（`DEEPSEEK_KEY` 等）映射到 agent 库命名（`DEEPSEEK_API_KEY` 等）

> **实施方式变更（2026-07-10，按用户要求）**：不改动任何原版代码。
> `backend/claude` 整体复制为 `backend/agent_gateway`（SDK 全部剔除，chat/权限/abort/
> sessions 纯代理到 :8100 的 compat 协议，diary runner 改调 oneshot），前端因此**零改动**
> ——原定"阶段 3 前端开关"方案不再需要。Python 服务同时供两种线协议：
> `/api/agent/*`（SOD 03 中立协议）+ `/api/compat/*`（前端 claude_json 兼容协议）。

## 阶段 1：M3 日记打通（最小验证环）
- [x] （2026-07-10）`POST /api/agent/oneshot`：AgentFactory（default/diary_observer/
      agents.json 映射 + secrets `${NAME}` 解析）+ `Agent.send()`
- [x] （2026-07-10）`agent_gateway/diary/runner.ts`：`claude -p` spawn 改为 HTTP 调
      oneshot（`AGENT_SERVICE_URL` 可配，默认 :8100）；原版 runner 未动
- [x] （2026-07-10）`POST /api/diary/trigger` 经网关实测 200：条目落库
      （model=deepseek-v4-flash），:8080 未启动时 fallback 文案正确

## 阶段 2：M1 chat 核心（backend/agent_service/，全部完成）
- [x] main.py（FastAPI 端点）+ wire.py（双协议序列化）；类型定义在 Pydantic 侧
- [x] SessionManager（内存 dict + 会话锁 + TTL 淘汰 + AuditLog "both" 模式 resume）
      ——跨进程 resume 已实测（杀进程重启后续聊，正确记得上文）
- [x] `POST /api/agent/chat` + `/api/compat/chat`：worker 线程跑 `Agent.stream()` →
      queue → NDJSON StreamingResponse
- [x] 权限桥 bridge.py：PermissionBroker（threading.Event，120s 超时=拒绝）
      ——allow 与 deny 两条路径均实测通过（write_file 触发）
- [x] `POST /api/agent/abort/:requestId` + 中断后历史修补（repair_history，
      防 tool_calls 悬空导致下一轮 400）
- [x] 工具集：read_file（白名单+相对路径锚定仓库根）、write_file（requires_approval）、
      list_recordings（调 :8080）、delegate（multi-agent 占位）
- [x] 上下文注入：recordings_context_provider（:8080 不在线时静默跳过）
- [x] sessions 端点（两种协议的 list / messages / reset）
- [x] 预留占位：agentId 校验、delegate 工具、`/api/agent/rag/*` 501、
      cfg.retrieval 字段触发 501
- [x] 冒烟 21 项全过：`backend/.venv/Scripts/python.exe -m agent_service.smoke_test`

## 阶段 3：agent_gateway（代替"前端开关"方案）
- [x] （2026-07-10）`backend/claude` → `backend/agent_gateway` 整体复制并去 SDK：
      package.json 无 claude-agent-sdk、typecheck ✓、vitest 4/4 ✓、
      grep 0 处 SDK 引用；chat/permission/abort/sessions 纯透传，
      voice_chat 保留直连路径（无 key 时明确报错，不再回落 SDK）
- [x] 网关 :3000 实测：/api/sessions 代理 ✓、/api/chat NDJSON 流式 ✓（claude_json
      事件、init、delta、done 全部符合前端消费面）
- [ ] 前端 UI 眼见为实：跑 `start_agent.bat`，在 /chat 页发消息验证渲染
      （wire 格式按 useStreamParser 消费面逐字段对齐过，预期直接可用）

## 阶段 4：收尾
- [x] 新增 `start_agent.bat`（原 start.bat 未动）：8080 + 8100 + agent_gateway:3000 + 5173
- [x] SOD 本清单更新；agent_service/README.md 更新
- [ ] 回归：原链路用原 start.bat 依旧可用（原版代码零改动，理论必然；有空跑一次确认）

## 里程碑后（预留接口兑现，不阻塞迁移）
- [x] （2026-07-11）**设置页模型服务商路由**：config_store 运行时配置 +
      /api/agent/config·/models + "模型路由"tab（provider key 徽标/实时模型列表/温度/embedder）
- [x] （2026-07-11）**multi-agent 配置界面**：agents_admin + /api/agent/agents CRUD/test +
      "Agents"tab（含 secrets 管理）+ chat 页 agent 选择器（agentId 仅新会话生效）
- [x] （2026-07-11）**RAG 管理界面**：rag.py（Chroma + bge-m3 懒加载，HF_HOME=D:\hf 缓存命中）+
      /api/agent/rag/*（collections/ingest/search）+ "知识库"tab；
      factory 兑现 cfg.retrieval → retrieve 工具自动注册。
      实测：ingest 55s（首次含模型加载）→ 检索 0.1s → kb_helper agent 从库答题正确
- [x] （2026-07-11）**diary 完美适配**：网关 mainProvider 改读 :8100（徽标显示 via api.venice.ai）、
      runner test 端点走 oneshot、前端清光 ~/.claude / Anthropic native / claude process 文案；
      修复 agentStore.findSecretReferences 对无 env agent 的 500
- [ ] multi-agent：orchestrator + delegate 工具实现（占位依旧）
- [ ] memory：给 default agent 挂 `memory_root` 试运行
- [x] （2026-07-11）**M4 语音**：agent_service `/api/agent/voice`（`AgentDeploy.think()`
      纯文本流式、无工具、历史客户端携带，跟随模型路由配置）+ 网关 voice_chat.ts
      改纯透传（原直连 Anthropic 路径删除，不再依赖 ANTHROPIC key）。
      管道实测打通（请求穿透网关→服务→provider，错误事件按线协议回传）；
      ⚠ 完整回答验证被 venice 余额耗尽 (402) 挡住——充值或换 provider 后即用
- [ ] 新依赖（chromadb/sentence-transformers/pymupdf4llm）已装入 backend/.venv，
      清单见 backend/agent_service/requirements.txt
