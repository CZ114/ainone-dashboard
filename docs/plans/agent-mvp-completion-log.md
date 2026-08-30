---
type: log
status: active
last_updated: 2026-08-21
tags: [agent, mvp, gap-closure, build-log]
---

# Agent MVP 补齐 · 施工日志

> 逐步记录 [agent-mvp-completion.md](agent-mvp-completion.md) 的落地过程。
> 每条 = 改了什么 / 为什么 / 怎么验的 / 遗留。计划文件里只标 ✅,细节在这。

## 2026-08-21 · Phase 0 — Compaction + Memory 接线 (gap 8/9) ✅

**改动**
- `backend/agent_service/config.py`: 新增 `AGENT_MEMORY_DIR`(data/agent_memory)、
  `COMPACT_CONTEXT_WINDOW`(默认 32000, env `AGENT_COMPACT_WINDOW` 可覆盖)、
  `COMPACT_THRESHOLD_RATIO`(默认 0.5);系统提示加入 remember/recall 记忆使用提示。
- `backend/agent_service/factory.py`: 新增 `_build_memory(agent_id, patient_id)`
  (FileMemoryStore, 根 = `agent_memory/<agent_id>/<patient_id|default>`, `_safe_seg`
  防路径穿越, extra_types 含 `clinical_observation`)、`_build_compactor()`
  (TokenBudgetCompactor);`build_chat_agent` 增加 `patient_id` 参数并传
  `memory=`/`compactor=` 给 Agent。
- `backend/agent_service/sessions.py`: `get_or_create` 把 patient_id 穿进
  `build_chat_agent`;resume 时优先取已登记的 session→patient 归属。

**为什么**:框架 core 早已支持(SOD-04 说 memory"可直接启用"),平台只是没传参。
memory 作用域按用户拍板 = `<agent_id>/<patient_id>`。

**验证**:离线构造 smoke(不调 LLM)PASS — compactor 挂载(win 32000/阈值 16000);
memory 根落 `agent_memory/default/P-smoke-123`;remember/recall_memory/list_memories/
forget_memory 四工具进 registry;clinical_observation 类别有效。

**遗留**:真实长会话触发压缩 + 跨会话 recall 需起服务实测;compact 窗口是保守常量,
后续可按 model 查表。

## 2026-08-21 · Phase 1 — Quality-aware context (gap 6, 顺带 gap 1) ✅

**改动**
- `backend/app/api/recordings.py`: 新增 `_compute_csv_quality`(单遍扫描: 时间范围/
  时长/采样率 vs 50Hz/逐通道 min-max-mean/missing%/zero%/flat;CH1..CH12 表头自动
  映射固件通道名;首列 t_ms 时算设备时钟时长交叉校验;可疑通道 = 全零/恒定/缺失>5%,
  t_ms 与 imu_steps 豁免恒定判定)、`_quality_cached`(sidecar 缓存
  `meta/<ts>.quality.json`, 按 CSV size+mtime 失效)、端点
  `GET /api/recordings/quality/{session_id}`(线程池计算不卡事件循环)。
- `backend/agent_service/agent_tools.py`: `recordings_context_provider` 重写 —
  注入最近 3 条录音的质量摘要(患者/新鲜度/时长@采样率/行数/通道数/⚠可疑通道/
  ⚠低采样率), 取代原始 JSON dump;新增 `read_recording(session_id, head)` 工具
  (质量+统计优先于 read_file 读原始 CSV);`list_recordings` 支持 patient_id 过滤。
- `backend/agent_service/config.py`: 系统提示工具清单更新(read_recording 列为
  录音分析首选)。

**发现**:录音 API 已有患者 sidecar 读写两侧(`recording_service.py` 写
`meta/<ts>.json`, `/list?patient_id=` 过滤)——决策 B 的地基本就存在。
新录音(2026-08)表头已是真实通道名, 旧录音(2026-04)是 CH1..CH12 — 两种都要兼容。

**验证**:真实 CSV 双格式 smoke PASS — 新格式 17.64s@50.06Hz 且设备时钟时长一致;
旧格式映射成功且揪出 `hr_bpm_avg 全零`(PPG 未检出心跳);缓存 sidecar 二次调用命中;
工具注册成功。

**遗留**:provider 每轮请求 quality(有 sidecar 缓存, 但首次算大文件慢)——如果聊天
首 token 延迟可感知, 再把 provider 改成只读已有缓存。

## 2026-08-21 · Phase 2 — 统一 Chat 引用 (gap 3) ✅

**改动**
- `backend/agent_service/wire.py`: 新增共用 `extract_references(tool_name, content)`
  (RAG hits 按 shape 识别不需工具名;read_recording/read_file 按名识别;error 结果
  跳过)、`_collect_refs`(ctx 聚合)、`_references_line`(按 source 去重封顶 8 条);
  `new_stream_ctx` 加 refs/ref_query;`serialize` 在 tool_result 时收集、在 done
  边界前发独立 `{type:"references", agent:"chat", query, hits}` 行(两种 fmt 通用;
  独立顶层事件, 不塞 assistant 气泡 — 避开 compat flush 的历史坑)。
- `backend/agent_service/factory.py`: `tracking_build_agent` 改用共用提取器
  (消除重复;workflow 事件 shape 不变)。
- `frontend/src/api/claudeApi.ts`: StreamResponse 加 `references` 类型 + agent/query/hits 字段。
- `frontend/src/hooks/useStreamParser.ts`: 新增 references 分支 → 复用 workflow 的
  `subtype:'references'` 消息(ChatMessages 已有 📚 折叠渲染, 前端零新组件)。
- `docs/agent-migration-sod/03-protocol.md`: 事件表补 references 行。

**验证**:wire 层单测 PASS(neutral/compat 双格式 references 均落 done 前一行;
去重生效;无引用不发;ctx 清空;error 结果跳过)+ 前端 `tsc --noEmit` 干净。

**遗留**:网关(:3000)是纯透传不用改;references 未进 AuditLog 干净历史(它是
线协议层事件)——医生回看历史会话时看不到引用条, 如需要可后续入 side-car。

## 2026-08-21 · Phase 3 — Workflow 吃患者传感器数据 (gap 7) ✅

**改动**
- `backend/agent_service/agent_tools.py`: 新增 `patient_recordings_block(patient_id,
  limit=3)`(按患者过滤录音 → 逐条质量摘要文本块;服务不可用/无录音返回说明文字,
  绝不抛异常)、`augment_workflow_inputs(spec, inputs, patient_id)`(**受控开关**:
  工作流必须在 inputs 里显式声明 `patient_recordings` 才注入 — 守住 SOD-07 节点
  轻量原则;显式传入时不覆盖;声明了但无患者时给占位文字防缺输入报错)。
- `backend/agent_service/main.py`: `/workflows/{id}/run` 与 `/stream` 两端点在
  启动前做 augment(stream 的 run_history 也记增强后 inputs);import 更新。
- `backend/agent_service/agent_tools.py` `run_workflow` 工具: 加可选 `patient_id`
  参数(模型从对话上下文提取), 注入 + run_history 记 patient_id 归属(照护丝带对齐)。
- `data/agent_service/workflows.json` `followup_review`: inputs 声明
  `patient_recordings`, triage/diagnosis 两步 prompt 加入录音质量摘要块
  (并要求引用数值时注意可疑通道、注明 session id);保留 CRLF + 2 空格缩进。

**验证**:smoke PASS — 未声明的工作流原样返回(开关生效);声明+无患者 → 占位文字;
显式传入不覆盖;8080 未起时返回"(录音服务不可用: ConnectError)"不抛异常;
修改后的 followup_review 过引擎 `validate_spec`;前端 `PatientsPage.tsx:435` 启动
followup_review 本就带 patientId → 端到端链路闭合, 前端零改动。

**遗留**:录音质量摘要是文本块注入(MVP);后续可给特定节点直接挂 read_recording
工具让 agent 自主取数。旧录音无 patient 标签 → 只有新录制且选了患者的会进摘要。

## 2026-08-21 · Phase 4 — session 级报告生成 (gap 5) ✅

**改动**
- `backend/agent_service/reports.py` (新文件): 报告 schema (id/type=session/version/
  patient_id/recording_id/modality_summary/quality_caveats/narrative/observations/
  risk_flags/recommendations/evidence_refs/disclaimer);**确定性/LLM 分工** —
  modality_summary+caveats+evidence 直接从质量元数据构建 (不经 LLM, 不被幻觉污染),
  narrative/observations/risk_flags/recommendations 走 oneshot LLM 严格 JSON
  (解析失败整体降级进 narrative, LLM 挂了降级为纯确定性报告, llm_error 记录原因);
  持久化 `backend/data/reports/<patient|unassigned>/<rpt_id>.json` 原子写;
  同录音重生成 version 递增;`latest_recording_for` 支持只传患者取最新录音;
  `read_report` id 白名单防路径穿越。
- `backend/agent_service/main.py`: 三端点 — `POST /api/agent/reports/generate`
  (医生档, 阻塞至 LLM 完成)、`GET /api/agent/reports[?patient_id=]`(患者钳制到
  自己的)、`GET /api/agent/reports/{id}`(患者只能读归属自己的, 403 否则)。
- `backend/agent_service/authz.py`: POLICY 两行 — GET reports=PATIENT(数据级钳制
  在 handler), POST generate=STAFF;DELETE 等未登记落 fail-closed DEV。
- `frontend/src/api/agentAdminApi.ts`: ReportSummary/SessionReport 类型 +
  generateReport(patientId, recordingId?)/listReports/getReport。
- `frontend/src/components/patients/PatientsPage.tsx`: 档案页新增"分析报告"卡片 —
  生成按钮(最新录音)、报告索引(录音id/版本/时间/⚠LLM降级标)、展开详情(总述/
  观察/风险旗/建议/质量告诫/免责声明);中英文案;报告服务不可用不阻塞档案页。

**验证**:后端 smoke PASS(monkeypatch LLM, 无网络)— 版本 1→2 递增;list/read
回环;`../../etc/passwd` 穿越被拒;LLM 抛异常时降级报告仍落盘(llm_error 记录,
caveats 保留);可疑通道正确进 modality_summary(status=suspect:all_zero)与告诫;
质量数据确认进了 LLM prompt。前端 `tsc --noEmit` 干净。

**遗留**:weekly/monthly 排程与正式临床模板未做(按用户决策缓做);生成是同步阻塞
(前端 120s 超时兜底), 后续可改后台任务;报告未接入 references 事件流(报告自带
evidence_refs 字段);未跑真实 LLM 端到端(需起服务+有 key, 明早验收时一键可测)。

## 2026-08-21 · Phase 5 — 报告进侧边栏 + 勾选注入上下文 (用户验收中追加) ✅

**需求**:跑出来的报告显示在聊天侧边栏;支持勾选"加入上下文"(新做一个 context provider)。

**改动**
- `backend/agent_service/context_reports.py` (新): session → 选中报告 ids 的 side-car
  存储 (`data/agent_service/session_context_reports.json`, 与 sessions 的 _owners/
  _patients 同法);每会话封顶 3 份 (注入是每轮 token 成本)。
- `backend/agent_service/agent_tools.py`: `make_reports_context_provider(session_id)`
  provider 工厂 — 每轮读勾选集, 报告压成紧凑块注入 (~1500 字/份: 总述/观察/风险旗/
  建议/告诫/降级标);未勾选返回 None 零成本;报告被删/损坏跳过不炸整轮。
  `_report_context_block` 独立可测。
- `backend/agent_service/factory.py`: `build_chat_agent` 的 context_providers 挂上
  该 provider (与录音质量摘要并列)。
- `backend/agent_service/main.py`: `GET/PUT /api/agent/sessions/{sid}/context-reports`
  — PUT 整体替换 (幂等), 校验报告存在 + 患者只能选自己的 (403);路径在既有
  `^/api/agent/sessions` PATIENT 权限规则下, authz 零改动。
- `frontend/src/api/agentAdminApi.ts`: getContextReports/setContextReports。
- `frontend/src/components/chat/RecordingsPanel.tsx`: 录音抽屉顶部新增"📄 分析报告"区
  — 列表 (录音id/版本/患者/⚠降级标/时间) + 勾选框 (乐观更新+失败回滚, 上限 3);
  无会话时禁用并提示"先发送一条消息建立会话";按患者筛选与录音共用同一个下拉。

**验证**:provider 冒烟 PASS (未勾选→None;勾选→注入块含风险旗/告诫;报告缺失
跳过;上限截断 3);`tsc --noEmit` 干净;agent_service 重启后
`GET /sessions/{sid}/context-reports` 实测返回 `{"reportIds":[]}` (200)。

**语义说明**:勾选状态挂在 **会话** 上 (不是全局) — 换会话各自独立;PUT 后
**下一条消息生效** (provider 每轮重读);会话重建 (TTL 淘汰/重启后 resume) 勾选
仍在 (side-car 持久化)。

## 2026-08-21 · Phase 6 — 报告/聊天消息拖入聊天框 + 侧边栏报告展开 (验收中追加) ✅

**需求**:①报告和聊天内容都能拖进聊天输入框、并在输入框显示"已选择";②报告生成后
能在侧边栏展开看详情;③本步实现方式写清日志。

### 实现方式 (机制说明)

**复用现有的"录音拖入"附件管线, 不另起炉灶。** 平台已有一条成熟链路:
RecordingsPanel 拖出 (自定义 MIME `application/x-esp32-recording`) → ChatInput 的
dragEnter/Over/Drop 四件套识别 MIME → 构建 `PendingAttachment` → 输入框上方渲染
chip 胶囊行 ("已选择"的可视化) → 发送时 `buildPromptWithAttachments()` 把附件内容
拼进 prompt → 发送后清空。本次只是给这条管线**加了两种新载荷**:

1. **报告拖入** — 新 MIME `application/x-analysis-report` (`REPORT_DRAG_MIME`):
   - 拖出端 (RecordingsPanel 报告行): 整行 `draggable`, payload 只带元数据
     `{id, recordingId, version, patientId}` (拖动要轻, 全文不进 dataTransfer);
   - 落入端 (ChatInput.handleDrop): 收到 payload → `agentAdminApi.getReport(id)`
     拉全文 → `renderReportText()` 压成紧凑文本 (总述/观察/风险旗/建议/告诫,
     封顶 6000 字) → `PendingAttachment{kind:'report', content, report:{...}}`;
   - chip 显示 "📋 报告 <录音id> v<版本>"; 发送时 attachments.ts 新增的 report
     分支把内容 + "引用数值注明报告 id" 的指引拼进 prompt。
2. **聊天消息引用拖入** — 新 MIME `application/x-chat-quote` (`CHAT_MSG_DRAG_MIME`):
   - 拖出端 (ChatMessages.ChatMessageComponent): 每个 user/assistant 气泡
     `draggable`; payload 直接带消息文本 (截断 `CHAT_QUOTE_MAX_CHARS=4000`) —
     内容已在前端手里, 无需回程取; **划词保护**: 用户正在气泡里选择文字时
     (`window.getSelection()` 非空) 不劫持拖拽, 划词复制优先;
   - 落入端: 同步构建 `PendingAttachment{kind:'chat-quote', quoteRole}`,
     chip 显示 "💬 引用·用户/AI消息"; prompt 里渲染成 `> ` 引用块并标注来源角色。

**ChatInput 四个拖放 handler 改成多 MIME**: `OUR_DRAG_MIMES` 数组 + `hasOurMime()`
统一判定 (录音/报告/引用共用同一套高亮视觉), OS 文件拖入依旧不触发;
handleDrop 按 MIME 分派: 引用(同步) → 报告(异步拉全文) → 录音(原逻辑不动)。
拖放高亮文案改为 "📎 松手附加 (录音 / 报告 / 消息引用)"。

**侧边栏报告展开**: 报告行尾加 ▸/▾ 按钮; `expandedReports: Map<id, SessionReport |
'loading'>` — 首次展开 `getReport` 拉全文并缓存 (再次展开零请求), 'loading' 占位
防连点; 详情块渲染总述/观察/风险旗/建议/质量告诫/免责声明 (与 PatientsPage 同字段,
窄栏压缩版)。行内三个交互各司其职: 拖 = 附件, 勾选 = 上下文注入 (Phase 5), ▸ = 展开。

**Token 记账**: `promptBytesFor` 给 report/chat-quote 按 content 长度计入
20MB 总附件预算 (两者都有各自截断上限, 实际远小于预算)。

### 改动文件
- `frontend/src/lib/attachments.ts`: AttachmentKind 加 `report`/`chat-quote`;
  两个新 MIME + payload 类型; ReportAttachmentMeta/quoteRole 字段;
  promptBytesFor/iconForKind/buildPromptWithAttachments 各加对应分支。
- `frontend/src/components/chat/RecordingsPanel.tsx`: 报告行 draggable +
  handleReportDragStart; 展开状态/toggleReportExpand/详情块; 区头提示文案。
- `frontend/src/components/chat/ChatMessages.tsx`: ChatMessageComponent 气泡
  draggable + 划词保护 + payload 构建。
- `frontend/src/components/chat/ChatInput.tsx`: 多 MIME 判定; renderReportText;
  handleDrop 三路分派; 高亮文案。

**验证**:`tsc --noEmit` 干净; 纯前端改动, Vite 热更即生效 (后端零改动)。
**遗留**:报告 chip 的 `path` 是伪路径 `report:<id>` (模型无法 Read 更多内容,
但全文已内联, 不需要); 消息引用只支持单条拖入 (框选多条未做 — 拖动交互天然单条)。

## 收尾状态 (2026-08-21)

9 缺口最终状态:gap 1 ✅(read_recording+质量注入) · gap 2 ➖(设计决策: 不做独立
分类器, 工具描述+route 节点已覆盖) · gap 3 ✅ · gap 4 ✅(保持) · gap 5 ✅(session 级)
· gap 6 ✅ · gap 7 ✅ · gap 8 ✅ · gap 9 ✅。
未提交 git — 等用户验收后决定提交粒度。四个 Phase 的 smoke 脚本在 scratchpad
(会话级, 不进仓库);真实端到端(起四服务+真 LLM)留给验收。
