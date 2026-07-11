# 04 · 预留接口

> **状态更新（2026-07-11）：multi-agent 与 RAG 两个预留接口均已兑现。**
> - 运行时配置：`config_store.py` + `GET/PATCH /api/agent/config` + `/models`（设置页"模型路由"tab）
> - multi-agent：`agents_admin.py` + `/api/agent/agents/*` CRUD/test（设置页"Agents"tab，
>   与日记共享 agents.json）；chat 页有 agent 选择器（agentId 只对新会话生效）
> - RAG：`rag.py`（ChromaStore@data/agent_service/rag + bge-m3 懒加载单例 + 段落切块）+
>   `/api/agent/rag/*`（collections CRUD/ingest/search，设置页"知识库"tab）；
>   factory `_retrieval_kwargs` 把 cfg.retrieval 挂成 Agent(retrieval=, embedder=)
> - diary 适配：网关 mainProvider.ts 改读 :8100 config；前端清光 Claude CLI 时代文案
> - 仍未做：`delegate` 工具的 orchestrator 实现（占位依旧）、MCP 配置化接入
>
> 以下为原始预留设计，留作历史记录。

原则：**协议字段先带上、工厂先留槽、端点先占位（501）**，实现补上时前端与契约零改动。

## 1. Multi-agent（定义尚未编写 → 只留槽位）

### 请求层
- `AgentChatRequest.agentId?: string`、`AgentOneshotRequest.agentId?: string` 已进协议，
  当前后端只认 `"default"`，其余值返回 404 + 可用列表。

### 工厂层（关键预留）
`backend/agent_service/factory.py`：

```python
def build_agent(cfg: dict, *, audit_log, session_id) -> Agent:
    """cfg 直接复用 backend/data/diary/agents.json 的 schema:
    {name, description, provider?, model, env, system_prompt,
     sampling{temperature,max_tokens},
     retrieval?: {collection, top_k} | None,     # ← RAG 预留
     memory_root?: str | None,                    # ← memory 预留
     mcp_servers?: list | None}                   # ← MCP 预留
    """
```

- secrets 解析（`${NAME}` 占位符）沿用 dashboard 的三级链：UI 存储 > .env > process.env。
  Python 侧实现一份等价的 `resolve_secrets()`，读同一个 `agents.json`。
- **收益**：dashboard 已有的 agent 管理 UI（/api/diary/agents CRUD + secrets 页面）零改动
  即成为 multi-agent 配置界面。后续把 `/api/diary/agents` 语义升级为全局 `/api/agent/agents` 即可。

### 编排层
- Registry per-agent 隔离（无全局状态）→ 多 agent 同进程共存无障碍；
- 预留 `delegate` 工具 schema（注册但 handler 抛 `NotImplementedError`）：

```json
{"name": "delegate", "description": "把子任务委派给另一个 agent",
 "parameters": {"properties": {"agent_id": {"type": "string"},
                               "task": {"type": "string"}}, "required": ["agent_id", "task"]}}
```

- 未来 orchestrator：每个子 agent 独立 Registry + 共享同一 AuditLog 文件（session_id 区分）。

## 2. RAG（系统未完善 → 接口先通，实现后插）

自研库的注入点本身就是最佳预留：`Agent(retrieval=None, embedder=None)` 优雅降级，
补上实例即自动注册 `retrieve(query, top_k)` 工具。

需要补三处：

1. **agent config 字段**：`retrieval: {collection: str, top_k: int} | null`
   → 工厂内映射 `ChromaStore(path=DATA_DIR/"rag", collection_name=cfg["collection"])`，
   每个 agent 可挂不同知识库。
2. **占位端点**（先 501，前端设置页留入口）：
   - `POST /api/agent/rag/ingest` `{collection, documents: [{source, text}]}` — 切块→嵌入→入库
   - `GET  /api/agent/rag/collections` — `[{name, count}]`
   - `DELETE /api/agent/rag/collections/:name`
3. **embedder 延迟加载**：config `embedder: "bge-m3" | "dummy"`；
   `"bge-m3"`（2.3GB）在首次用到时才加载并进程内缓存单例；开发/CI 用 `"dummy"`。

## 3. Memory（可直接启用）

`FileMemoryStore` + 三层披露已完备。config 加 `memory_root` 字段，
指到 `backend/data/agent_memory/<agent_id>/`，即自动获得
remember / list_memories / recall_memory / forget_memory 四个工具。
与日记系统"长期观察用户"的定位互补：日记写给用户看，memory 写给 agent 自己用。

## 4. MCP（远期）

config 加 `mcp_servers: []` 数组（元素 = `register_mcp_server()` 的 source：
路径 / 命令列表 / URL）。远期方向：把 FastAPI :8080 的硬件接口包成 MCP server，
硬件能力即插即用地暴露给任意 agent。
