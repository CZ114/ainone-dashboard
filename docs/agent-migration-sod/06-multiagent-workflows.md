# 06 · multi-agent 工作模式（2026-07-11 实装）

两种互补模式，都已真实 LLM 验证：

| 模式 | 适用 | 消息顺序 | 循环 |
|---|---|---|---|
| **A. 声明式工作流** | 拓扑固定/可预期的协作（流水线、反思、辩论、并行综述） | spec 里写死或 route 动态选支 | loop 组件 + break_if 条件 |
| **B. 监督者 (delegate)** | 主 agent 按需动态派活 | LLM 每轮自己决定 | 主 agent 的工具循环天然支持 |

## 模式 A：声明式工作流

引擎在 **agent 库** `agent/orchestration/`（Phase 7，core 零改动，只消费 `Agent.send()`）；
dashboard 侧存储于 `data/agent_service/workflows.json`，端点见下。

### 五种可嵌套组件

```jsonc
{"type": "agent",    "id": "draft", "agent": "writer", "prompt": "任务:\n{task}"}
// 节点处理渲染后的 prompt → 输出写入变量池 {draft}

{"type": "loop",     "id": "revise", "max_iters": 3, "steps": [...]}
// 循环子步骤; max_iters 硬上限 (引擎再封顶 20)

{"type": "break_if", "when": {"var": "review", "regex": "^\\s*APPROVED\\b"}}
// 条件命中跳出最近一层 loop; 条件三选一: contains / regex / equals

{"type": "parallel", "steps": [agent 步骤…]}
// 并发执行; 子步骤 agent 名必须互不相同 (同名共享实例会竞态, 校验直接拦)

{"type": "route",    "id": "kind", "agent": "router", "prompt": "...",
 "routes": {"音乐": [...], "医疗": [...]}, "default": "音乐"}
// 路由 agent 输出与 routes 键做包含匹配 (不分大小写) → 动态消息顺序

{"type": "human",    "id": "user_pick", "prompt": "两个方案:\n{plans}\n选哪个?"}
// 人机协同 (2026-07-11 加, 第六组件): 渲染 prompt → 暂停等真人回答 → 答案入变量池。
// 只在流式接口可用 (/stream 发 human_input_required + input_id, 前端
// POST /api/agent/workflows/input {id, value} 续跑, 600s 超时);
// 阻塞式 /run 遇到直接 400。示例: plan_confirm (已入库, UI 实测通过)
```

顶层：`{id, name, description, inputs: ["task"], output: "{draft}", steps: [...]}`
（output 缺省 = 最后一个 agent 步骤输出）

### 关键语义

- **节点生命周期**：同一次 run 里每个 agent 名只实例化一次、跨轮次保留对话历史
  ——辩论第 3 轮的 critic 记得它前两轮说过什么。节点由 `build_agent(name)` 注入
  （dashboard 用 oneshot 构造：无文件工具；**挂知识库的节点自动带 retrieve**）。
- **模板**：`{name}` 取变量池（inputs + 已完成步骤 id）；未知变量报错并列出可用项；
  `{{ }}` 转义字面花括号。
- **事件流**：`workflow_start / step_start / step_end / loop_iter / loop_break /
  route_choice / workflow_end`，沿用 `Agent.stream` 的 (kind, payload) 约定。

### 端点

| 端点 | 说明 |
|---|---|
| GET/PUT/DELETE `/api/agent/workflows[/{id}]` | CRUD；存前校验 spec + 引用的 agent 必须已定义 |
| POST `/api/agent/workflows/{id}/run` `{inputs}` | 阻塞跑完 → `{output, context, trace, elapsed_ms}` |
| POST `/api/agent/workflows/{id}/stream` `{inputs}` | NDJSON 事件流 |

### 已入库示例（可直接跑/照抄）

- **reflect_write 反思循环**：writer 起草 → loop[critic 评审 → break_if `^\s*APPROVED\b` → writer 修订]。
  实测：2 轮评审、达标跳出、跳出轮不再修订。
- **dual_review 双视角并行综述**：parallel[writer 支持面 / critic 质疑面] → default 综合。

### 条件写法的坑（实测踩过）

`contains: "APPROVED"` 会被评审**意见里提到这个词**误触发——评审类节点用
**锚定 regex**（`^\s*APPROVED\b`）+ 在 critic 系统提示里声明"意见中不要出现该词"。
JSON 文件里写 `"^\\s*APPROVED\\b"`（JSON 层一次转义）。

## 模式 B：监督者（delegate 工具，已实装）

chat 主 agent 的 `delegate(agent_id, task)`：内部用 oneshot 构造子 agent 并返回
`{ok, agent, model, answer}`。子 agent 的 registry 没有 delegate → **委派深度恒为 1，
无递归风险**。在聊天 UI 里以工具气泡呈现，前端零改动。
实测：主 agent 委派 kb_helper 查知识库后正确转述 "IMU 100Hz"。

## 后续可加（暂未做）

- 工作流的前端管理/运行界面（设置页第四个 tab；API 已齐）
- step 级 token/成本统计；workflow 运行历史持久化
- 组件扩展位：`human_in_loop`（借用权限桥暂停等用户输入）、`tool` 步骤（不经 LLM 直接调工具）
