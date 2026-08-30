---
type: course-plan
status: active
last_updated: 2026-08-15
tags: [28-day, project-based-learning, full-stack, agent, leetcode]
---

# 03｜28 天项目制课程：边复习 AinOne，边补齐全栈 + Agent

## 目标与节奏

每天建议 `2.5–3.5 小时`：

- `45 分钟`：读当天真实源码，画调用关系。
- `45 分钟`：补底层知识，不泛读整本教程。
- `45–75 分钟`：做一个测试、实验或小型重构设计。
- `30–45 分钟`：LeetCode/现场题。
- `15 分钟`：用面试问题口述复盘并更新证据库状态。

课程不要求第一遍就改生产代码。默认顺序是：我先解释完整代码与不变量 → 你预测行为 → 运行最小实验 → 你口述 → 再决定是否提交修改。

## 课程总览

| 课程 | 天数 | 真实项目主线 | 结束时能回答 |
|---|---:|---|---|
| C0 项目认领与架构 | 1–2 | 四服务、两启动路线、三数据链 | “你的项目到底是什么、你做了什么” |
| C1 Python 实时数据内核 | 3–5 | Serial/BLE/UDP、Queue、RingBuffer、50 Hz | 线程/协程、生产者消费者、数据结构 |
| C2 FastAPI 与录音后端 | 6–9 | REST/WS、Pydantic、CSV/WAV、异常与状态 | API 设计、网络协议、持久化、一致性 |
| C3 React 实时前端 | 10–13 | Router、Zustand、AppBridge、rAF、回放 | React/TS、渲染、WS/SSE、性能 |
| C4 Agent 流式调用链 | 14–17 | Hono → FastAPI → worker → NDJSON → React | 工具调用、流式协议、审批、中断、会话 |
| C5 RAG 与 Memory | 18–20 | Chroma、chunk、top-k、JSONL、评测 | RAG 调参、记忆、检索评测、Trace |
| C6 Workflow/Multi-Agent/安全 | 21–24 | workflow 节点、HITL、authz、MCP/Skills | ReAct/Plan、状态流、越权与失败处理 |
| C7 工程化与面试闭环 | 25–28 | 测试、启动、CI、部署、可观测性 | 系统设计、项目拷打、现场编码 |

---

# C0｜项目认领与架构（Day 1–2）

## 学习场景

把“这是 Vibe Coding 出来的项目”转化为可信表达：不否认 AI 辅助，但你必须能认领需求、数据流、取舍、验证和边界。

### Day 1：四服务与代码地图

**读代码**

- `README.md`
- `start.bat`、`start_agent.bat`
- `backend/run.py`
- `backend/app/main.py`
- `backend/agent_service/main.py`
- `backend/agent_gateway/app.ts`
- `frontend/src/main.tsx`、`App.tsx`

**任务**

1. 不看文档，手画 8080/8100/3000/5173 和代理方向。
2. 解释旧 Claude SDK 路线和自研 Agent 路线为何并存。
3. 找出 venv 实际导入的 Agent 框架路径，并说明它是外部 editable dependency。
4. 把每个服务的“输入、状态、输出、失败方式”各写一句。

**产物**：一张手绘架构图 + 90 秒项目介绍录音。

**面试题**：PA01、PA02、PA03、PA04、HF01、HF02。

**算法**：两数之和；重点练“输入/输出/复杂度/边界”表达。

### Day 2：证据边界与 3/10/30 分钟讲法

**读代码/历史**

- `git log --oneline`
- `docs/specs/main-spec.md`
- `backend/agent_service/README.md`
- `docs/agent-migration-sod/`
- `frontend/src/features/doctor-evaluation/README.md`

**任务**

1. 列出 `已实现 / 部分实现 / 旧文档 / 未实现 / 需运行验证`。
2. 找出 RAG README 漂移、`delegate` 占位、医生评估冻结数据边界。
3. 分别准备 3 分钟项目介绍、10 分钟架构讲解、30 分钟源码深挖目录。
4. 回答“AI 帮你写了多少，你如何保证正确性”：用审计、测试、提交、故障复盘回答，不回避。

**产物**：`项目答辩事实表`，后续每门课追加。

**面试题**：PA02、PA05、OE03。

**算法**：LC56 合并区间。

**课程验收**

- 能指出任何一个页面请求会经过哪些服务。
- 能说清上游借鉴部分、自研部分和当前外部依赖。
- 不把设计文档或演示数据说成运行验证。

---

# C1｜Python 实时数据内核（Day 3–5）

## 学习场景

你不是抽象地学 Python 并发，而是解释“为什么设备线程不能直接 await WebSocket，以及 50 Hz 数据如何安全进入浏览器”。

### Day 3：Bridge 与生产者—消费者

**读代码**

- `backend/app/core/serial_bridge.py`
- `backend/app/core/ble_bridge.py`
- `backend/app/core/audio_bridge.py`
- `backend/app/services/connection_manager.py` 的 callbacks 与 queue

**补知识**

- 进程/线程/协程、GIL、阻塞 IO、daemon thread。
- Queue 的 put/get、线程安全、无界队列风险。
- TCP/UDP、Serial、BLE notify 的差异。

**实验**

1. 不连硬件，写一个假 bridge，每 5 ms 产生一帧。
2. 把消费者减慢到 50 ms，观察队列增长。
3. 设计三种背压策略：阻塞生产者、丢最旧、只保留最新。

**面试题**：BE01、BE02、HF11。

**算法**：合并两个有序数组；双指针不变量。

### Day 4：Ring Buffer、解析与统计

**读代码**

- `backend/app/core/data_processor.py`
- `backend/app/models/schemas.py`

**补知识**

- `deque(maxlen)`、数组/链表、摊还复杂度。
- 锁粒度、嵌套锁、数据竞争。
- 流式均值、min/max、异常值与缺失值策略。

**实验/测试**

为 `DataProcessor` 设计六组用例：表头、无表头、短包、宽包、非法值、超过 16 通道。讨论当前把非法值变成 `0.0` 会产生什么研究风险。

**面试题**：PA03、OE03。

**算法**：滑动窗口最小长度子数组；联系 Ring Buffer。

### Day 5：线程到 asyncio/WebSocket

**读代码**

- `backend/app/services/websocket_manager.py`
- `backend/app/api/websocket.py`
- `ConnectionManager._data_loop()` 与 `schedule_broadcast()`

**补知识**

- asyncio event loop、线程安全调度、future。
- WebSocket 建联、心跳、广播、慢客户端与背压。

**实验**

画出 `hardware thread → queue → poll thread → event loop → client` 时序图；设计一个慢客户端测试，说明当前广播池的风险。

**面试题**：FS01、FS03、BE01。

**算法**：Top-K + heap；联系 RAG top-k。

**课程验收**

- 能回答“为什么不全用 asyncio”。
- 能手写 Ring Buffer 和生产者—消费者简化版。
- 能指出当前无界队列、日志频率和坏包策略风险。

---

# C2｜FastAPI、协议与录音后端（Day 6–9）

## 学习场景

围绕一次“开始录制 30 秒并生成 CSV/WAV”请求，补齐 API、协议、文件持久化和可靠性。

### Day 6：FastAPI 基础不是背装饰器

**读代码**

- `backend/app/main.py`
- `backend/app/api/serial.py`、`ble.py`、`audio.py`
- `backend/app/models/schemas.py`

**补知识**

- ASGI、lifespan、router、middleware、Pydantic、OpenAPI。
- 4xx/5xx、校验错误、同步/异步 endpoint。

**任务**

为 Serial、BLE、Audio 三组 API 做契约表；指出哪些错误被吞掉、哪些能被前端区分。

**面试题**：BE03、PA03。

**算法**：二分左右边界。

### Day 7：录音状态机与文件一致性

**读代码**

- `backend/app/services/recording_service.py`
- `backend/app/api/recording.py`
- `backend/app/api/recordings.py`
- `frontend/src/store/index.ts` 的 recording 状态机

**补知识**

- 状态机、幂等、竞态、原子写、sidecar metadata。
- 数据库事务概念与文件落盘差异。

**任务**

1. 画开始、运行、自动停止、手动停止、失败五态。
2. 解释前端为什么不把后端心跳当倒计时权威。
3. 设计崩溃在“CSV 已写、WAV 未写”时的恢复方案。

**面试题**：BE05、BE06、OE03。

**算法**：股票买卖；先口述状态和边界。

### Day 8：协议选型与断线语义

**读代码**

- `frontend/src/api/websocket.ts`
- `frontend/src/api/client.ts`
- `frontend/vite.config.ts`
- `frontend/src/hooks/useLiveOwner.ts`

**补知识**

- HTTP、SSE、fetch streaming、WebSocket。
- TCP/UDP、重连、指数退避、幂等请求。

**任务**

1. 解释 `/api/live` 客户端存在但 Vite 缺代理的真实缺口。
2. 设计手动关闭不重连、网络断开自动重连的状态机。
3. 比较传感器、Agent 文本、Diary 三种流的最佳协议。

**面试题**：FS01、FS02、FS03、S13 相关问题。

**算法**：LC33 搜索旋转数组。

### Day 9：数据、缓存和部署设计题

**读代码**

- `backend/agent_service/authdb.py`
- `backend/agent_service/run_history.py`
- `backend/agent_service/sessions.py`
- `backend/app/config.py`

**补知识**

- SQLite、B+ 树、事务、索引。
- Redis 常见结构、big key、缓存一致性。
- 文件/JSONL/SQLite/Redis 的适用边界。

**任务**

只做设计，不迁移：为 patient/session/recording/workflow run 画表结构和索引，说明哪些仍应保留文件。

**面试题**：BE04、BE05、BE06、HF12。

**算法**：LC19 删除链表倒数第 N 个节点。

**课程验收**

- 能解释 FastAPI 的运行模型与协议边界。
- 能画录音状态机并处理崩溃恢复。
- 能诚实回答“为什么目前没 Redis/K8s”。

---

# C3｜React + TypeScript 实时前端（Day 10–13）

## 学习场景

不用另做 Todo List，直接解释为什么这个前端能承受高频传感器帧、跨页面录制和 Agent 流。

### Day 10：Router、Context 与角色

**读代码**

- `frontend/src/main.tsx`
- `frontend/src/App.tsx`
- `frontend/src/contexts/RoleContext.tsx`
- `frontend/src/lib/rolePolicy.ts`
- `frontend/src/lib/authToken.ts`

**补知识**

- 组件、props/state、Context、Router、受保护路由。
- localStorage/sessionStorage、XSS 风险、前后端授权区别。

**任务**

画 patient/doctor/developer 登录后的路由和 API 权限矩阵；解释 UI 隐藏为什么不等于服务端鉴权。

**面试题**：SC01、PA03。

**算法**：二叉树层序遍历。

### Day 11：Zustand 与单一事实源

**读代码**

- `frontend/src/store/index.ts`
- `frontend/src/store/chatStore.ts`
- `frontend/src/store/diaryStore.ts`

**补知识**

- 不可变更新、selector、状态机、派生状态。
- 闭包过期、竞态与心跳校准。

**任务**

用状态转移表解释 recording；为“开始后收到旧 false 心跳”写测试用例。

**面试题**：FS04、OE03。

**算法**：LC146 LRU Cache；联系 session/cache 生命周期。

### Day 12：AppBridge 与渲染性能

**读代码**

- `frontend/src/components/AppBridge.tsx`
- `frontend/src/components/channels/ChannelGrid.tsx`
- `frontend/src/components/channels/WaveformChart.tsx`
- `frontend/src/components/replay/ReplayPanel.tsx`

**补知识**

- 浏览器 event loop、rAF、React batching、Fiber/reconciliation。
- 高频数据“保最新而不是全渲染”的产品取舍。

**实验**

对比每帧 setState 与 rAF 合并；记录渲染次数和主线程响应。解释 replay gate 如何避免双写。

**面试题**：FS04、S14 React/Fiber 问题。

**算法**：节流与防抖手写；再做 LC56 复盘。

### Day 13：流式 UI 与错误体验

**读代码**

- `frontend/src/hooks/useStreamParser.ts`
- `frontend/src/api/claudeApi.ts`
- `frontend/src/components/chat/ChatMessages.tsx`
- `frontend/src/components/BackendGate.tsx`

**补知识**

- `ReadableStream`、TextDecoder、跨 chunk 分行、AbortController。
- loading/error/empty/retry、可访问性。

**任务**

1. 手写 30 行 NDJSON reader，必须正确处理半行。
2. 解释为什么 `BackendGate` 在自研模式漏了 8100 健康检查。
3. 设计模型慢、网关断、浏览器取消三种不同提示。

**面试题**：FS02、BE06。

**算法**：LC23 合并 K 个有序链表。

**课程验收**

- 能讲 React 渲染与事件循环，不只会写 Hooks。
- 能手写流解析、节流、防抖和重连状态机。
- 能指出前端哪些状态是服务端权威、哪些是本地显示权威。

---

# C4｜Agent 流式调用链（Day 14–17）

## 学习场景

完整跟踪一次“请读取最近录音并分析”的请求，不跳过 Hono、线程桥、工具结果和前端气泡。

### Day 14：Hono 兼容网关

**读代码**

- `backend/agent_gateway/app.ts`
- `backend/agent_gateway/handlers/chat.ts`
- `backend/agent_gateway/handlers/permission.ts`
- `backend/agent_gateway/handlers/abort.ts`

**补知识**

- BFF/网关/反向代理、CORS、stream passthrough、取消传播。
- 为什么迁移时保协议兼容比同时重写前端风险低。

**任务**

列出被保留、被丢弃的请求字段；讨论“静默丢弃 legacy 字段”何时会成为兼容性风险。

**面试题**：PA03、FS02、TL01。

**算法**：字符串去重并保持相对顺序/字典序，练澄清约束。

### Day 15：同步 Agent 到异步 HTTP

**读代码**

- `backend/agent_service/main.py` 的 `_chat_response`
- `backend/agent_service/bridge.py`
- `backend/agent_service/wire.py`

**补知识**

- worker thread、queue、generator、锁、取消与清理。
- backpressure、客户端断连、finally 语义。

**任务**

画 worker/HTTP generator/permission POST 三方时序图；回答“abort 能否中断正在等待的底层模型 HTTP 调用”。

**面试题**：TL04、FS02、BE01。

**算法**：LC301 删除无效括号。

### Day 16：AgentFactory 与 Tool Calling

**读代码**

- `backend/agent_service/factory.py`
- `backend/agent_service/agent_tools.py`
- 外部 `AgentFramework_build/project/agent/tools/registry.py`
- 外部 `AgentFramework_build/project/agent/tools/executor.py`

**补知识**

- tool schema、参数校验、并行工具、副作用、HITL。
- Function Calling/MCP/Skills 的分层。

**任务**

选 `read_file`、`write_file`、`list_recordings` 三个工具，逐步解释 schema、权限、执行、错误回填；设计一个 prompt injection 攻击用例。

**面试题**：TL01、TL02、TL03、TL04、TL05、SC01。

**算法**：哈希表 + 双链表复写 LC146，不看答案。

### Day 17：Session、Audit 与 Resume

**读代码**

- `backend/agent_service/sessions.py`
- `backend/agent_service/authz.py`
- 外部 AgentFramework 的 `AuditLog`、`Agent.resume`

**补知识**

- session ID、互斥、TTL、持久化、幂等、审计。
- 历史中 tool call 与 tool result 的协议完整性。

**任务**

解释 `repair_history()`；设计并发请求同一 session、进程重启、患者越权读取三个测试。

**面试题**：MR01、MR02、OE01、SC02。

**算法**：重排链表或链表区间反转。

**课程验收**

- 能从 React 请求讲到 LLM/tool，再讲回 UI。
- 能解释兼容协议、锁、审批、abort、resume 的真实实现。
- 不把“浏览器断流”误说成“底层模型一定停止”。

---

# C5｜RAG、Memory 与评测（Day 18–20）

## 学习场景

把当前 RAG 从“能调用”升级成“能测、能解释、知道什么时候不该用”。

### Day 18：RAG 入库与检索

**读代码**

- `backend/agent_service/rag.py`
- `backend/agent_service/main.py` 的 RAG endpoints
- 外部 `agent/retrieval/store.py`、`tools.py`、`embedder.py`

**任务**

1. 用 3–5 份本项目文档建立小 collection。
2. 记录 chunk、source replacement、embedding 和 top-k 流程。
3. 准备 10 个 gold 问题及相关 chunk ID。

**面试题**：RG01、RG02、RG03。

**算法**：Top-K/heap + 二分边界复盘。

### Day 19：检索实验与失败分析

**补知识**

- cosine/dot/L2、BM25、hybrid retrieval、rerank。
- Recall@k、Precision@k、MRR、faithfulness。

**实验**

比较至少三组 chunk/overlap/top-k；逐条记录“召回错、切片错、排序错、上下文拼接错、生成错”。不接 reranker 也要写出为什么暂不接。

**面试题**：RG02、RG04、RG06、OE03。

**算法**：编辑距离 LC72。

### Day 20：Memory、上下文与成本

**读代码**

- `backend/agent_service/sessions.py`
- `backend/agent_service/factory.py`
- 外部 `agent/core/memory/`
- `backend/agent_service/config_store.py`

**任务**

1. 画 System/Memory/RAG/Tool/Conversation 的上下文布局。
2. 设计压缩策略：保留最近轮次、保留工具配对、摘要旧文本、原文仍持久化。
3. 设计记忆冲突 schema：value/source/timestamp/confidence/status。
4. 估算一次长对话的 token 来源并提出优化顺序。

**面试题**：MR01–MR05、MD01、MD02、RG05。

**算法**：LC416 分割等和子集。

**课程验收**

- 有一份真实小数据集和检索指标，不只会背流程。
- 能区分 Memory、RAG、Audit、Context。
- 能说明当前上下文压缩尚未完整落地。

---

# C6｜Workflow、Multi-Agent 与安全（Day 21–24）

## 学习场景

拆解 `followup_review`，理解多 Agent 不是“多调用几次模型”，而是状态、控制流、失败与权限系统。

### Day 21：Workflow 引擎

**读代码**

- 外部 `AgentFramework_build/project/agent/orchestration/workflow.py`
- `backend/agent_service/workflows_admin.py`
- `backend/agent_service/main.py` workflow endpoints

**任务**

逐个运行/模拟 `agent`、`loop`、`break_if`、`parallel`、`route`、`human`；画变量池变化和事件序列。

**面试题**：AG03、AG04、AG05。

**算法**：图 DFS/BFS；把 workflow 当有向图。

### Day 22：Multi-Agent 状态、路由与评测

**读代码**

- `backend/agent_service/run_history.py`
- `frontend/src/components/chat/ChatWorkflowPanel.tsx`
- `frontend/src/components/settings/WorkflowCanvas.tsx`

**任务**

1. 解释同名 Agent 在一次 run 中为何复用实例。
2. 设计 `delegate` 真正实现的 task contract，但标记为设计稿。
3. 定义 workflow 评测：完成率、步骤失败、循环次数、成本、人工等待、输出正确性。

**面试题**：AG06、AG07、OE02。

**算法**：拓扑排序 + 检测环；联系工作流循环合法性。

### Day 23：MCP、Skills 与渐进披露

**读代码**

- `backend/agent_service/mcp_admin.py`
- `backend/agent_service/skills_admin.py`
- `backend/agent_service/factory.py` 的挂载流程

**任务**

画 Function Calling、MCP、Skill 三层图；设计 100 个工具时的检索/路由方案；说明 MCP server 失败如何隔离。

**面试题**：TL02、TL03、TL04、SC02。

**算法**：前缀树或哈希检索；联系工具发现。

### Day 24：Authz、Prompt Injection 与医疗边界

**读代码**

- `backend/agent_service/authz.py`
- `backend/agent_service/authdb.py`
- `frontend/src/lib/authToken.ts`
- `backend/app/api/live.py`
- `backend/agent_service/config.py` 的系统提示

**任务**

1. 画身份、角色、资源、操作权限矩阵。
2. 做 threat model：提示注入、越权、路径穿越、secret、恶意文件、跨患者数据。
3. 区分 UI guard、API authz、数据归属、工具审批四层。
4. 解释为什么 prompt 中“不可诊断”不是唯一医疗安全措施。

**面试题**：SC01、SC02、BE06。

**算法**：最短路径 Dijkstra；练场景建模。

**课程验收**

- 能讲清 ReAct 与 Workflow 的混合使用。
- 能说明 multi-agent 的状态、成本和失败，而非只说角色分工。
- 能做一版可执行威胁模型。

---

# C7｜工程化、系统设计与模拟面试（Day 25–28）

## 学习场景

把“能跑的研究原型”收束成“可验证、可复现、能被面试官追问”的项目。

### Day 25：测试金字塔

**任务**

按 `01-gap-checklist.md` 先写测试计划，再实现最小基线：

- Python：DataProcessor、PermissionBroker、wire、session。
- TypeScript：NDJSON parser、AppBridge 状态、workflow utils。
- 契约：8080/8100/3000 的无模型 health/shape。

真实 LLM 与硬件测试单独标记为 integration，不混入快速单测。

**面试题**：OE02、OE03、PA05。

**算法**：45 分钟模拟：数组 + 链表各一题。

### Day 26：启动、配置与 CI

**任务**

1. 设计 `install` 与 `start` 分离的一键入口。
2. 加端口、版本、venv、editable dependency、密钥预检。
3. 设计 CI 顺序：Python unit → Agent unit → Gateway test/typecheck → Frontend build/test。
4. 讨论 Docker 对 USB/BLE/UDP 的限制；只容器化合适的层。

**面试题**：PA04、BE06、HF12。

**算法**：45 分钟模拟：二分 + DP。

### Day 27：可观测性与系统设计

**任务**

1. 定义结构化日志字段和四服务 trace ID 传播。
2. 定义实时链与 Agent 链 SLI/SLO。
3. 设计队列限长、LLM 超时、工具熔断、模型降级、断线恢复。
4. 系统设计题：如果从单机研究平台扩到 100 个患者设备，哪些组件先拆、哪些不拆。

**面试题**：OE01、OE02、BE06、TL04、HF13。

**算法**：LRU + Top-K 口述复杂度。

### Day 28：完整模拟面试与下一轮计划

**90 分钟模拟结构**

1. 5 分钟自我介绍与项目价值。
2. 20 分钟四服务架构与一条数据链。
3. 20 分钟 Agent/RAG/Memory/MCP 深挖。
4. 15 分钟 React/FastAPI/并发/网络。
5. 20 分钟现场编码。
6. 10 分钟缺口、取舍和下一步。

**最终产物**

- 更新 `01-gap-checklist.md` 勾选状态。
- 给 `02-interview-evidence-log.md` 首批 20 题增加“模拟通过/需复习”。
- 一份项目简历描述：3 条 bullet，每条都有动作、难点、结果/证据；没有指标就不编数字。
- 下一轮 14 天计划只选择模拟中暴露的 3 个最大缺口。

**算法**：随机抽取面经证据表一题，完整运行、测试、讲复杂度。

**课程验收**

- 项目介绍、系统设计、源码追问、算法四项都有可复核产物。
- 面对不会的问题会先确认边界、给已知部分和验证方案，不用术语硬撑。

---

# 每次跟我上课时的固定格式

后续可以直接对我说：`开始 C1 Day 3`。我会按以下顺序带你走：

1. 先问 3 个预测题，确认你当前理解。
2. 按调用顺序解释当天完整源码，而不是只解释片段。
3. 让你用自己的话复述数据流和不变量。
4. 做一个最小可运行实验或测试；必要时再改代码。
5. 用证据库中的真实问题追问 10–15 分钟。
6. 做当天算法题并检查边界、复杂度和口述。
7. 把结果回填到清单与学习日志。

# 最快启动建议

如果只想先快速进入状态，第一周按 `Day 1 → Day 3 → Day 5 → Day 10 → Day 14 → Day 16 → Day 18` 跳读；它能在 7 天内覆盖架构、并发、WebSocket、React、Agent 流、Tool Calling 和 RAG。之后再回补录音、数据库、Workflow、安全与工程化。
