# 07 · 能力控制台：Workflows UI + human_in_loop + MCP + Skills（设计记录）

> 写于 2026-07-11 动工前。目标：把工作流、人机协同、MCP 工具源、Skills 技能库
> 全部收进设置页，**过程尽量简单合理**——不造新概念，全部复用已有机制。

## 1. 界面归置（不加新顶层入口，控制 tab 数量）

| Tab | 原有内容 | 本轮加什么 |
|---|---|---|
| Agents | agent 预设 + Secrets | **+ MCP 工具源**（agent 的第三种能力来源，与 secrets 并列成节） |
| Knowledge | RAG collections/ingest/检索 | **+ Skills 技能库**（用户建议：技能≈给 agent 的"过程性知识"，与知识库同屋合理） |
| **Workflows（新）** | — | 工作流列表 / JSON 编辑器（带组件速查）/ 运行面板（事件流直播 + human 输入框） |

不做可视化节点编辑器——v1 用 **JSON 编辑器 + 五组件速查卡 + 保存时后端校验**
（400 详情直接展示）。这是"简单"和"诚实"的平衡点：spec 本来就是给人读的 JSON。

## 2. human_in_loop（新步骤组件，第六种）

```jsonc
{"type": "human", "id": "user_pick", "prompt": "两个方案:\n{plan_a}\n{plan_b}\n你选哪个?"}
```

- **库侧**（`agent/orchestration`）：引擎 `run(inputs, build_agent, ask_human=None)` 新增
  注入点；遇到 human 步骤 → 渲染 prompt → 调 `ask_human(text) -> str` → 答案入变量池。
  未注入 ask_human 却遇到 human 步骤 → 明确报错。事件：`human_ask` → (等待) → `step_end`。
  设计与 Agent 的 `approval_callback` 同构——**库只留同步回调口，不知道 HTTP**。
- **服务侧**：`/api/agent/workflows/{id}/stream` 改为 worker 线程 + 队列
  （复刻 chat 权限桥的成熟模式）：`ask_human` 先往流里推
  `{"type": "human_input_required", "input_id", "step", "prompt"}`（先于阻塞 flush），
  然后 `threading.Event.wait(600s)`；前端 `POST /api/agent/workflows/input {id, value}` 唤醒。
  超时 = WorkflowError 终止并发 error 事件。
- 阻塞式 `/run` 遇到 human 步骤直接 400（提示改用 /stream）。

## 3. MCP 工具源

- **存储** `data/agent_service/mcp.json`：`{version, servers: {name: {transport, command|url, enabled}}}`
  - `transport: "stdio"` → `command`（字符串，服务端 shlex 拆分后传库的 list 形态）
  - `transport: "url"` → `url`（HTTP/SSE，库自动识别）
- **生效点**：`factory.build_chat_agent` 对每个 enabled server 调
  `register_mcp_server(reg, source, name_prefix=name)`；**每个 server 独立 try/except**
  ——一个挂了不拖垮聊天，错误进状态缓存供 UI 展示。库内部长连接按 source 缓存，
  多会话重复注册零成本。oneshot/工作流节点**不挂 MCP**（保持轻量，需要外部工具的
  子任务交给 chat 主 agent 或 delegate）。
- **端点**：`GET /api/agent/mcp`（含最近注册状态: 工具数/错误）、`PUT/DELETE /{name}`、
  `POST /{name}/test`（现场连一次列工具，不落状态）。改动对**新会话**生效（与模型路由同语义）。
- **UI**（Agents tab 新节）：server 卡片（name/transport/摘要/enabled 开关/Test/删除）+
  添加表单。测试目标用库自带的 `demos/mcp_demo_server.py`（stdio）。
- 依赖：`fastmcp` 装入 backend/.venv（库的 mcp extra）。

## 4. Skills 技能库

- **存储** `data/agent_service/skills/<name>/SKILL.md`（库的 FileSkillStore 原生布局：
  frontmatter name/description + 正文即主指令；`references/`、`scripts/` 目录高级用法
  v1 不做 UI——手动放文件即可被 skill_view/read_file/run_script 工具使用，文档说明）。
- **生效点**：`build_chat_agent` 挂 `skill_store=FileSkillStore(...)`（聊天里 `/技能名 参数`
  自动展开）+ `register_skills(reg, dir)`（LLM 可自主发现调用）。目录为空则整体跳过。
- **端点**：`GET /api/agent/skills`、`GET/PUT/DELETE /{name}`（PUT body: description + body，
  服务端拼 SKILL.md；name 规则同 agent id）。
- **UI**（Knowledge tab 新节，置于 RAG 三节之后）：技能列表 + 编辑器
  （name/description/markdown 正文 textarea）+ 删除；顶部一行说明 `/name` 用法。

## 5. Workflows tab 细节

- **列表**：卡片（name/description/inputs/引用 agents）+ 新建/编辑/运行/删除。
- **编辑器**：id（新建时可填）+ JSON textarea + 右侧速查卡（六种组件 + 条件写法 +
  APPROVED 锚定 regex 的坑，抄自 SOD 06）。保存 = PUT，400 detail 原样展示。
- **运行面板**：选工作流 → 按 spec.inputs 生成输入框 → Run → 逐事件渲染：
  step 卡（agent 名/耗时/输出可折叠）、loop 迭代分隔、route 选支徽标、
  **human_input_required → 内联输入框 + 提交**、workflow_end 高亮最终输出。
  用 fetch 流式读 NDJSON（复用 agentAdminApi 风格）。

## 6. 验收清单

- [ ] 库：human 组件语义测试（FakeAgent + 脚本化 ask_human）进 smoke_workflow_semantics
- [ ] 服务：MCP demo server 注册成功（工具数>0）+ 故障 server 不拖垮聊天
- [ ] 服务：skill CRUD → chat 里 `/技能名` 展开生效（真实 LLM）
- [ ] UI：Workflows tab 跑 reflect_write 直播事件；带 human 步骤的示例工作流
      在浏览器里暂停-输入-继续
- [ ] 文档/提交：SOD 06 补 human 组件；双仓分别提交

## 7. 明确不做（首轮）

~~可视化节点编辑器~~（§8 已追加）、MCP per-agent 选择、skills 的 references/scripts UI、
workflow 运行历史持久化、step 级成本统计。

## 8. 可视化工作流编辑器（2026-07-11 追加设计，用户要求：拖动版块+箭头+侧面动态编码）

**核心决策：结构化垂直流，不是自由节点图。** spec 是严格的"顺序 + 嵌套"树
（steps 数组、loop/parallel/route 的子块），React-Flow 式任意连线会画出大量
无法映射回 spec 的非法拓扑（环、多出边）。因此：

- **顺序 = 垂直堆叠 + 向下箭头**（SVG 小箭头连接相邻块）
- **loop = 嵌套容器**（虚线框 + 🔁 头部 + max_iters 可编辑 + 左侧回环箭头示意）
- **parallel = 容器内水平分列**（顶部分叉/底部汇合连接线）
- **route = 分支列**（router 块在上，各分支带可编辑键名标签，default 标记）
- **agent/human/break_if = 叶子块**（🤖/🙋/◇ 区分色；点击展开属性编辑抽屉：
  id/agent 下拉/prompt/条件三件套）
- **拖拽重排**：HTML5 DnD；块间与容器首尾渲染插入落点（drop zone），
  同容器重排/跨容器移动同一机制；底部"+ 添加步骤"六类型菜单（也可拖入）
- **路径寻址**：每个块由树路径定位（如 `['steps',1,'steps',0]`、
  `['steps',2,'routes','医疗',0]`），所有编辑 = 不可变更新 spec 状态
- **侧面 JSON 双向同步**：画布改动 → 右栏 JSON 实时重排版；
  右栏可编辑，防抖解析，合法 → 反向刷新画布，非法 → 行内红提示、画布不动
- 保存仍走 PUT（服务端 validate_spec 兜底），400 详情行内展示
- 列表/运行面板不动；旧 JSON-textarea 编辑器被画布+侧栏取代（速查卡并入侧栏下方）
