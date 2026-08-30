---
type: checklist
status: active
last_updated: 2026-08-15
tags: [gap-analysis, full-stack, agent, interview-prep]
---

# 01｜全栈 + Agent 补齐清单

## 怎么勾选

- `[ ]`：不会独立解释或没有证据。
- `[~]`：代码存在，但只能跟着代码说，不能从零讲清。
- `[x]`：能白板讲清、能指出项目文件、能回答取舍与故障场景，并有测试/实验记录。

优先级：`P0` 直接影响项目可信度和 Agent 全栈面试；`P1` 决定二面深度；`P2` 是后续工程化；`D` 暂缓，不为堆技术而做。

## A. 已有实现，但必须补成“自己的知识”

### A1. Python、并发与实时数据（P0）

- [~] 解释 `threading.Thread`、`asyncio`、进程、协程的区别，并说明本项目为什么硬件读取用线程、HTTP/WebSocket 用事件循环。
- [~] 解释生产者—消费者、线程安全 `queue.Queue`、`threading.Event`、互斥锁和 GIL 对本项目的实际影响。
- [~] 手写简化版固定长度 Ring Buffer，并说明 `deque(maxlen=n)` 的复杂度。
- [ ] 分析 `_data_queue`/`_broadcast_queue` 无上限时的内存风险，设计丢旧保新或限长策略。
- [ ] 解释 50 Hz 数据产生、浏览器刷新率和 `requestAnimationFrame` 合并更新之间的关系。
- [ ] 用一张时序图讲清 Serial/BLE/UDP → Queue → DataProcessor → asyncio loop → WebSocket。

**项目证据**：`backend/app/services/connection_manager.py`、`backend/app/core/data_processor.py`、`frontend/src/components/AppBridge.tsx`。

### A2. FastAPI 与 API 设计（P0）

- [~] 解释 FastAPI lifespan、router、中间件、Pydantic 校验和 OpenAPI 的职责。
- [~] 解释普通 JSON 响应、`StreamingResponse`、WebSocket 三种通信方式的生命周期差异。
- [ ] 能说明同步 worker 如何安全桥接到异步流，以及客户端断连后哪些线程仍可能继续运行。
- [ ] 能设计统一异常模型、错误码、request ID 和跨服务传播规则。
- [ ] 能解释幂等、超时、重试、取消、熔断分别解决什么问题，不能把它们混成一个“重试机制”。
- [ ] 为 `/api/serial`、`/api/recording`、`/api/agent/chat` 各写一个输入/输出/错误契约表。

**项目证据**：`backend/app/main.py`、`backend/agent_service/main.py`、`backend/agent_service/bridge.py`。

### A3. React + TypeScript（P0）

- [~] 解释组件、props/state、Hooks、effect 清理、Context、Zustand 的边界。
- [~] 解释为什么全局 WebSocket 放在 `AppBridge`，而不是放在会随路由卸载的 Dashboard。
- [~] 解释 `requestAnimationFrame` 合并更新、闭包过期、StrictMode 双挂载问题。
- [ ] 能讲 React 渲染、reconciliation、Fiber、自动批处理和事件循环如何影响实时图表。
- [ ] 能比较 `fetch` streaming、SSE、WebSocket，并为传感器流、Agent 文本流、Diary 事件分别选型。
- [ ] 能实现并解释防抖、节流、`AbortController`、断线重连和指数退避。
- [ ] 能说明 TypeScript 联合类型如何保证 `WSMessage` switch 分发安全，并补一个穷尽检查示例。

**项目证据**：`frontend/src/App.tsx`、`AppBridge.tsx`、`api/websocket.ts`、`hooks/useStreamParser.ts`、`store/index.ts`。

### A4. Agent 核心链（P0）

- [~] 解释 Agent、Workflow、Chain 的区别，并用本项目说明什么时候需要动态循环，什么时候声明式工作流更合适。
- [~] 解释一次 tool call 从 schema 暴露、模型选择、参数解析、审批、执行到 tool result 回填的全链路。
- [~] 解释 `PermissionBroker` 为什么使用 `threading.Event`，超时为何默认拒绝。
- [~] 解释会话短期上下文、JSONL 审计持久化、进程重启 resume 之间的区别。
- [ ] 说明工具失败、模型超时、客户端断连、用户 abort、历史不完整分别如何处理；指出现有实现仍缺什么。
- [ ] 能回答“为什么不用 LangChain/LangGraph”，并给出自研框架的收益、维护成本和适用边界。
- [ ] 为当前 Agent 链画一张事件序列图，并标出同步/异步/线程边界。

**项目证据**：`backend/agent_service/factory.py`、`sessions.py`、`bridge.py`、`wire.py`、`agent_gateway/handlers/chat.ts`。

### A5. RAG、Memory、MCP、Skills 与 Workflow（P0）

- [~] 解释 collection → chunk → embedding → Chroma → top-k 的现有实现。
- [ ] 用当前录音/研究文档构造 10 个小问题，记录 Recall@k、Precision@k、MRR 与失败案例。
- [ ] 实验 `chunk size`、overlap、top-k 至少三组配置，不能只说“经验调参”。
- [ ] 比较向量检索、关键词检索、混合检索和 rerank；明确当前平台实际做了什么、没有做什么。
- [ ] 区分 conversation context、长期 memory、RAG knowledge 和 audit log，说明哪些内容不应互相替代。
- [~] 解释 Function Calling、MCP、Skills 三者边界和渐进式披露。
- [~] 解释 `agent/loop/break_if/parallel/route/human` 节点及 `followup_review` 的变量流。
- [ ] 明确 `delegate` 仍是占位，设计真正委派时的任务 ID、状态、超时、循环上限和结果合并契约。

**项目证据**：`backend/agent_service/rag.py`、`mcp_admin.py`、`skills_admin.py`、`workflows_admin.py`、外部 `AgentFramework_build/project/agent/orchestration/workflow.py`。

## B. 第 1 周必须处理的工程缺口

### B1. 文档与运行事实同步（P0）

- [ ] 更新根 `README.md` 的四服务架构和两条启动路线。
- [ ] 修正 `backend/agent_service/README.md` 中“RAG 501 占位”的过时描述。
- [ ] 把 `docs/specs/main-spec.md` 的更新时间和 Agent/角色/医生评估边界同步到当前实现。
- [ ] 生成一份可执行的首次安装步骤，不依赖口头记忆。
- [ ] 记录每个外部来源/改造来源，说明 `agent_gateway` 与上游 `claude-code-webui` 的关系。

### B2. 已确认的代理与启动缺口（P0）

- [ ] 给 Vite 增加 `/api/live` → `127.0.0.1:8080` 代理；当前 `liveApi` 会请求该路径，但 `vite.config.ts` 没有对应规则。
- [ ] 自研模式下让 `BackendGate` 同时探测 `:8100 /api/agent/health`；当前只检查 8080 和 3000。
- [ ] 让 `start_agent.bat` 在启动前检查 Python venv、Agent editable install、Node 版本、依赖和端口占用。
- [ ] 避免每次 `start.bat` 都无条件 `npm install`；改成显式安装与快速启动分离。
- [ ] 去掉 `agent_service/requirements.txt` 对固定绝对路径的安装说明，改为可配置或 workspace 安装脚本。

### B3. 测试基线（P0）

- [ ] 为 `DataProcessor` 增加：表头、短包、宽包、非法值、max_channels、reset 测试。
- [ ] 为 `ConnectionManager` 增加队列排空、断连后不播旧帧、录制状态测试。
- [ ] 为 Agent `PermissionBroker`、Abort、同 session 409、resume、wire NDJSON 增加无模型单测。
- [ ] 修正 `agent_service/smoke_test.py` 仍期待“RAG 501”的过时断言。
- [ ] 给前端增加 Vitest/React Testing Library 基线；当前 `frontend/package.json` 没有 `test` 脚本。
- [ ] 测试 `AppBridge` 高频帧合并、replay gate、录制定时状态机和 WebSocket 重连。
- [ ] 增加一条不调用真实 LLM 的四服务契约测试。

## C. 第 2–4 周补齐的全栈工程能力

### C1. 网络与协议（P1）

- [ ] TCP 三次握手/四次挥手、可靠传输、拥塞控制；UDP 丢包/乱序；WebSocket Upgrade。
- [ ] SSE、fetch streaming、NDJSON、WebSocket 的分帧、重连、保活、反向代理缓冲问题。
- [ ] 设计消息 schema 版本号、序列号、设备时间戳、校验和和丢包统计。
- [ ] 为 WebSocket 重连增加指数退避、抖动、最大重试和“手动关闭不自动重连”语义。

### C2. 数据库、缓存与一致性（P1）

- [ ] SQLite 表、索引、事务、隔离级别、迁移；解释当前 `patients.db` 的适用上限。
- [ ] B/B+ 树、复合索引、慢查询、分页、N+1。
- [ ] Redis 基础数据结构、缓存穿透/击穿/雪崩、big key、缓存一致性。
- [ ] 设计把 sessions/recordings/workflow runs 从 JSON/JSONL 迁移到数据库时的 schema 与回滚方案，但先不盲目迁移。
- [ ] 解释幂等键、乐观锁和“Redis 成功、数据库失败”的一致性处理。

### C3. 可观测性与可靠性（P1）

- [ ] 把高频 `print` 与 50 Hz 广播日志改为分级、可采样的结构化日志设计。
- [ ] 设计跨 5173/3000/8100/8080 的 `request_id/session_id/run_id/patient_id` 关联规则。
- [ ] 定义 Agent 指标：首 token 延迟、总时延、工具成功率、审批等待、token/成本、任务完成率、循环次数。
- [ ] 定义实时链指标：包速率、队列深度、丢帧数、WS 客户端数、写盘耗时。
- [ ] 设计超时、重试、熔断、降级和人工接管状态机，并区分可重试与不可重试错误。

### C4. 安全与隐私（P1）

- [~] 解释 localhost 默认绑定、角色 token、字段级过滤和工具文件白名单。
- [ ] 对 8080 硬件/录音 API 增加与角色系统一致的服务端授权设计。
- [ ] 为 Prompt Injection、工具参数注入、路径穿越、越权访问、secret 泄漏建立威胁模型。
- [ ] 明确患者数据保留、删除、导出和审计策略；研究原型也不能混淆隐私边界。
- [ ] 高风险工具加入 schema 校验、审批、最小权限和审计记录，不只依赖 system prompt。

### C5. 部署与协作（P1）

- [ ] 增加根级 `dev/install/test` 命令或统一脚本。
- [ ] 增加 Docker/Compose 或说明为什么硬件接入暂不容器化，并拆分可容器化服务。
- [ ] 增加 CI：Python 单测、TypeScript typecheck、Gateway test、Frontend build。
- [ ] 增加 `.env` 校验、secret 示例和配置优先级说明。
- [ ] 学会 Git 小步提交、分支、PR 描述、回滚和对脏工作区的安全处理。

## D. 算法与计算机基础补齐

### D1. Hot 100 主线（P0，持续 28 天）

- [ ] 数组/双指针：两数之和、合并有序数组、三数之和、盛水。
- [ ] 区间：LC56 合并区间。
- [ ] 链表：LC19、LC23、LC146、反转/分组反转、重排链表。
- [ ] 二分：旋转数组 LC33、左右边界、搜索二维矩阵。
- [ ] 树：层序遍历、递归/迭代 DFS、最近公共祖先。
- [ ] 动态规划：股票、LC72 编辑距离、LC416 分割等和子集。
- [ ] 图：BFS/DFS、拓扑排序、Dijkstra；能映射到工作流图和路由。
- [ ] 堆/Top-K：把 RAG top-k 与 heap 复杂度联系起来。

### D2. 口述标准（P0）

- [ ] 每题先说输入/输出/边界，再说暴力解法、优化不变量、复杂度、测试用例。
- [ ] 不背代码；能解释为什么成立，并手写 3 个边界用例。
- [ ] 每周至少一次 45 分钟无 AI 模拟笔试。

## E. 暂缓项

- [ ] `D` 不为了“像大厂”立刻引入 Kubernetes、Kafka、Redis Cluster；先补测试、协议、可观测性和可复现启动。
- [ ] `D` 不把所有文件存储立即改成微服务数据库；先用容量、并发和查询需求证明迁移必要性。
- [ ] `D` 不宣称完成通用 multi-agent delegation；先完成现有 workflow 的测试和评测。
- [ ] `D` 不把医疗研究界面包装成临床产品；保持研究/演示/已验证边界。

## 28 天结束时的验收

- [ ] 3 分钟讲清项目价值，10 分钟讲清四服务架构，30 分钟经得住源码追问。
- [ ] 能独立画出设备数据链、Agent 流式链、RAG 链、工作流链。
- [ ] 至少完成 20 个无外部模型单测和 1 条四服务契约测试。
- [ ] 完成 35 道 Hot 100/同类题，其中本文面经记录题全部覆盖。
- [ ] 面经证据库每条题都能链接到项目文件、课程和自己的回答稿。
- [ ] 形成一份“已实现 / 部分实现 / 未实现 / 下一步”的项目答辩清单。
