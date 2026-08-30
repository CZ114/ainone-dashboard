---
type: plan
status: shipped
last_updated: 2026-08-21
tags: [agent, chat, workflow, report, context, memory, mvp, gap-closure]
---

> **2026-08-21 全部完成。** Phase 0-4 均已落地并通过离线验收 (细节与逐步记录见
> [施工日志](agent-mvp-completion-log.md))。9 缺口: 8 个 ✅, gap 2 按设计决策不做
> 独立分类器。真实端到端 (起服务 + 真 LLM) 留给验收。

# Agent 能力补齐 · 最小可行完整版计划

> 目标：把"平台包着自研 agent 框架、但没接满"的 9 个缺口补成一个**最小可行的完整闭环**
> （录音 → 质量感知上下文 → agent 分析 → 引用 → 报告 → 记忆），不为堆能力而堆。
> 本文件是**参考+施工单**：每条给出「现状(带文件锚点) / 目标 / 最小改动 / 验收 / 风险取舍」。
>
> 相关设计：[[03-protocol]] [[04-reserved-interfaces]] [[06-multiagent-workflows]]（SOD 系列）。

## 0. 一句话结论

9 个缺口里,**6 个是"接线"而非"造轮子"**（框架 core 已有,平台没传进去）,
只有**报告生成 (gap 5)** 和 **工作流吃传感器数据 (gap 7)** 需要真正新增结构。
建议按「先接线拿分 → 再补上下文质量 → 再统一引用 → 再打通患者数据 → 最后报告」的顺序做。

---

## 1. 现状核对（9 缺口 × 代码锚点）

| # | 能力 | 你的判定 | 代码现状（锚点） | 本质 |
|---|---|---|---|---|
| 1 | Chat 选择录音问答 | ⚠️ 部分 | 拖入→CSV 预览+路径进 prompt；模型用 `read_file` 读全文（`agent_tools.py:39` read_file / `factory.py:144` recordings_context_provider） | 基本能用,缺"结构化+质量标注" |
| 2 | 用户意图识别 | ⚠️ 部分 | 无独立分类器,靠工具描述让模型自选（这是现代 agent 正解） | **建议不做独立分类器** |
| 3 | Chat 引用 | ⚠️ 部分 | 只有 workflow 有 references 事件；chat 流事件里没有（`03-protocol.md:43` 事件表无 references） | 接线（复用 gap4 逻辑） |
| 4 | 工作流引用 | ✅ 基本 | `factory.py:152 tracking_build_agent` 扫 retrieve 结果发 references | 保持 |
| 5 | 报告生成 | ❌ 未 | agent_service 全库无 report schema/持久化（grep report=空）；最接近的是内存态 care-ribbon（`run_history.py:230`） | **真新增** |
| 6 | Quality-aware context | ❌ 未 | `recordings_context_provider` 只 dump 原始 JSON(≤1500字),无 validity/freshness/missingness/时间范围（`agent_tools.py:164-175`） | 增强 provider |
| 7 | Workflow 用传感器数据 | ❌ 未 | `patientId` 只作运行归属(owner vs patient_id side-car, `run_history.py:121`)；录音是**全局**的,不按患者；workflow 节点是 oneshot 轻量、无文件工具(SOD-07) | **真新增(需患者↔录音链路)** |
| 8 | Compaction | ⚠️ core有/未启 | `Agent` 支持 compactor,但 `build_chat_agent` 没传（`factory.py:140-149` 无 compactor 参数） | 接线 |
| 9 | Progressive memory | ⚠️ core有/未启 | `FileMemoryStore`+三层披露已完备,SOD-04 说"可直接启用"加 `memory_root` 即可,但 factory 没传（`04-reserved-interfaces.md:71`） | 接线 |

---

## 2. 目标结构 & 与现状的直接冲突

> ⚠️ 你消息里"目前与目标结构直接冲突的地方"那段内容没贴进来。下面是**我从代码里读出来的
> 冲突点**,请确认/补充——这决定 gap 5/7 的做法。

1. **录音不按患者分域** vs 目标要"某患者的传感器分析"。
   `/api/recordings/list`(FastAPI:8080) 是全局最近录音,没有 `patient_id` 字段;
   而 care-ribbon / 患者模型按 `patient_id` 组织(`authdb.py:5`)。
   → **gap 7 的前置**:要么录制时给录音打 `patient_id` 标签,要么先用"最近录音"近似。
2. **workflow 节点故意"工具轻量"(oneshot,无文件工具,SOD-07)** vs gap 7 要节点能读传感器。
   → 需要一个**受控开关**:只给特定 workflow/节点注入录音访问,不给所有节点加负担。
3. **chat 引用与 workflow 引用是两条代码路径**:workflow 走 `tracking_build_agent` 包 `send`;
   chat 走 `Agent.stream()`(`03-protocol.md`)。→ 统一 references 要抽一个**共用的 hits 提取工具**,别复制两份。
4. **memory 作用域**:SOD-04 预留 `memory_root=<agent_id>`(按 agent);临床用更想要**按患者**
   (agent 记得"这个患者"的历史观察)。→ 需决定 `memory_root = <agent_id>/<patient_id>`。
5. **报告没有持久化落点**:care-ribbon 在 `run_history._active`(内存态,进程重启即失);
   报告需要**磁盘持久化 + 版本**。→ 新增 `backend/data/reports/`,不要复用内存 run history。

---

## 3. 分阶段 MVP 计划（按建议顺序）

### Phase 0 · 接线拿分（gap 8 + 9）—— ✅ 已完成 (2026-08-21)
> 改了 `config.py`(AGENT_MEMORY_DIR + COMPACT_* + 系统提示加记忆提示)、
> `factory.py`(`_build_memory`/`_build_compactor` + `build_chat_agent(..., patient_id)` 传 memory/compactor)、
> `sessions.py`(把 patient_id 传进 build_chat_agent, resume 时取已登记归属)。
> **验收(离线构造测试,不调 LLM,PASS)**：compactor=TokenBudgetCompactor(win 32000/阈值 16000);
> memory 根 = `data/agent_memory/<agent>/<patient>`;4 个记忆工具 + clinical_observation 类别就位。
> 待补：跑一次真实长会话看压缩日志 + 跨会话 recall(需起服务)。

**改哪：** `backend/agent_service/factory.py` `build_chat_agent` + `resolve_agent_config` + `config.py`

- **gap 8 Compaction**：
  - 从 `agent` 库 import `TokenBudgetCompactor`,在 `build_chat_agent` 里构造并传 `compactor=`。
  - config 加 `compaction: {enabled: true, budget_tokens: N}`(给个宽松默认,如 24k)。
  - 只在超预算时触发(core 已有 `should_compact`),中段用 LLM 摘要——注意这会**多一次模型调用**。
  - **验收**：长会话(>预算)日志出现压缩;压缩后 `resume` 仍能恢复;历史 token 稳定在预算内。
  - **风险**：压缩摘要有成本/延迟 + CJK token 估计偏差 → 预算给宽,别频繁触发。
- **gap 9 Memory**：
  - factory 构造 `FileMemoryStore(memory_root)`,传 `memory=` 给 `Agent`;memory_root 决策见冲突 4:
    **建议 `backend/data/agent_memory/<agent_id>/<patient_id or "default">/`**。
  - config/agents.json 加 `memory_root`(缺省即启用默认路径)。自动获得 remember/recall/list/forget 四工具 + Tier-1 注入。
  - **验收**：跨会话记住一个事实(如"该患者夜间静息心率偏高");Tier-1 摘要出现在注入块;4 个工具可用。
  - **风险**：作用域一旦定,迁移成本高 → Phase 0 先定成 `<agent_id>/<patient_id>`。

### Phase 1 · Quality-aware context（gap 6，顺带补强 gap 1）—— ✅ 已完成 (2026-08-21)
> 改了 `app/api/recordings.py`(质量计算 `_compute_csv_quality` + sidecar 缓存 `_quality_cached` +
> `GET /api/recordings/quality/{id}`;CH1..CH12 自动映射固件通道名;t_ms 设备时钟交叉校验)、
> `agent_service/agent_tools.py`(provider 重写为质量摘要注入 + 新 `read_recording` 工具 +
> `list_recordings` 支持按患者过滤)、`config.py`(系统提示更新)。
> **验收(真实 CSV 双格式,PASS)**:新格式 50.06Hz+设备时长一致;老 CH1 格式映射成功并标出
> `hr_bpm_avg 全零`;缓存稳定;工具注册成功。患者 sidecar 读写两侧本就存在(B 决策地基已在)。

**原始设计(留档):**
**改哪：** `agent_tools.py:recordings_context_provider` + 可能新增 `/api/recordings/meta`(FastAPI:8080)

- 把"dump 原始 JSON"换成**结构化质量摘要**,每条录音给：
  - **时间范围**(CSV 首/末 `t_ms`)、**新鲜度**(now − 末样本,用框架 `timestamped_provider` 打"过期需核对"标)、
  - **缺失度**(12 列里哪些整列为空/0 → 缺模态;GSR/PPG 全 0 → 疑似非佩戴)、
  - **有效性**(采样率是否达标、丢包/行数)。
- 计算放哪：最省是 FastAPI:8080 加 `/api/recordings/meta?session=` 返回预算算好的质量字段;
  provider 只取摘要(别在 provider 里读大 CSV)。
- **gap 1 补强**：加一个 `read_recording(session_id)` 工具,返回**列+统计**而非原始 CSV(比 read_file 对模型更友好);
  顺便确认 `FS_WHITELIST` 覆盖 `backend/recordings/`(否则 read_file 读不到录音)。
- **验收**：注入块显示时间范围+新鲜度+缺失模态标记;拖入一段"只有 IMU、GSR 掉了"的录音,模型能说出"GSR 缺失,勿据此判断"。
- **风险**：算质量要读 CSV(成本)→ 缓存 meta / 只算摘要。

### Phase 2 · 统一 Chat 引用（gap 3）—— ✅ 已完成 (2026-08-21)
> 改了 `wire.py`(共用 `extract_references`: RAG shape/read_recording/read_file + ctx 聚合 +
> done 前发 `{type:"references"}`,neutral/compat 双格式)、`factory.py`(workflow 追踪复用同一提取器)、
> 前端 `claudeApi.ts`(StreamResponse 加 references)+`useStreamParser.ts`(复用 workflow 的
> references 消息渲染)、`03-protocol.md`(事件表补行)。
> **验收(wire 单测 PASS + tsc 干净)**:双格式 references 均落 done 前;按 source 去重封顶 8;
> error 结果跳过;无引用时不发;workflow 事件 shape 不变。

**原始设计(留档):**
**改哪：** 抽 `references` 提取为共用工具 → chat 流路径 + `03-protocol.md` + `shared/types.ts` + `schemas.py` + 前端

- 把 `tracking_build_agent` 里的 hits 提取抽成 `extract_references(messages_slice)` 共用函数(消除冲突 3 的重复)。
- chat 走 `Agent.stream()`：在流循环遇到 `tool_result` 时收集 retrieve/`read_recording`/`read_file` 的来源,
  在轮次边界(done)发一条 `{type:"references", query, hits:[...]}`(对齐现有事件风格,协议双份 shared/types.ts 为准)。
- 前端 chat 加一个 references 小面板(workflow 已有渲染,复用组件)。
- **验收**：普通 chat 里触发一次知识库检索/读录音 → 出现统一引用条,点得到来源。
- **风险**：轮次边界聚合别和 compat 的文本 flush 打架(见 `03-protocol.md:56` 那条教训) → references 单独事件,不塞进 assistant 气泡。

### Phase 3 · Workflow 吃患者传感器数据（gap 7）—— ✅ 已完成 (2026-08-21, 细节见 [施工日志](agent-mvp-completion-log.md))
**改哪：** 录音打患者标签(FastAPI:8080 录制路径) + `run_workflow`/workflow 运行注入 + 特定节点授权

- **MVP 做法(二选一,建议 A)**：
  - **A（近似,先跑起来）**：workflow 运行带 `patientId` 时,注入一个变量 `{patient_recordings}` =
    该患者最近 N 条录音的**质量摘要**(复用 Phase 1 的 meta),写进首节点 prompt。不改录制链路。
  - **B（正解,后补）**：录制时给录音写 `patient_id`(元数据文件/文件名),`/api/recordings/list?patient=` 支持过滤;
    workflow 节点按需拿该患者录音。
- 给**指定 workflow**（如 `clinic_sim`/`followup_review`）的特定节点开"传感器访问"开关(受控,不改所有 oneshot 节点)。
- **验收**：为患者 X 跑 followup_review → 首节点 prompt 里带上 X 的最近录音质量摘要;诊断节点能引用具体数值。
- **风险**：A 是"最近录音"近似,可能不是该患者的 → 文档写清是近似,B 才是正解。

### Phase 4 · 报告生成（gap 5）—— ✅ 已完成 (2026-08-21, 细节见 [施工日志](agent-mvp-completion-log.md))
**改哪：** 新增 `backend/agent_service/reports.py` + schema + 端点 + 事件 + 前端视图 + `backend/data/reports/`

- **Schema(先冻结最小集)**：`{id, patient_id, type: "session"|"weekly"|"monthly", generated_at, version,
  source_recordings: [...], modality_summary: {...}, observations: [...], risk_flags: [...],
  recommendations: [...], evidence_refs: [...]}`。
- **生成器**：一个 workflow 或专用 agent,读(该患者录音质量摘要 + memory + RAG)→ 填 schema。
  MVP 先做 **`type:"session"`**(单次录音一份报告),weekly/monthly 排程延后。
- **持久化**：`backend/data/reports/<patient_id>/<report_id>.json`,原子写(mkstemp+replace),带 `version`。
- **端点**：`POST /api/agent/reports/generate {patientId, recordingId}`、`GET /api/agent/reports?patient=`、`GET /api/agent/reports/:id`。
- **事件**：流式生成发 `{type:"report", reportId, status}`。
- **前端**：一个只读报告视图(可从 chat/care-ribbon 入口打开)。
- **验收**：选一段录音 → 生成 → 落盘 JSON(含 schema+version)→ 前端能看;重生成产生新 version。
- **风险**：范围最大 → 严格只做 session 级 MVP,别一上来做 weekly/monthly 排程 + 正式模板。

### 不做 / 缓做
- **gap 2 独立意图分类器**：**不做**。工具描述+模型自选是正解;真要分流用已有的 `route` 节点(`06-multiagent-workflows.md:30`)。写一句设计说明即可。
- weekly/monthly 报告排程、正式临床模板、通用 multi-agent delegate 编排 → 报告 MVP 跑通后再说。

---

## 4. 建议执行顺序与依赖

```
Phase 0 (compaction+memory 接线)  ── 无依赖,最便宜,先拿分
      │
Phase 1 (quality-aware context)   ── gap6;产出"录音质量摘要",被 3/7/5 复用
      │
Phase 2 (chat 统一引用)           ── gap3;依赖抽共用 extract_references
      │
Phase 3 (workflow 吃患者数据)     ── gap7;依赖 Phase1 的质量摘要 + 冲突1决策
      │
Phase 4 (报告生成)                ── gap5;依赖 Phase1(摘要)+Phase3(患者数据)+可选 memory
```

**每个 Phase 的产物都可独立验收、独立提交**(小步 PR)。Phase 0/1/2 都是低风险接线,能在很短时间内把"⚠️ 部分/未启"变成"✅"。Phase 3/4 需要你先拍板冲突 1(录音是否按患者打标)和 memory 作用域。

---

## 5. 已拍板的 3 个决策（2026-08-21 确认）

1. **录音按患者分域 = 正式版(B)**：录制时给录音写 `patient_id`,`/api/recordings/list?patient=` 支持过滤。
   → Phase 3 前置：改 FastAPI:8080 录制链路(录音元数据带 patient_id)。Phase 0/1/2 不受影响。
2. **memory 作用域 = `<agent_id>/<patient_id>`**：agent 按患者记忆(无 patient 时落 `default`)。
3. **报告 MVP = 只做 session 级**：单次录音一份报告;weekly/monthly 排程 + 正式模板缓做。

> 已确认,从 **Phase 0** 开始,一步一个可验收提交往下做。
