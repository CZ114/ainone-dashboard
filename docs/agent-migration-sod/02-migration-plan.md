# 02 · 迁移方案（M1–M4）

## M1：建 agent service（核心工作量）

新增 `backend/agent_service/`（Python，FastAPI，**:8100**），引入自研 agent 库
（开发期 `pip install -e D:\Imperial\individual\Music!!!\project`，或 vendor 拷贝 `agent/` 包）。

端点与事件协议见 [03-protocol.md](03-protocol.md)。

### 三个技术要点

1. **同步→异步桥接**
   `Agent.stream()` 是同步生成器。FastAPI 的 `StreamingResponse` 接受同步迭代器
   （内部经 anyio 线程池迭代），单用户研究平台足够——每个进行中请求占一个线程，不重写 async。

2. **权限桥（对应 canUseTool）**
   - agent 线程内 `approval_callback(tool_call)` 被调用时：
     生成 `permission_id` → 往输出队列 push 一条 `permission_request` 事件 →
     `threading.Event.wait(timeout=120)` 阻塞；
   - 前端弹窗 → `POST /api/agent/permission {id, decision}` → 查 pending 表 → set Event；
   - 超时按 deny 处理并在流里发 `error`/继续。
   与 Hono 层现在用 Promise 挂起是同一模式，换成线程原语。

3. **会话管理（SessionManager）**
   - 内存 `dict[session_id, AgentEntry]`，AgentEntry 含 Agent 实例 + last_active + lock（同一会话串行）；
   - TTL 淘汰（如 30 min 不活跃即释放实例）；
   - 进程重启/淘汰后请求到来 → `Agent.resume(session_id)` 从 AuditLog 重建；
   - AuditLog 模式用 `"both"`（transcript 供 resume，audit 供合规回放）。

### 传感器上下文注入（Python 内完成，不再经 Node）

```python
agent.context.watch_timestamped(
    "最近录音",
    fetch=lambda: format_recordings(
        requests.get("http://localhost:8080/api/recordings/list", timeout=4).json()
    ),
    fresh_minutes=10,
)
```

### 初始工具集（Registry）

SDK 的 claude_code 工具全家桶没有对应物。按 chat 页面的实际用途最小化补齐：

- `read_file(path)`（限制在仓库/recordings 白名单目录内）
- `list_recordings()` / `read_recording_csv(id, max_rows)`（直接调 :8080 REST）
- 后续按需加 `run_python` 等（默认 `requires_approval=True`）

## M2：前端接入

**禁止模仿 `claude_json` 的 SDK 消息 shape**（私有格式，随 SDK 版本漂移）。做法：

1. `backend/shared/types.ts` 新增 provider 中立的 `AgentStreamEvent` 类型（见 03）；
2. 新建 `frontend/src/api/agentApi.ts`（NDJSON 读流逻辑从 `claudeApi.ts` 抽公共函数复用）；
3. 设置页加 "AI Provider: Claude SDK / My Agent" 开关，`chatStore.ts` 按开关选 client；
4. 双链路并存，可随时回退对比。

## M3：日记迁移（建议最先做，一天内可打通）

`diary/runner.ts` 的 `claude -p` spawn 改为 HTTP 调 `POST /api/agent/oneshot`。
orchestrator / scheduler / store / 前端全部不动。
`agents.json` 的 `{model, env, system_prompt, sampling}` 直接映射到
`AgentDeploy(provider=..., model=..., api_key=...)` + Agent 的 system_prompt 参数。
provider 判定：由 model 名/base_url 推断或在 agent config 里显式加 `provider` 字段。

## M4：语音（可无限期推迟）

`voice_chat.ts` 的直连路径本来就不走 SDK，先不动。
未来统一时加 `POST /api/agent/voice`，内部用 `AgentDeploy.think()`（纯文本流式、无工具、无 thinking）
保住 200–400ms 首字延迟。

## 风险

| 风险 | 说明 |
|---|---|
| 同步并发上限 | 一会话一线程，单用户 OK；多用户需再评估（届时给 AgentDeploy 补 async invoke） |
| 文件工具能力差距 | 前端 chat 若依赖"让 AI 读 CSV/写文件"，需在 Registry 补对应工具（M1 初始工具集） |
| 权限模型差异 | 自研是 per-tool 布尔 `requires_approval`，SDK 是 per-call 动态判定；初期够用，AgentFactory 里别写死 |
| BGE-M3 体积 | embedder 延迟加载，服务启动不默认拉 2.3GB 模型（见 04 RAG 预留） |
