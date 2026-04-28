---
type: plan
status: active
last_updated: 2026-04-26
tags: [architecture, ad-prediction, multi-repo, integration]
---

# Lab Project — 集成架构分析与计划

**Status**: 进行中 · 由 2026-04-26 一次会话整理而成 · 后续将按章节继续细化
**Owner**: CZ114
**Scope**: 4 个仓库的整合架构（ainone-dashboard 主导 + Jewelina95 三个子项目）

---

## 1. 项目背景

### 1.1 大目标

实验室级研究项目：**辅助预测 Alzheimer's Disease (AD) 早期的 wearable 智能设备 + 平台**。

- **设备**：ESP32 可穿戴，多通道传感器数据采集（PPG / GSR / IMU / 麦克风）
- **平台**：桌面/Web 应用，三大支柱：
  1. **数据分析** — 实时可视化、录制
  2. **系统设置** — AI agent 配置、知识/数据管理
  3. **报告生成** — 用户对话 + 报告产出

### 1.2 协作分工

| 仓库 | 维护者 | 角色 |
|---|---|---|
| `CZ114/ainone-dashboard` | CZ114 + 协作开发者 | 数据看板 + AI 聊天的"主应用" |
| `Jewelina95/ad-wiki-pages` | Jewelina95 | 知识管理 + agent 定义 + 报告生成 |
| `Jewelina95/ad-mind-pipeline` | Jewelina95 | 报告生成（另一种实现路线） |
| `Jewelina95/ad-synthetic-generator` | Jewelina95 | 数据工厂（基于真实数据生成合成数据） |

---

## 2. 四个仓库现状盘点（2026-04-26 调研）

### 2.1 `ainone-dashboard` — 唯一真实可跑的产品

**3 层架构**：
- **Python FastAPI**（port 8080）— 硬件 I/O，Serial / BLE / UDP，Ring buffer 处理，WebSocket fan-out 50Hz
- **Node Hono**（port 3000）— 包装 Claude CLI（claude-agent-sdk），SSE 流式 chat，PTY 嵌入式终端
- **React + Vite**（port 5173）— `/dashboard` `/chat` `/settings` 三路由，Zustand 状态管理，Recharts 波形

**已有的关键能力**（这些是后续整合的"插座"）：
- ✅ **Extension 系统**：完整 `install / enable / start / stop / uninstall` 生命周期，SSE 进度流，原子状态文件（`extensions_state.json`），参考实现 `whisper_local.py`
- ✅ **MCP 槽**：Hono chat handler 已预留 MCP server 注册入口（已接 MiniMax）
- ✅ **Recordings 库**：CSV + WAV 双轨录制，正则白名单防路径穿越，drag-and-drop 进 chat
- ✅ **双语 voice**：Web Speech API（PC mic）+ Whisper-local extension（ESP32 UDP audio → faster-whisper）
- ✅ **嵌入式终端**：xterm.js + node-pty
- ✅ **Slash command 自动补全**

### 2.2 `ad-wiki-pages` — 是文档不是 app

- **形态**：60+ 篇 markdown + GitHub Pages 静态站 + 一个 JS-only 假 demo
- **内容**：
  - `wiki/concepts/` 22 篇 BPSD/sensor/AD 基础
  - `wiki/methods/` 9 篇方法论（含 data-pipeline、claude-cli pattern）
  - `wiki/agents/` 10 篇 agent 设计（**7/8 是 stub，连 stub 也在另一个私有仓**）
  - `wiki/synthesis/` 13 篇综述 + 3 个 docx
  - `wiki/datasets/` 5 篇数据集描述（无实际数据）
- **每篇 markdown 都有 YAML front-matter**：`title, type, last_updated, sources, status ∈ {settled, draft, working_hypothesis, open_question}`
- **真实可用度**：**零运行代码**。README 自己声明 "Implementation code ❌ not in this mirror"。整个仓 14 commits 全在 2026-04-25 一天内。
- **架构文档价值**：定义了 `BaseAgent` / `AgentDataLoader` / `MultimodalFeatures, PatientProfile, ContextInfo, AgentAssessment, AlertLevel` 几个数据契约；定义了 `claude -p` CLI 子进程 inference pattern。
- **5 个公开 open question**：
  1. 合成数据可能不忠实于 AD 真实进展
  2. 西方 BPSD 证据不一定泛化到中国社区 AD
  3. 7/8 agent 还是 stub
  4. 可穿戴和临床数据集是不相交的患者集（无标注的真实 AD wearable 数据）
  5. 手套硬件未制造，只有 ESP32 音频原型

### 2.3 `ad-mind-pipeline` — 能跑但跑不起来

- **形态**：8 个编号 Python 脚本组成的线性管道
- **依赖**：`anthropic` SDK（直接调 Claude）+ `pandas / numpy / scipy`，**无 LangChain / LlamaIndex / CrewAI**
- **管道**：`Generator → Analyzer (deterministic stats) → KnowledgeRouter → PhysioAgent + BehaviorAgent → ClinicalAgent → Narrator`
  - **stats-first**：算术全在 Python（z-score, DTC, trend, outlier）
  - **citation-strict**：LLM 输出必须是 JSON 且必带 `supporting_facts` + `knowledge_id`
- **输入**：`progression.csv, ema.jsonl, surveys.jsonl, notes.jsonl, bpsd_events.jsonl, persona.json + sensor/*.csv`（声明对齐 ad-synthetic-generator 输出）
- **输出**：`facts.json, insights_*.json, dashboard.json (~4KB widget data), report.md (~5KB)`
- **真实可用度**：
  - 只有 P01 跑通了（P02–P05 输出目录是空的）
  - **硬阻塞**：所有脚本写死 `Path("/Users/wenshaoyue/Desktop/research/AD MIND/...")`；`03_physio_agent.py` 还 `sys.path.insert` 去导入 `knowledge.knowledge_store`，**这个模块不在本仓**
  - 无 HTTP / 无 library entry / 无 notebook，只能 CLI
  - 无测试、无 CI、无 requirements.txt
- **vs ad-wiki-pages**：**互补，不重复**。这个是 stats-first 定量分析；ad-wiki-pages 路线是 knowledge-driven 定性叙述。两者并存作为"分析型 vs 叙述型"两条 backend 是合理的。

### 2.4 `ad-synthetic-generator` — 小但能用

- **形态**：单文件 Python CLI（`src/generate_synthetic.py` ~430 行），3 个 ETL 辅助脚本
- **依赖**：`numpy + pandas`（声明 scipy 但未使用），**无 ML 库**
- **方法**：rule-based 增强，不是 de novo 生成
  - 输入真实健康基线 CSV → 按 `progression ∈ [0,1]` 标量做 per-channel degradation（IMU `svm_std × (1+0.5p)`, HR `+3p bpm`, HRV `× (1-0.3p)`）
  - 注入 NaN 间隙、运动伪影、BPSD 尖峰窗口
  - EMA / surveys / notes 用同一个 `effective_progression` 驱动，保跨模态一致
- **传感器 schema**（**已对齐你的 wearable**）：
  ```
  timestamp, gsr_filtered, ppg_ir, hr_bpm_avg,
  imu_ax_mps2, imu_ay_mps2, imu_az_mps2, svm, jerk,
  hr_valid_flag, label, subject_id
  ```
  50Hz, 按 `label` (任务名) 分组
- **真实数据**：4 名受试者（zewei/junkai/jialu/zhe）× 7 任务（walking_normal / walking_dual_task / balance_standing / hand_fine_motor / sit_to_stand / turning / wandering_simulate）
- **principled 机制**：
  - MMSE 分布从真实 OpenNeuro `ds004504 + ds007427` (n=112) 抽样
  - MoCA 从 `ds006095` (n=71)
  - degradation 系数有文献引用（Buracchio 2010, Collins 2012, Iaboni 2022）
  - **caveat**：这些分布只用来抽 score 标量，**不验证生成的 sensor 是否符合真实 AD sensor 分布**（因为没有真实 AD wearable 数据）
- **真实可用度**：
  - **能跑**，已生成 ~980MB 输出 commit 在仓里
  - **硬伤**：`main()` 调 `shutil.rmtree(OUT_DIR)`，每次清空——**不能直接 on-demand 调用，必须 wrapper**
  - **缺口**：voice 模态未合成（无真实 AD 音频）
  - 无 importable API surface

### 2.5 一句话概括

**Jewelina95 三个仓全部是 2026-04-25 当天一次性落地的研究 scaffold（单作者、无测试、handoff 笔记已写好）。"集成"目前没有"被集成方"——不是架构问题，是对面还没东西。**

---

## 3. 集成架构决策

### 3.1 核心思路

**dashboard 是已经盖好的房子，另外三个仓是家电——把家电插进房子，不要再盖三栋房。**

| 仓 | 比喻 |
|---|---|
| ainone-dashboard | 一栋已装修的房子（水电气/客厅/书房齐了） |
| ad-wiki-pages | 一柜子《医学知识手册》 |
| ad-synthetic-generator | 一台"假数据发生器" |
| ad-mind-pipeline | 一台"报告打印机" |

复用 dashboard 已有的 **extension 系统**（房子墙上预留的插座）+ **MCP 槽**（chat agent 的工具接口）作为整合 host。

### 3.2 ASCII 架构图

```
                  ESP32 可穿戴设备
                       │ (Serial / BLE / UDP)
                       ▼
   ╔══════════════════════════════════════════════════════════╗
   ║       ainone-dashboard 房子 (整个系统唯一入口)           ║
   ║                                                          ║
   ║  ┌─ 前端 一个网站,按角色开不同的门 ─────────────────┐    ║
   ║  │                                                   │    ║
   ║  │  患者     → 客厅(波形)  录音室                    │    ║
   ║  │  医生     → 客厅  聊天室  报告室                  │    ║
   ║  │  研究员   → 全部 + 实验室 + 资料室                │    ║
   ║  │                                                   │    ║
   ║  └──────────────────────┬────────────────────────────┘    ║
   ║                         │                                 ║
   ║  ┌─ 后端 房子已经盖好,墙上有 3 个插座 ──────────────┐    ║
   ║  │                                                   │    ║
   ║  │  内置(已有): 硬件I/O · 录音库 · Claude聊天 · 语音 │    ║
   ║  │                                                   │    ║
   ║  │   [插座1]──knowledge 插件                         │    ║
   ║  │   [插座2]──data-factory 插件                      │    ║
   ║  │   [插座3]──report-pipeline 插件                   │    ║
   ║  │      │           │           │                    │    ║
   ║  └──────┼───────────┼───────────┼────────────────────┘    ║
   ║         │ 包一层皮  │ 包一层皮  │ 包一层皮                ║
   ║         ▼           ▼           ▼                         ║
   ║   ad-wiki-pages  ad-synthetic  ad-mind-pipeline           ║
   ║   (60 篇 md)     -generator    (Python 管道)              ║
   ║                                                           ║
   ║  ┌─ domain/ 抽屉 ─ 所有"AD 特有"的东西关在这里 ────┐    ║
   ║  │  传感器通道定义 · agent 提示词                    │    ║
   ║  │  报告模板 · 知识库副本                            │    ║
   ║  │                                                   │    ║
   ║  │  → 想换"跌倒检测"项目? 换这一个抽屉,房子不动     │    ║
   ║  └───────────────────────────────────────────────────┘    ║
   ╚══════════════════════════════════════════════════════════╝
```

### 3.3 三个使用场景

#### 场景 A：医生王医生给张爷爷写诊断辅助报告

1. 医生登录 → 进入"医生视图"，看到 客厅 / 聊天室 / 报告室
2. 进**录音室** → 看到张爷爷过去一周 12 次录制
3. 选最新一次 → 按"**生成报告**"
4. 后端 **report-pipeline 插件**触发 → 跑 mind-pipeline 那条管道，进度 SSE 实时刷（复用 install-progress 模式）
5. ~30 秒后报告室出现 markdown 报告 + 数据卡片
6. 王医生在**聊天室**追问："为什么 HRV 偏低？"→ chat agent 自动调用 **knowledge 插件**搜 wiki，引用《Iaboni 2022》
7. 王医生改完导出 PDF

**关键**：从头到尾没切 app、没二次登录，用户不知道（也不关心）背后是 3 个仓。

#### 场景 B：研究员小李没设备要测试系统

1. 小李登录 → "研究员视图"比医生多一个**实验室**门
2. 进实验室 → 点"生成 10 个虚拟患者 × 30 天数据"
3. 后端 **data-factory 插件**（包装 ad-synthetic-generator）跑起来
   - wrapper 解决 `shutil.rmtree` 坑
   - 输出**直接写进现有 Recordings 库**
4. 小李回客厅，10 个虚拟患者像真患者一样躺在录音列表里 → 可以波形回放、生成报告
5. **没有任何"demo 模式"特殊代码路径**

**关键**：合成数据走和真实数据**同一个管道**，上层完全无感。

#### 场景 C：半年后转向"跌倒检测"项目

1. 复制 dashboard 仓
2. **只改一个文件夹**：`domain/ad-early-prediction/` → `domain/fall-detection/`
   - 传感器通道改 IMU 主导
   - agent 提示词从 AD 风险 → 跌倒风险
   - 报告模板换老年医学/康复医学风格
   - 知识库换跌倒文献
3. **房子（dashboard / 聊天 / 录音 / 插件框架）零代码改动**
4. 三个插件能用就用，不能用就在设置关掉

**关键**：之所以不臃肿，是因为"AD"不写死在 100 个文件里，而是关在**一个抽屉**里。

### 3.4 角色分化方案

不做多套登录系统。user 表加一个 `role` 字段：

```
role = "patient" | "clinician" | "researcher"
```

前端 React Router 加 route guard：

| 路由 | patient | clinician | researcher |
|---|---|---|---|
| `/dashboard` | ✅ | ✅ | ✅ |
| `/recording` | ✅ | ✅ | ✅ |
| `/chat` | — | ✅ | ✅ |
| `/reports` | (只看自己) | ✅ | ✅ |
| `/data-factory` | — | — | ✅ |
| `/knowledge` | — | (只读) | ✅ |
| `/settings` | — | — | ✅ |

一个登录、一个 user 表、一个网址。**省了维护 3 套 auth、3 套部署、3 套样式的大坑。**

### 3.5 模块间只锁三个稳定契约

模块之间不要乱聊。锁死这三个 schema，剩下都是各模块内部事：

#### 契约 1：Sensor Frame

```
timestamp (ISO8601 / unix_ms)
<channel_1>, <channel_2>, ...   # 通道集由 domain pack 定义
label (string, 任务名 / 状态标签)
subject_id (string)
```

ad-synthetic-generator 已经按这个 schema 输出。

#### 契约 2：Patient-Day Bundle

```
recordings/<patient_id>/<day>/
  ├── sensor/*.csv         # Sensor Frame 格式
  ├── persona.json         # 人口学 + 病史
  ├── ema.jsonl            # Ecological Momentary Assessment
  ├── surveys.jsonl        # MMSE / MoCA / PHQ-9 等
  ├── notes.jsonl          # 临床观察
  └── bpsd_events.jsonl    # 行为心理事件
```

ad-mind-pipeline 已经在读这个。

#### 契约 3：Knowledge Query API

```
GET /api/knowledge/search?q=<query>&tags=<tag1,tag2>&status=<...>
  → [{id, title, body, front_matter}]

GET /api/knowledge/get/<id>
  → {id, title, body, front_matter, links}

GET /api/knowledge/list?type=<concept|method|agent|synthesis|dataset>
  → [{id, title, status, last_updated}]
```

一次定义，chat MCP 和 mind-pipeline 都用。

---

## 4. 可迁移性设计 — Domain Pack

将所有"AD-specific"内容关进单一目录：

```
domain/ad-early-prediction/
├── schema.json          # 传感器通道定义、特征字段、dataclass shape
├── prompts/
│   ├── physio_agent.md
│   ├── behavior_agent.md
│   ├── clinical_agent.md
│   └── narrator.md
├── templates/
│   ├── session.md       # 单次报告模板
│   ├── weekly.md        # 周报模板
│   └── monthly.md       # 月报模板
├── knowledge/           # ad-wiki-pages 的 markdown 副本（启动时索引）
│   └── ...
└── pipelines.yml        # 哪些 extension 默认启用、参数预设
```

**Shell（dashboard / extension 系统 / chat / recordings / PTY / voice）完全不知道 AD。**

迁移到其他场景（fall detection / 康复训练 / 运动队疲劳监测）= 换一个 domain pack。Shell 不动。

之所以这条线现在能落地，是因为 ainone-dashboard 的 hardware I/O 层（serial / BLE / UDP / WAV）本来就 sensor-agnostic。

---

## 5. 周报 / 月报输出方案

### 5.1 决策：**要做**

单一"数据表"只是工程师的调试视图。AD 慢病的临床价值在 longitudinal trend——单次看不出来"妈妈最近不对劲"，7 天 / 30 天才能看出来。**周报月报才是给非工程师用户看的产品形态**，覆盖最大的潜在用户群（家属、社区医生）。

### 5.2 实现：挂在 report-pipeline 插件加 `scope` 参数，**不做新模块**

```
scope = "session"    每次录完立即生成        ← 现在 mind-pipeline 默认
scope = "weekly"     最近 7 天聚合 + 对比上周
scope = "monthly"    最近 30 天聚合 + 对比上月/基线
```

报告室页面加 tab：单次 / 周报 / 月报。模板放 `domain/ad-early-prediction/templates/{session,weekly,monthly}.md`，跟 domain pack 走。

### 5.3 三种报告分别服务三种用户

| 报告 | 收件人 | 风格 |
|---|---|---|
| 单次 | 医生 / 研究员 | 详细数值 + 文献引用，调试用 |
| **周报** | **患者家属 / 看护** | 大白话："本周妈妈夜起 12 次，比上周多 4 次，建议关注" |
| **月报** | 医生 / 患者本人 | 趋势图 + 风险评分变化 + 下月建议 |

### 5.4 真正的工作量（不是免费的）

mind-pipeline 现在只懂"单次 P01"，要补三件事：

1. **聚合层**：N 次 session → 一个"本周 bundle"（日 HRV 中位数、BPSD 计数、夜起次数、睡眠时长）
2. **对比层**：周报对上周；月报对上月或基线，给出 Δ
3. **触发**：先做手动按钮（"生成本周"），后期加"每周日 8am 自动跑"轻量调度

**谈判建议**：让 Jewelina 在 mind-pipeline 里**直接支持 `scope` 参数**，而不是你 wrapper 硬包——否则她改 pipeline，wrapper 跟着碎。

可以拿 `/api/knowledge/search`（解她的硬阻塞）换 `scope` 参数支持。

### 5.5 隐藏好处

加了周报月报后，**chat 立刻变得有用**：家属看完周报有疑问 → 点"问问 AI"→ chat agent 自动把这份周报作为 context 加载 → 用 knowledge 插件查文献回答。

这就是三个支柱（数据分析 / 系统设置 / 报告生成）真正联起来的地方。

---

## 6. 落地步骤

按性价比排序：

| 优先级 | 动作 | 解锁了什么 | 估计工作量 |
|---|---|---|---|
| **P0** | 建空壳 `domain/ad-early-prediction/` 文件夹 + README | 给所有未来 PR 一个钉子 | 30 min |
| **P0** | 实现 `/api/knowledge/search`（读 markdown，front-matter + 全文索引，**不需要向量库**） | 解 mind-pipeline 缺 `KnowledgeStore` 硬阻塞；同时给 chat 一个 MCP tool | 1 天 |
| **P1** | 把 ad-synthetic-generator 包成 `data-factory` extension，输出写进 Recordings 库 | 没设备时也能 demo；mind-pipeline 也有可消费数据 | 2-3 天 |
| **P1** | 加 `role` 字段 + 前端 route guard（先 `clinician` / `researcher` 两个角色） | 角色分化 MVP，不动数据模型 | 1 天 |
| **P2** | 把 ad-mind-pipeline 包成 `report-pipeline` extension（chat tool + recordings 触发） | 真正打通"录数据 → 报告"闭环 | 3-5 天 |
| **P2** | 同步加 `scope=weekly/monthly` + 报告室 tab + 模板 | 周报月报上线 | 与上一项合并做 |
| **P3** | 抽 chat MCP server manifest 到 `domain/` | 换 domain 时连 agent 工具集都跟着换 | 半天 |

**第一刀**：P0 那两个先做完，整套架构就站起来了。

---

## 7. 应当避免的方向

- ❌ **等 wiki-pages 的私有 agent 代码** —— 7/8 还是 stub，等不到。chat 已经有现成 agent。
- ❌ **把四个仓 merge 成 monorepo** —— 用 git submodule 或 extension 安装期 fetch。
- ❌ **重写 Hono 的 chat 层去用 mind-pipeline 的 agent 栈** —— 这是三种独立场景共存，不是冲突。chat = 对话；mind-pipeline = 结构化报告；wiki-pages 文档的 CLI subprocess pattern = 第三种，先不实现。
- ❌ **现在做 vector DB** —— 60 篇 markdown，全文 + front-matter 标签搜索完全够。≥ 5000 篇再考虑。
- ❌ **多套登录 / 多个前端 app** —— 一个 user.role 字段 + route guard 解决。
- ❌ **在 wrapper 里硬包 mind-pipeline 的"周报月报"** —— 让 Jewelina 在源仓加 `scope` 参数。

---

## 8. 待解决的细节问题（下次继续）

留作后续会话深入：

- [ ] **认证方案**：要不要做 SSO？还是简单 session cookie？多用户共享一台 dashboard 实例的部署形态？
- [ ] **数据所有权**：录制数据归患者还是机构？多租户隔离怎么做？
- [ ] **report-pipeline 插件的具体 wrapper 设计**：Python subprocess 调 mind-pipeline，还是把 mind-pipeline 当 library import？硬编码路径怎么注入？KnowledgeStore 的接口怎么 mock？
- [ ] **data-factory 插件的具体接口**：要支持参数化（指定 `--patients K --days N --progression_pattern X`）？输出到 Recordings 库时 `subject_id` 怎么命名（避免和真实患者撞 ID）？
- [ ] **知识库写入**：医生在前端能不能编辑/添加知识条目？还是只读？编辑回写到哪？
- [ ] **Voice modality 缺失**：ad-synthetic-generator 不合成音频。要不要在 dashboard 这边补一个简单的 TTS 占位 / 录音库挂占位音频？
- [ ] **临床数据法规**：GDPR / 国内医疗数据法规对部署形态的约束？本地部署 only 还是允许云？
- [ ] **报告导出格式**：markdown → PDF 用什么链路？需不需要医生签名/水印？
- [ ] **设备多通道扩展**：当前 sensor schema 是固定的，添加新通道（比如手套硬件造出来后的 EMG）流程是什么？schema migration？
- [ ] **测试策略**：mind-pipeline / synthetic-generator 都没测试。集成进 dashboard 后要不要加 e2e？怎么 mock LLM 调用？
- [ ] **Jewelina 协作节奏**：什么时候开同步会？哪些事我推动，哪些事她推动？谁拿 ANTHROPIC_API_KEY？
- [ ] **手套硬件路线**：未制造，只有 ESP32 音频原型。优先级？
- [ ] **Scope 之外的报告**：年报？事件触发的紧急报告（BPSD spike 实时告警）？

---

## 9. 关联文档

- **`COLLABORATOR_PLUGIN_SPEC.md`**（同目录）— 给协作者的开发指示，定义 plugin 契约、各仓接口、验收清单。本文件讲"为什么"，那份讲"具体怎么做"。

## 10. 关键文件位置参考

- **本仓 ARCHITECTURE.md**：`d:\Imperial\individual\ainone-dashboard-v1.0.0\ARCHITECTURE.md`（dashboard 的完整技术架构）
- **Extension 参考实现**：`d:\Imperial\individual\ainone-dashboard-v1.0.0\backend\app\extensions\whisper_local.py`
- **MCP 注册位置**：`d:\Imperial\individual\ainone-dashboard-v1.0.0\backend\claude\handlers\chat.ts`
- **Recordings 服务**：`d:\Imperial\individual\ainone-dashboard-v1.0.0\backend\app\api\recordings.py`
- **域知识参考**：`https://github.com/Jewelina95/ad-wiki-pages` 的 `wiki/methods/agent_data_loader_interface.md` 和 `wiki/methods/claude_cli_inference_pattern.md`

---

*下次继续从第 8 节挑题展开。*
