---
type: plan
status: shipped
last_updated: 2026-04-24
tags: [recordings, voice, whisper, requirements, extensions]
---

# 需求表：录音数据集成 + 语音输入 + 可插拔扩展系统

版本：2026-04-24 · 落地对象：`esp32_sensor_dashboard`

> 本文件是**初版规划**。落地后的实装细节、bug 修复、UX 优化 → 见 [`SPEC.md`](SPEC.md) § 13（Recordings, Voice Input & Extensions Suite）。

---

## 1. 总目标

把硬件侧（Python FastAPI）的录音数据和音频输入能力引入 AI 聊天页，形成两页之间的真正联动；同时为后端建立一个**可插拔扩展系统**，供未来功能（Whisper、TTS、Vision 模型…）以安装/启用/禁用的方式挂载。

## 2. 功能要求

| # | 功能 | 形态 | 默认可用 |
|---|---|---|---|
| F1 | ChatPage 展示后端 recording sessions 清单 | 右侧可折叠面板 | ✅ 不需扩展 |
| F2 | Recording 可拖进 ChatInput 作为 context | 拖拽 + pill 预览 + prompt 内嵌/路径引用 | ✅ 不需扩展 |
| F3 | ChatInput 麦克风按钮（PC 麦 → 文字） | 🎤 按钮 + 浏览器 SpeechRecognition | ✅ 不需扩展 |
| F4 | Settings 页 + Extensions 面板 | 新 route `/settings` | ✅ 框架 |
| F5 | Whisper-local 扩展：一键安装 + 开机自启 | pip 装 `faster-whisper` + 下载 base 模型 | 🔌 装了才有 |
| F6 | 麦克风支持 ESP32 UDP 路径（经 Whisper 转写） | 麦克风按钮下拉多一个选项 | 🔌 装了 Whisper 才有 |

## 3. 非功能要求

- **零货币成本**：不用任何付费 API；Whisper 走本地推理
- **环境隔离**：pip 安装走 `sys.executable -m pip`，不污染全局 Python
- **可迁移**：纯 Python 标准工具链 + 浏览器原生 API
- **失败可回滚**：扩展安装失败不能让状态文件卡在 `installing`，必须能重试或清除
- **开机自动**：已启用的扩展随 FastAPI lifespan 启动

## 4. 技术决策（已定）

| 决策 | 取值 | 理由 |
|---|---|---|
| PC 麦转写 | 浏览器 `SpeechRecognition` | 零成本、无后端依赖 |
| ESP32 音频转写 | `faster-whisper`（`base` 模型，~150MB） | CPU 可跑、无 API key、质量合格 |
| Python env 适配 | `sys.executable -m pip install` | 兼容 venv / conda / 全局 Python |
| 扩展状态持久化 | `backend/app/extensions/state.json` | 简单、无需 DB |
| 安装进度反馈 | Server-Sent Events（`text/event-stream`） | FastAPI 原生、比 WS 简单 |
| Whisper 模型默认值 | `base`，Settings 未来可选 `small/medium/large` | 平衡速度质量 |
| Recording session ID | 文件名时间戳（`YYYYMMDD_HHMMSS`） | 已存在的天然键，无需新增 |

## 5. 分阶段实施

### Phase A — 基础（不依赖扩展）

**A1. 后端：录音清单/内容 API**

- 新文件：`backend/app/api/recordings.py`（区分于现有 `recording.py` 的 start/stop/status）
- 端点：
  - `GET /api/recordings/list` → `{sessions: [{id, timestamp, csv, audio}]}`，扫 `CSV_DIR` + `AUDIO_DIR` 按 `YYYYMMDD_HHMMSS` 配对
  - `GET /api/recordings/csv/{filename}` → 返 CSV 文本（前端按需读）；查询参 `?head=N` 只取前 N 行用于预览
  - `GET /api/recordings/audio/{filename}` → 返 WAV（`StreamingResponse`，支持 Range 以便未来播放）
  - `GET /api/recordings/meta/{id}` → 返单个 session 的 meta（行数、时长、通道）
- 在 `main.py` 注册路由
- 安全：filename 走白名单正则（只允许 `sensor_\d{8}_\d{6}.csv` / `audio_\d{8}_\d{6}.wav`）防止路径穿越

**A2. 前端：RecordingsPanel + 拖拽**

- 新文件：`frontend/src/components/chat/RecordingsPanel.tsx` — chat 页右侧抽屉（类似 ChatSidebar 但贴右边）
- 修改 `frontend/src/api/claudeApi.ts` 加 `listRecordings() / fetchRecordingCsvHead(filename, n) / getRecordingMeta(id)`
- 扩展 `frontend/src/lib/attachments.ts`：
  - `AttachmentKind` 加 `'recording'`
  - `PendingAttachment` 加 `recordingId?: string / recordingKind?: 'csv' | 'audio' | 'both'`
  - `buildPromptWithAttachments` 处理 recording 类型：小 CSV（< 50KB）内嵌数据，audio/大 CSV 只给路径让 Claude 用 Read 工具
- 修改 `ChatInput.tsx` 的 textarea 加 `onDragOver / onDrop`；drop 时解析 dataTransfer 的 recording payload → push pendingAttachments
- 修改 `ChatPage.tsx` 加挂载 RecordingsPanel（右侧，可折叠）

**A3. 前端：PC 麦克风按钮**

- 新文件：`frontend/src/lib/speechRecognition.ts` — 浏览器 API 包装
  - 统一接口：`start(onPartial, onFinal, onError)` / `stop()` / `isSupported()`
  - 默认中文 + 英文双语识别（`lang = 'zh-CN'`，fallback `'en-US'`）
- 修改 `ChatInput.tsx` 加 🎤 按钮：
  - 点击：state `idle → recording`，启动识别，textarea 右上角显示红点
  - 识别中：partial 结果填 textarea（前端展示，最终确定时替换）
  - 再次点击：stop，final 结果保留在 textarea，用户可编辑后回车发送
  - 不支持的浏览器：按钮 disabled + tooltip 提示
- 不自动发送，用户必须手动回车。避免误识别直发

### Phase B — 扩展框架 + Whisper 安装

**B1. 扩展框架**（后端）

- 新目录：`backend/app/extensions/`
- `base.py`：`Extension` 基类
  ```python
  class Extension:
      id: str
      name: str
      description: str
      version: str
      
      async def on_install(self, ctx: InstallContext) -> None: ...
      async def on_start(self, app: FastAPI) -> None: ...
      async def on_stop(self) -> None: ...
      def status(self) -> dict: ...
  ```
  - `InstallContext` 提供 `log(line)`、`progress(pct)` 给前端流式反馈
- `registry.py`：硬编码可用扩展列表（初期 `[WhisperLocalExtension]`）
- `state.py`：`state.json` 读写
  ```json
  {
    "whisper-local": {
      "installed": true,
      "enabled": true,
      "installed_at": "2026-04-24T10:30:00",
      "version": "0.10.0",
      "config": {"model": "base"}
    }
  }
  ```
- `manager.py`：全局单例管理已加载的扩展实例；启动时遍历 enabled 的调 `on_start`

**B2. 扩展管理 API**

- 新文件：`backend/app/api/extensions.py`
- 端点：
  - `GET /api/extensions` → 全部扩展 + 状态（installed/enabled/installing）
  - `POST /api/extensions/{id}/install` → 启动异步 install job，返 `{job_id}`
  - `GET /api/extensions/{id}/install-progress` → SSE，流式 log lines + progress pct + 最终 `done` 或 `error`
  - `POST /api/extensions/{id}/enable` / `disable`
  - `POST /api/extensions/{id}/uninstall`（仅标记，不真 pip uninstall — 包留着等重装；模型文件可选删）
- Install 作业并发控制：同一 id 同时只能有一个 job

**B3. Whisper-local 扩展实现**

- 新文件：`backend/app/extensions/whisper_local.py`
- `on_install`:
  1. `subprocess.Popen([sys.executable, "-m", "pip", "install", "faster-whisper"])`，`stdout=PIPE` 逐行推给 `ctx.log`
  2. `WhisperModel("base", device="cpu", compute_type="int8")` 构造一次 → 触发 HuggingFace 自动下载模型
  3. 写 `state.json` 标记 installed
- `on_start`:
  1. 延迟 import `from faster_whisper import WhisperModel`
  2. 构造单例 model，存在扩展实例的 `self.model`
  3. **暂不**订阅 AudioBridge（Phase C 做）
- `on_stop`: 释放 model 引用，GC

**B4. Settings 页（前端）**

- 新文件：`frontend/src/components/settings/SettingsPage.tsx`
- Tab 结构：`General` / `Extensions` / `About`（本次只实装 Extensions）
- `ExtensionsTab.tsx`：卡片列表，每张卡 `[name, description, version, status, action button]`
  - 未装：按钮 `Install` → POST install → 开 EventSource 订阅进度 → 进度条 + 滚动 log
  - 已装未启用：`Enable`
  - 已启用：`Disable` / `Uninstall`
- 路由注册：`/settings` → `SettingsPage`
- Header 加齿轮按钮跳转 Settings

**B5. 麦克风下拉 ESP32 选项（UI 预埋，功能留到 C）**

- 修改 ChatInput 麦克风按钮为下拉：
  - `PC Microphone`（总是可用）
  - `ESP32 via Whisper` — 仅当后端 `/api/extensions/whisper-local` 返回 `enabled: true` 才显示；选中后暂显示 "Coming in Phase C" toast

### Phase C — ESP32 UDP → Whisper 转写

**C1. Whisper 接 AudioBridge**

- 修改 `audio_bridge.py`：`on_audio_data` 已存在 callback，Whisper 扩展在 `on_start` 里挂上
- 在 Whisper 扩展里维护环形缓冲 + 简单 VAD（能量阈值断句），每 ~1s 或静音 300ms 切一段
- 切下来的段扔给独立 worker thread 跑 `model.transcribe()`，结果放入转写队列

**C2. `/ws/transcribe` 端点**

- 修改 `backend/app/api/websocket.py`，加 `/ws/transcribe` 路由（或 Whisper 扩展自己注册）
- 前端连上后，扩展开始把队列里的 `{partial, final, text}` 推过去
- 关闭连接时暂停转写（节能）

**C3. 前端 ESP32 mic 选项启用**

- 下拉选 `ESP32 via Whisper` → 开 `/ws/transcribe` → partial 写 textarea 浅色、final 覆盖为实色
- 再次点 🎤 或关闭下拉 → close WS

## 6. 验证清单（每个 Phase 结束时跑一遍）

### Phase A 验收
1. 有 CSV 录音后，访问 `http://127.0.0.1:8080/api/recordings/list` 返回至少一条 session
2. ChatPage 右侧抽屉显示 session 列表
3. 拖一条 recording 到 textarea → textarea 上方出现 `🎙️ sensor_...` pill
4. 发送消息 → 后端 `[chat] spawn diag` 的 prompt 里包含 CSV 内容（小文件）或路径引用
5. 点 🎤 按钮 → 浏览器弹权限 → 说话 → textarea 实时出现文字 → 再点停止 → 文字保留
6. 不支持的浏览器（如旧版 Firefox）→ 🎤 按钮 disabled，hover 显示原因

### Phase B 验收
1. `/api/extensions` 返回 `whisper-local` 的状态（初始 installed=false）
2. Settings → Extensions 显示一张 Whisper 卡片，按钮 `Install`
3. 点 Install → 进度条动起来，log 区域滚动 pip 输出 → 模型下载 → 完成
4. 刷新后状态保持 `installed=true enabled=true`
5. 重启后端 → `[Lifespan]` 日志里看到 Whisper `on_start` 被调用
6. ChatInput 🎤 下拉出现 `ESP32 via Whisper` 选项（点击 toast "Coming in Phase C"）

### Phase C 验收
1. ESP32 UDP 音频接通（`/api/audio/start`）
2. ChatInput 选 `ESP32 via Whisper` → 对 ESP32 麦说话 → textarea 出现转写文字
3. 切 PC Mic 或关闭 → WS 断，转写停

## 7. 刻意不做（Out of Scope）

- 扩展远程市场 / 签名机制
- Whisper 模型切换 UI（`small/medium` 支持可后加）
- 实时音频波形显示（数据页已有，不复制）
- CSV 的列选择性拖拽（整个 session 拖或不拖）
- 语音转写的离线本地 PC 麦方案（浏览器 API 够用）
- 自定义扩展插件的动态加载（当前是 registry 硬编码）

## 8. 关键文件速查

### 后端（Python）
- `backend/app/main.py` — 加路由 + lifespan 挂扩展
- `backend/app/config.py` — `RECORDINGS_DIR` 等路径常量
- `backend/app/api/recordings.py` — **新增** 清单/内容
- `backend/app/api/extensions.py` — **新增** 扩展管理
- `backend/app/extensions/` — **新增** 整个目录
- `backend/app/core/audio_bridge.py` — `on_audio_data` callback 供 Whisper 挂

### 前端（TypeScript）
- `frontend/src/api/claudeApi.ts` — 加 recording + extension API
- `frontend/src/components/chat/ChatPage.tsx` — 挂 RecordingsPanel
- `frontend/src/components/chat/ChatInput.tsx` — 加 🎤 按钮 + drop handler
- `frontend/src/components/chat/RecordingsPanel.tsx` — **新增**
- `frontend/src/components/settings/SettingsPage.tsx` — **新增**
- `frontend/src/lib/attachments.ts` — 扩展 kind='recording'
- `frontend/src/lib/speechRecognition.ts` — **新增**
- `frontend/vite.config.ts` — 把 `/api/recordings` / `/api/extensions` 代理到 `127.0.0.1:8080`

### Vite 代理 hint
```ts
// Python 后端路由（ESP32 / 录音 / 扩展）→ 8080
'/api/recordings': 'http://127.0.0.1:8080',
'/api/extensions':  'http://127.0.0.1:8080',
'/api/audio':       'http://127.0.0.1:8080',
'/api/recording':   'http://127.0.0.1:8080', // 已有
'/api/serial':      'http://127.0.0.1:8080', // 已有
'/api/ble':         'http://127.0.0.1:8080', // 已有
// Node 聊天后端 → 3000（已有）
'/api/chat':        'http://127.0.0.1:3000',
'/api/session':     'http://127.0.0.1:3000',
'/api/system':      'http://127.0.0.1:3000',
'/ws/shell':        { target: 'ws://127.0.0.1:3000', ws: true },
```

<!-- §9-12 已移至 SPEC.md § 13 -->
<!-- OBSOLETE_BEGIN
## 9. 当日新增 / 细化（Post-MVP Refinements, 2026-04-24）

原始 §2-8 描述的是初版方案。实装过程中和之后的 debug / UX 打磨引入了以下改动 —— 按系统分组，同时给出"为什么要加"的上下文。

### 9.1 Dashboard（数据可视化页面）

| 领域 | 新增 / 修复 | 原因 |
|---|---|---|
| **Serial port 下拉框** | Select 加 `min-w-0 + truncate` + `title` tooltip；option 文本超 38 字符尾部 `…` 截断；baud 下拉加 `shrink-0` | 设备描述过长会把整个 flex 行撑爆 |
| **2-channel bug** | `data_processor.py` 自动扩容 `channel_names`；serial/BLE 断开时 `reset()` | 冷启动 serial 首行被截断成 2 列后，后续全被强制截断 |
| **Display Settings：Card Size** | 新滑块 0.6×-2.1×，磁吸点 `[0.7, 0.85, 1.0, 1.25, 1.5, 2.0]` | 用户要求"显示 scale 调节 + 吸附点 + 自适应" |
| **Display Settings：Cards Per Row** | 加 `<datalist>` + 下方 tick labels 可视化 | 同上，让吸附点可见 |
| **Display Settings：Wheel Zoom Step** | 新滑块 2%-40%，磁吸点 `[5, 10, 15, 20, 30]`，内部存 multiplier (1.05 / 1.10 / 1.15…) | 用户要求滚轮灵敏度可调 |
| **ChannelCard wheel zoom** | 改用**原生** `addEventListener('wheel', ..., {passive:false})`；支持 `preventDefault` 阻止页面滚动 | React `onWheel` 是 passive，`preventDefault()` 静默失败 |
| **ChannelCard zoom 辅助** | 双击重置；手动 zoom 时右上角出现 `↺ auto` 重置按钮；cursor 变 `ns-resize` 暗示可滚 | 没有回 auto 的入口用户会卡住 |
| **ChannelCard 尺寸** | 所有尺寸（padding / 值字号 / 图表高度 / margin）= `ref × cardScale` 动态计算，全局 scale 统一变化 | CSS 内联 style 实时响应 store 改动 |

### 9.2 Chat 页：PC 麦克风（browser SpeechRecognition）

| 问题 | 修复 |
|---|---|
| `no-speech` 每 5-8s 刷 alert | 引入 `SILENT_SPEECH_ERRORS = {'no-speech', 'aborted'}`，这两个**不弹 toast 不 alert**，只 `console.log` |
| Chrome 在 silence 自动 stop → 用户以为挂了 | `pcKeepListeningRef` 跟踪"用户是否还想听"；`onEnd` 时若 `true`，立刻 spawn 新 recognition |
| 死循环保护 | 1.5s 内连续重启 > 5 次 → 判定 mic 真的无信号 → 给出明确 toast，停止 |
| 所有 `alert()` 打扰 | 改用 `onModeChangeAnnounce` toast（非阻塞） |
| 浏览器静默失败无法定位 | 启动前先 `preflightMicrophone()`：`getUserMedia` + `AudioContext` 采 500ms 音频测 RMS。失败 / 太静根据 NotAllowedError / NotFoundError / NotReadableError 区分定性 |
| 用户手改 textarea 被 SR 下次事件覆盖 | `lastMicWrittenRef` 记录上次写入内容；每次 SR 事件前对比**当前** `input`，不一致 → 用户改过 → 把用户版本作为新 base，清空 final buffer |
| 识别不出英文（默认 `zh-CN` 硬编） | 新加 `voiceLang` + localStorage 持久化 + 9 语言列表 + UI 下拉 picker（`🌐 EN`/`中`/`日` 等徽章）。改语言下次 `onEnd` auto-restart 自动采用新语言 |
| 日志被 Windows Python stdout buffer 吞掉 | 启动 backend 用 `python -u`；前端 log 用 `console.log`（不用 `debug`，默认 filter 看得见） |
| **默认 mic 设备错** | preflight 显示设备名 + RMS；用户案例：Chrome 选了 "Steam Streaming Microphone" 虚拟设备，-200 dB 全空。解决：Windows 声音设置或地址栏锁图标重选真麦 |

### 9.3 Chat 页：ESP32 麦克风（Whisper-local 扩展）

| 问题 | 修复 |
|---|---|
| 多语言幻觉（一块 en、下块 zh、再下块 de/ru…） | `/ws/transcribe?lang=<BCP-47>` query 参数；后端 `bcp47_to_whisper` 映射到 ISO 639-1；`ext.set_active_lang(...)` 把 `_active_lang` 固定；`model.transcribe(..., language=self._active_lang)` |
| 噪声地板（-55 dB RMS）被喂给模型 → 瞎编短词 | `SILENCE_RMS_DB = -55.0` 阈值，RMS 低于直接 `return ""`，不调 model |
| 低音量音频识别差 | 前处理：`target_peak = -3 dBFS`；若 peak < target → 乘 gain 把 peak 拉到目标。日志 `→ pre-amp gain +XX.XdB` |
| `beam_size=1` 决解率低 | 改 `BEAM_SIZE = 5`，多 ~30% CPU 换明显质量提升 |
| 模型能力上限 | `DEFAULT_MODEL = "base"` → `"small"`（~490 MB，int8 量化 CPU 推理约 2×/3s chunk）；首次启动下载缓存后续几秒就加载完 |
| 没法验证链路是否通 | `_log()` helper `[whisper] ...` 全加 `flush=True`；加 `frames_received / buffer_bytes / chunks_dispatched / chunks_dropped_busy / transcribe_count / empty_transcribes / last_transcribe_ms / last_text_preview / last_frame_age_sec` counter，通过 `/api/extensions/whisper-local` 的 `runtime` 字段实时可看 |
| 听不到的时候没反馈 | UDP 每 200 帧（≈3 s）打一次 `rx frames=N buffer=XB ws_clients=N` 心跳；每块 transcribe 打 `RMS=-XdB peak=-XdB`、`pinned=en`、`text='...'` |
| **Windows asyncio 坑** | `run.py` 设 `WindowsSelectorEventLoopPolicy` → `asyncio.create_subprocess_exec` 不支持 → 之前爆 `NotImplementedError`。install 重写为 `subprocess.Popen` 在 worker thread 跑，完全绕开事件循环 policy |
| venv 没 pip | install fallback：`python -m pip` 失败 + `ModuleNotFoundError: No module named pip` → 改走 `uv pip install --python sys.executable` |

### 9.4 Chat 页：工具栏新增元素

从左到右：
```
[+] [/] [🌐 EN] [🎤 PC] [🎛️ ESP32?] [🟢 ▓▓░ -25dB]  |  📁 cwd  |  [Perm][Think][Effort]
```

| 元素 | 来源 |
|---|---|
| `🌐 EN` 语言 picker | 新建（§9.2） |
| `🎤 PC` 麦克风按钮 | 原有 |
| `🎛️ ESP32` 麦克风按钮 | 原有（仅 Whisper 启用时显示） |
| `🟢 ▓▓░ -25dB` ESP32 音频电平指示 | **新建** `ChatAudioStatus.tsx`，复用 Dashboard 的 `wsClient` + `useStore`；audio.connected=false 时整个组件不渲染。clip 时变红 |

### 9.5 扩展框架（Settings 页）

原 §5 Phase B 基本完成。**ExtensionCard** 的 runtime 字段自动渲染 Whisper 的新 counter（无需改 UI 代码）。

---

## 10. 语音 → 文本 完整流程（Voice → Text Scenarios）

两条路径共享同一个 textarea 和同一个 "reconcile-with-user-edits" 协议，但**上游不同**。

### 10.1 Path A：PC 麦克风（浏览器原生 SpeechRecognition）

**触发与初始化**

1. 用户在工具条里选 `🌐 EN`（假设选 `English (US)`）→ `chatStore.setVoiceLang('en-US')` → localStorage 写入 `chat-voice-lang: en-US`
2. 用户点 🎤 按钮 → `ChatInput.handleMicClick()`
3. **Preflight 检查**：`preflightMicrophone(500)` 发一次 `getUserMedia({audio: true})`，成功后用 `AudioContext + AnalyserNode` 采 500ms 音频，计算 `maxRmsDb`
   - 权限拒绝 → 返回 `{ok:false, reason:'Microphone permission denied...'}` → toast 给用户
   - 拿到流但 rmsDb ≤ -80 dB → toast 警告但继续（防止 "Steam Streaming Microphone" 这类错选设备悄悄失败）
4. 设置会话引用：`micBaseTextRef = input`, `micFinalRef = ''`, `lastMicWrittenRef = input`, `pcKeepListeningRef = true`, `pcRestartCountRef = 0`

**识别会话开始**

5. `spawnPcRecognition()` → `startSpeechRecognition('en-US', {callbacks})`
6. 浏览器申请 mic → Google Web Speech service → 回 `onstart` 事件
7. `onStart` callback → `setVoiceSource('pc')` → 工具栏 🎤 变红脉冲点

**识别事件流**

8. 用户说话 → 浏览器把音频流给 Google STT → 回 `onresult` 事件
   - 每次事件包含 `interimResults` 和 / 或 `finals`（`isFinal` 标记）
   - 包装层对每个 event：提取 `newFinal`（本次新确认的 delta）+ `currentInterim`（当前实时猜测）
9. 对每个 onresult：`writeMicInput(interim)` 被调
10. `writeMicInput(interim)` 的**核心 reconcile 逻辑**：
    ```
    current = useChatStore.getState().input
    if current !== lastMicWrittenRef:
        # 用户手改过 → 采用用户版本作为新 base
        micBaseTextRef = current
        micFinalRef = ''
    next = base + sep + final + interim
    lastMicWrittenRef = next
    setInput(next)
    ```

**静默 → 自动重启**

11. 用户停说 5-8s → Google STT 侧触发 `no-speech` 事件 → 随后 `onend`
12. `onError('no-speech')` 被 `SILENT_SPEECH_ERRORS` 过滤，只 `console.log`
13. `onEnd` → 检查 `pcKeepListeningRef`：
    - `true` → 判断距离上次 restart 时间：
      - < 1.5s 且 restart 计数 > 5 → **熔断**：给用户 toast "No audio detected after several tries"，停止
      - 否则 → `spawnPcRecognition()` 再来一轮
    - `false` → 真正结束，`resetVoiceSession()`：flush buffer + 清引用 + `setVoiceSource('idle')`

**用户手改 textarea**

14. 用户不等说完，手动删改 textarea 某一段
15. React 的 `onChange` → `setInput(newValue)` → textarea 更新，但 `lastMicWrittenRef` 没变
16. 下次 SR 事件（interim 或 final）到来 → `writeMicInput` 的对比发现差异 → 采用用户的版本作为新 base → 后续识别 **append 到用户改过的文本后**

**停止**

17. 用户再点 🎤 → `pcKeepListeningRef = false` → `rec.stop()` → `onend` → 走 `resetVoiceSession` 分支

**关键文件**
- [`frontend/src/lib/speechRecognition.ts`](frontend/src/lib/speechRecognition.ts) — `startSpeechRecognition / preflightMicrophone / SILENT_SPEECH_ERRORS`
- [`frontend/src/components/chat/ChatInput.tsx`](frontend/src/components/chat/ChatInput.tsx) — `handleMicClick / spawnPcRecognition / writeMicInput / resetVoiceSession`
- [`frontend/src/store/chatStore.ts`](frontend/src/store/chatStore.ts) — `voiceLang + VOICE_LANGS`

---

### 10.2 Path B：ESP32 麦克风（Whisper-local 本地模型）

**触发与初始化**

1. 用户在 Settings 装好 Whisper-local 扩展 → 后端 `on_start` 加载 `small` 模型 + 订阅 AudioBridge 的 `on_audio_data` 回调
2. 用户选 `🌐 en-GB` → `chatStore.voiceLang = 'en-GB'`
3. 用户点 `🎛️ ESP32` 按钮 → `ChatInput.handleEsp32MicClick()`
4. 前端打开 WS：`new WebSocket('ws://localhost:5173/ws/transcribe?lang=en-GB')`（vite proxy → Python 8080）

**后端握手**

5. `transcribe_endpoint(websocket, lang='en-GB')` 接受连接
6. `bcp47_to_whisper('en-GB')` → `'en'`
7. `ext.set_active_lang('en')` → 日志 `[whisper] active transcription language: auto → en`
8. 检查 UDP 监听器（`conn_manager.audio_is_connected()`）：
    - 未连 → send `{kind:'notice', message:'UDP listener not active...'}`
    - 已连 → 正常往下走
9. `ext.add_ws_client(ws)` → buffer 清空（别把前面残留音频给新客户端）→ 日志 `ws client connected — total clients=1`
10. send `{kind:'ready'}` → 前端开始 UI "listening" 态

**音频流水线（持续）**

11. ESP32 发 UDP 包 → `AudioBridge._read_loop`（daemon 线程）`recvfrom(4096)`
12. 每 256 bytes 切一帧，计算 RMS/peak（独立于识别），然后：
    - `on_audio_data(frame)` → 原有 recording service（如果在录音）
    - `for cb in _audio_consumers: cb(frame)` → **Whisper 的 `_on_frame`**
13. `WhisperLocal._on_frame` 在 UDP 线程里：
    - 若 `ws_clients` 空 → 直接 return（不浪费资源）
    - `buffer.extend(frame)`, `frame_count += 1`
    - 每 200 帧打心跳 `[whisper] rx frames=200 buffer=51200B ws_clients=1`
    - `len(buffer) ≥ 96000` (3s @ 16kHz PCM16)? → 切 chunk，`buffer[:96000]` → `chunk`, `del buffer[:96000]`
    - 若 `_transcribe_inflight = True` → **drop** 这块（保护 CPU，避免 lag 累积）；否则：
    - `asyncio.run_coroutine_threadsafe(_transcribe_and_broadcast(chunk), self._loop)` 把任务送回 event loop 的 event-loop

**识别 + 广播（event loop async worker）**

14. `_transcribe_and_broadcast(chunk)`：
    - `_transcribe_inflight = True`（单并发锁）
    - `t0 = time.perf_counter()`
    - `text = await asyncio.to_thread(self.transcribe_pcm16, chunk)` — 模型推理丢到 thread pool 避免阻塞 event loop
15. `transcribe_pcm16` 内部：
    - PCM16 bytes → `np.frombuffer` → `/32768.0` 转 float32 `[-1, 1]`
    - 计算 `rms_db, peak_db`；日志 `RMS=-XdB peak=-XdB`
    - **静音门**：`rms_db < SILENCE_RMS_DB (-55)` → return `""`，日志 `→ skipped`
    - **预放大**：`peak < -3 dBFS` → `audio *= gain`，日志 `→ pre-amp gain +XXdB`
    - `model.transcribe(audio, beam_size=5, language=self._active_lang, vad_filter=True)` — `small` 模型 int8 CPU 推理
    - 日志 `lang=en (0.98), pinned=en, chars=N`
    - 返回 `"Hello world"`
16. 回到 `_transcribe_and_broadcast`：
    - 空文本 → counter++，日志 `→ EMPTY (VAD filtered silence)`，return
    - 有文本 → 日志 `transcribe done in XXXX ms → text='Hello world'`
    - `payload = {kind:'partial', text:'Hello world'}`
    - 遍历 `_ws_clients` 每个 `await ws.send_json(payload)`；失败的加入 `stale`；循环结束移除 stale
    - 日志 `broadcast: delivered to 1/1 clients`
    - `_transcribe_inflight = False`

**前端接收**

17. `ws.onmessage(evt)`：
    - `msg.kind === 'partial'` → 把 text 拼接到 `micFinalRef` 尾（加 sep）→ `writeMicInput('')` → 走 Path A 相同的 reconcile + setInput
    - `msg.kind === 'error'` → `stopEsp32Ws()` + toast
    - `msg.kind === 'notice'` → toast 提示
    - `msg.kind === 'ready' / 'ping'` → 忽略

**停止**

18. 用户再点 `🎛️ ESP32` → `stopEsp32Ws()` → `ws.close()`
19. 后端 `transcribe_endpoint` 的 try/except 捕 `WebSocketDisconnect` → `ext.remove_ws_client(ws)` → 若无其他 client → buffer clear，日志 `no clients left — cleared buffer`
20. 前端 `ws.onclose` → `resetVoiceSession()` → `setVoiceSource('idle')`

**关键文件**
- [`backend/app/core/audio_bridge.py`](backend/app/core/audio_bridge.py) — `_read_loop / add_audio_consumer`
- [`backend/app/extensions/whisper_local.py`](backend/app/extensions/whisper_local.py) — `_on_frame / _transcribe_and_broadcast / transcribe_pcm16 / set_active_lang / add_ws_client`
- [`backend/app/api/websocket.py`](backend/app/api/websocket.py) — `transcribe_endpoint / bcp47_to_whisper`
- 前端：`ChatInput.tsx` → `handleEsp32MicClick / writeMicInput`

**关键决策**
- **UDP 线程不跑模型** — 只 append + 如果 ≥chunk 调度一次；模型推理全在 event loop 的 `to_thread` worker
- **背压**：`_transcribe_inflight = True` 时新 chunk 直接 drop（不排队）—— 避免 slow CPU 累积 lag，用户等 10s 看到 10s 前说的话
- **资源节约**：`ws_clients` 为空时 `_on_frame` 立刻 return，UDP 照收但不 buffer、不推理
- **语言固定 per-connection**：`_active_lang` 是 extension 单例字段，多客户端共享（目前 1 tab = 1 client，够用）；要支持多客户端不同语言需改 per-ws 状态

---

## 11. 共享协议（Path A & B 都遵守）

### 11.1 textarea 写入协议

两个来源共享同一个 `writeMicInput(interim)` 函数，核心不变性：

```python
# 伪代码
def writeMicInput(interim):
    current = read_textarea()
    if current != lastMicWrittenRef:
        # 用户手改过 → 采纳他的版本
        micBaseTextRef = current
        micFinalRef = ''
    next = micBaseTextRef + sep + micFinalRef + interim
    lastMicWrittenRef = next
    write_textarea(next)
```

**不变性**：
- 任意时刻只能有一路语音在跑（`voiceSource` 是单值 `'idle' | 'pc' | 'esp32'`）
- `voiceSource !== 'idle'` ⇒ `micHandleRef` 或 `esp32WsRef` 至少一个存在
- `lastMicWrittenRef === current input` ⇒ 上一次写是我们写的
- 用户手改 ⇒ 下次 SR 事件触发 adopt → base=current, final=''

### 11.2 互斥性

- PC 在听时点 ESP32 → 先 `stopPcMic()` 再开 ESP32 WS
- ESP32 在听时点 PC → 先 `stopEsp32Ws()` 再 spawn SR

### 11.3 不自动发送

两路都只写 textarea，**永不自动** `onSend`，用户必须手动 Enter 发送。避免误识别直接送到 Claude 造成昂贵调用。

---

## 12. 终态测试清单

### 12.1 Path A: PC 麦 → textarea

- [ ] 点 `🌐 EN` → 下拉看到 9 个语言
- [ ] 选 `English (US)` → localStorage 写入 `chat-voice-lang: en-US`
- [ ] 点 🎤 → 浏览器首次弹权限框 → 允许
- [ ] DevTools Console 看到 `[speech] preflight got stream from device: ... RMS=-XXdB`
- [ ] 对麦说 "hello world" → textarea 实时出现字
- [ ] 手删 "hello" 改成 "hey" → 再说 "world" → textarea = "hey world"（保留手改）
- [ ] 停 8s 没说话 → 看 Chrome auto-stop + 自动 restart（`[mic] silent end — auto-restart #1`），红点持续亮
- [ ] 再点 🎤 → 红点熄 → 不再 restart
- [ ] 按 Enter → 消息发出

### 12.2 Path B: ESP32 麦 → textarea

- [ ] Dashboard 开 Audio Connect (UDP 8888)
- [ ] Chat 侧 ChatAudioStatus 出现绿点 + dB 数字
- [ ] 选 `English (UK)` 🌐
- [ ] 点 ESP32 按钮 → 后端日志 `[whisper] ws client connected`, `active transcription language: auto → en`
- [ ] 对 ESP32 麦说话 → 后端日志链：
  - `rx frames=200 buffer=... ws_clients=1`
  - `dispatch chunk #N`
  - `transcribe start: ... RMS=-XXdB peak=-XXdB`
  - `→ pre-amp gain +XX.XdB`（如果音量低）
  - `transcribe model result: lang=en (0.98), pinned=en, chars=45`
  - `transcribe done in XXXX ms → text='...'`
  - `broadcast: delivered to 1/1 clients`
- [ ] textarea 出现转写结果
- [ ] `GET /api/extensions/whisper-local` 的 `runtime` 字段有实时 counter
- [ ] 再点 ESP32 → WS close → 后端 `ws client disconnected`, buffer cleared

### 12.3 互斥性 / 手改保留

- [ ] PC 在听时点 ESP32 → PC 自动停、ESP32 启动
- [ ] ESP32 在听时点 PC → ESP32 自动停、PC 启动
- [ ] 任何一路在转写途中手改 textarea → 下次 chunk append 到改后的内容，不覆盖
OBSOLETE_END -->

<!-- 以上 §9-12 标记为 OBSOLETE；完整的实装说明 / bug 日志 / 语音场景请看 SPEC.md § 13。 -->

