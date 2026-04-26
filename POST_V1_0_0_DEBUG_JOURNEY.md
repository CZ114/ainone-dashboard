# Post-v1.0.0 Debug Journey

> v1.0.0 推到 GitHub 之后，用户做实测发现一连串 bug，从连接面板到录制状态机到性能再到一个 number input 的微妙 0。这篇按时间顺序记录每一轮"症状 → 假设 → 证据 → 修复"，dev 分支提交一一对应。
>
> 主线索：**WebSocket 异步 + React 重渲染高频 + Windows 路径量子态**这三股力量叠加，触发了远比单点 bug 大得多的连锁反应。

---

## Round 0：背景

`v1.0.0` 干净副本（`D:\Imperial\individual\ainone-dashboard-v1.0.0\`）已经强制覆盖到 `github.com/CZ114/ainone-dashboard` main，dev 仓库（`D:\Imperial\individual\esp32_sensor_dashboard\`）切到 `dev` 分支并砍掉 `origin`，用户开始拿 dev 跑测试。

---

## Round 1（commit `34fe8ac`）：连接面板 + BLE + Recording 重做

### 症状一：所有 connect 按钮联动

点 Serial Connect → BLE 和 Audio 按钮也变 "..." 同时禁用。三路通道理应独立。

**根因**：`ConnectionPanel.tsx` 只有一个 `loading` state，三个按钮都 `disabled={loading}`。

**修法**：拆成 `serialAction` / `bleAction` / `audioAction` 三个独立的 action 意图（`null | 'connecting' | 'disconnecting'`），按钮 disabled / 文字都看自己那份。

### 症状二：BLE 显示 "Disconnecting…"

点 Scan → 按钮先显示 "Connecting…"，几秒后翻成 "Disconnecting…"，最后显示 Disconnect。

**第一假设**：loading state 在 setTimeout 里被错误清空。改成 polling loop 后还是错。

**真正根因**：按钮文字之前是 `bleLoading ? (ble.connected ? 'Disconnecting…' : 'Connecting…') : ...`。后端 BLE bridge 在 scan 中途完成连接，WS 立刻推回 `connection_status` 把 `ble.connected` 置 true。这一刻 `bleLoading` 还是 true（poll loop 没结束），按钮看到 `connected=true && loading=true` → 切到 "Disconnecting…"。

**修法**：按钮文字看**用户意图**而不是连接状态。`bleAction === 'connecting'` 就显示 "Connecting…"，不管 `ble.connected` 后端怎么变。

### 症状三：断开后数据继续传 1-2 秒

点 BLE Disconnect 后，dashboard 还有数据点滴落了 1-2 秒才停。

**根因**：`bleak` 在 GATT subscription 注销过程中还会触发 `_on_ble_notify` 几次。这些回调照样把数据塞 `_data_queue`，data_loop 照常广播。

**修法**：`_on_ble_notify` 顶部加 `if not self.running or self._stop_event.is_set(): return`。serial bridge 的内层 line loop 也加同样的守卫（一次 `read()` 可能解出几十行）。

### 症状四：Recording 计时器跳

录 30s，时间在 27→28→29→**28**→30 这样跳。

**第一假设**：useEffect 重启 interval。改为不依赖 `recordingDuration` 后还是跳。

**真正根因**：`Dashboard.tsx` 的 WS handler 收到 `recording_status` 心跳就调 `setRecording(true, remaining, ...)`，而 `setRecording` 把 `recordingStartTimeMs = Date.now()` 重置。每秒一次心跳 = 每秒重置一次锚点 = 本地 100ms tick 读到的 elapsed 来回跳。

**修法**：彻底重做 recording 状态机（见后面几轮迭代）。第一版做的事：
- store 加 `syncRecordingFromBackend(isRecording, remaining, elapsed)`，只在 `state.isRecording=true` 时 no-op；只在状态切换时才动锚点
- Dashboard heartbeat 改用这个 action
- RecordingControls 加自定义时长输入（preset + number 输入）

### 症状五：Chat terminal 中的 Claude Code spinner mascot 错行

`xterm.js` 里 Claude Code 的小动物 spinner 一帧帧叠在不对的列上。

**根因**：`EmbeddedTerminal.tsx` 设了 `lineHeight: 1.2`。xterm 的单元格度量和 FitAddon 的 cols/rows 计算因此对不齐，spinner 用 `\r` 重写时光标回到错位的列。

**修法**：`lineHeight: 1.0`，再加 `letterSpacing: 0`。

### 症状六：Chat 录音面板把 chat 拉灰

打开 RecordingsPanel 后整个 chat 区被半透明黑色 backdrop 拦住，drag-to-attach 用不了（指针事件被吃了）。

**修法**：删 backdrop。drawer 关闭态加 `pointer-events-none`。

---

## Round 2（commit `2b3d462`）：心跳隔离窗 + 单调锚点

### 症状

Round 1 的 recording 重做之后，**还是有 bug**：

> 录制 30s，前两秒就录制界面消失了，回到最初的状态，然后再点击录制就会出现：`{"detail":"Recording already in progress"}`，点 stop 又会出现录制进度条。录制进度条积累的时候时间还是会来回跳比如 27→28→29→28→30。

这说明：
- 后端 IS recording（不然不会 "already in progress"）
- 前端却短暂以为没在录（UI 跳回 idle）
- 之后又重新种出录制状态

### 真因 1：陈旧 WS 消息覆盖本地状态

时间线：

```
t = -0.5s    后端 data_loop 周期性广播 [is_recording=false]
t =  0.0s    用户点击 Start
t =  0.05s   POST 到达后端，开始录制
t =  0.10s   POST 返回 → recordingStart() → 前端 active=true
t =  1.5s    那个 t=-0.5s 广播的陈旧心跳 [is_recording=false]
             经过 data_loop → asyncio drain → websocket 终于到达前端
             心跳处理器看到 active=true 但后端说 false → 清掉！
```

之后再点 Start → 后端 `is_recording=true` → 返回 "already in progress"。点 Stop 收到 200 → 这时一个**陈旧的** `is_recording=true` 心跳到达 → 前端看到 active=false 就以为"另一个 tab 在录"，重新 seed 出进度条。

**修法**：`recordingStart` / `recordingStop` 之后 3 秒**心跳隔离窗** —— 这段时间收到的所有心跳全部丢弃，让陈旧消息散完。

### 真因 2：重锚策略错（27→28→29→28→30）

之前是 `|drift| > 1.5s` 就重锚。但前端 `ourElapsed` 来自本地 `Date.now()`，**始终领先**后端报告的 elapsed 约 1s（后端 elapsed 是 1s 前算出来的、还要排队走 WS）。drift 接近 1.5s 时触发重锚 → 把 anchor 往后挪 → 下一帧 elapsed 跳回去。

**修法**：永远不向后重锚。只有 **后端 elapsed - 本地 elapsed > 2s**（说明本地 tab 被冻结过、要追上）才重锚向前追赶。

---

## Round 3（commit `ef27a49`）：路径不一致 + 自动 stop 广播 + tick self-stop

### 症状汇总

> 录制 5s 是正常的，但比如录制 30s，就会从 25s 时候开始又跳回 30s，最后结束又突然倒计时一秒。最后达到了设置的时间后，又不自动退出录制状态，去 chat 界面也看不到录制的文件。

### 真因 1：录制文件去了"另一个 recordings 文件夹"

`recording_service.py` 默认 `base_dir="./recordings"`（CWD 相对），后端从 `backend/` 启动 → 写到 `backend/recordings/csv/`。但 listing API 走 `app.config.RECORDINGS_DIR`（绝对路径，project_root/recordings/）。**写读两端不在同一个文件夹**，所以 chat 沿侧边栏永远是空的。

**修法**：`recording_service.__init__` 直接从 `app.config` 读 `CSV_DIR` / `AUDIO_DIR`。

### 真因 2：自动 stop 后没有显式广播

`_monitor_recording` 自动 stop 后只设 `is_recording=False`，依赖 `_data_loop` 下一个 1Hz tick 广播。这 1s 内：
- 前端继续算时间 → 显示溢出 duration
- 如果心跳因任何原因丢一次，前端永远不知道停了

**修法**：`recording_service` 加 `on_status_changed` 回调，`ConnectionManager` 接到广播队列 → 自动 stop 瞬间发 WS。

### 真因 3：UI 不退出录制状态

backend 已经 stop，但前端的 `recordingTick` 没有自停逻辑，elapsed 一直加。screenshot 里看到的 `00:46 elapsed / 00:30 total` 就是这个。

**修法**：`recordingTick` 检测到 `elapsed >= duration` 时本地立即清状态 + 3s quarantine，不等后端心跳。

### 顺带：handleStop 容错

如果 backend 已经自动 stop，frontend 再点 Stop 会收到 400 "no recording in progress"。改成 `finally { recordingStop(); }` —— 不论 POST 成败都清本地 UI。

---

## Round 4（commit `3556c10`）：心跳处理器极简化 + CSV/audio 分别拖

### 症状

> 录制 30s，就会从 25s 时候开始又跳回 30s。

`active=true → false → true` 的循环还在，只是被 quarantine 推后了。

### 真因

心跳处理器之前做三件事：清除 / seed / drift 重锚。在网络延迟下，任何一条都可能引发 anchor 跳变。

**修法**：把 `recordingHeartbeat` 缩成**一条规则** —— "后端说没在录 + 本地还以为在录 → 清掉本地"。**不 seed，不重锚**，所有其他情况一律 no-op。

```typescript
recordingHeartbeat: (isRecordingOnBackend) =>
  set((state) => {
    if (Date.now() < state.recording.ignoreHeartbeatsUntilMs) return {};
    if (!isRecordingOnBackend && state.recording.active) {
      return { recording: { 全部清零 } };
    }
    return {};
  })
```

代价：跨 tab 录制场景副 tab 不会自动种出 UI。但单用户单 tab 是绝对正确的。

### 顺带：chat recordings 卡片拆分拖拽

之前一个 session 卡片只能整体拖（CSV + audio bundle）。改成每个文件一行可独立拖：

```
🎙️ Apr 24, 14:30:22
   ┌──────────────────────────────┐
   │ 📊 1234 rows · 12 KB drag CSV│
   ├──────────────────────────────┤
   │ 🔊 5s · 480 KB    drag audio │
   ├──────────────────────────────┤
   │   📊 + 🔊 drag both          │  ← 蓝色高亮
   └──────────────────────────────┘
```

`RecordingDragPayload` 加 `mode: 'csv' | 'audio' | 'both'` 字段，`payloadFromSession(s, mode)` 按 mode 决定填哪些字段。`ChatInput.buildRecordingAttachment` 不需要改 —— 它本来就按字段是否存在来构造 attachment，链路自动通了。

---

## Round 5（commit `ee84428`）：WS 和 timer 提升到 App 根

### 症状

> 我在录制数据的时候点击 Claude chat 会有很长的延迟跳转。

而且：第一次录制不正常，后续录制都正常。

### 真因

WS 订阅和 100ms 录制 timer 都活在 `<Dashboard/>` 组件里。连锁反应：

| 现象 | 解释 |
|------|------|
| 第一次录制特殊 | React StrictMode 在 dev 让 mount-effect 跑两遍。第一次 WS handler 注册 → 立刻 cleanup → 再注册。singleton 的 `isConnecting` flag 卡死，第一次 session 的 handler 状态混乱。 |
| 切到 Chat 页慢 | Dashboard unmount → `wsClient.disconnect()` 关闭 WS → 3s 后才自动重连。 |
| Chat 期间录制状态丢同步 | `recording_status` 心跳没有订阅者，后端 auto-stop 信号丢失。 |

### 修法

新建 `<AppBridge/>` 组件挂在 `<App/>` 根（`<Routes/>` 之外）。它**永不卸载**，负责：

1. WS 订阅（用 `wsClient.onMessage` 返回的 unsubscribe 函数清理，**不调用 disconnect**）
2. 录制 100ms tick

```
<App>
  <ThemeProvider>
    <BrowserRouter>
      <AppBridge />            ← 全局数据平面，always alive
      <Routes>
        <Dashboard />          ← 退化为纯 UI 壳
        <ChatPage />
```

副作用消除：
- 录制中切到 chat 不会丢同步
- 在 chat 待 30s 后回 Dashboard 能正常看到 auto-stop
- StrictMode 双 mount 不再泄漏 handler

---

## Round 6（commit `612225e`）：rAF 节流 + startTransition

### 症状

`AppBridge` 上完之后 —— **还是慢**。

### 真因

不是 WS 重连了，是**主线程被传感器渲染挤死**。后端 push `sensor_data` 50Hz，每条都触发：

```
updateSensorData → ChannelGrid → N × ChannelCard → N × WaveformChart 重算 SVG
```

50Hz × N 通道 × Recharts SVG = 主线程满载。点击事件排在所有这些 React 渲染后面才能处理。

### 修法

**修法 A：rAF 节流高频消息**

`AppBridge` 把 `sensor_data` 和 `audio_level` 用 ref 缓存最新一帧，下一个 `requestAnimationFrame` 才统一 flush。50Hz → 60Hz max，多余帧直接丢（人眼根本看不出差别）。低频的 `connection_status` / `recording_status` 不走节流（store 立刻更新，UI 状态零延迟）。

**修法 B：`startTransition` 包导航**

Header 的导航按钮改成 `<button onClick={navigate(...)}>`，navigate 用 `startTransition` 包起来。React 18 把这个标记为非紧急更新，让点击事件能"插队" —— 即使有渲染队列在跑，路由切换也立刻执行。

```tsx
const goTo = (path: string) => {
  if (location.pathname === path) return;
  startTransition(() => { void navigate(path); });
};
```

---

## Round 7（commit `5eaa43c`）：Recording duration 输入框卡住 "0"

### 症状

> recording duration 那个自己输入数字之后为什么全部 backspace 之后一直会有数字 0 在那，我打数字那个 0 也不消失。

### 真因

经典 controlled `<input type="number">` 坑：

```
你: backspace 清空 → input value 变成 ""
React: onChange 拿到 e.target.value = ""
我代码: Number("") === 0, isFinite(0) === true → setDuration(0)
React: re-render <input value={0}> → 强制写回 "0"
你: 再打 "5" → 浏览器收到 "5" 时已经有 "0"，结果是 "50" 或 "05"
```

### 修法

input 用**字符串 state** 控制，不是数字。

| 时机 | 行为 |
|------|------|
| 边输入 | 字符串原样存（可以是 ""、"3"、"30" 任何中间状态） |
| Tab 离开 (onBlur) | 空着不动；合法数字就 clamp |
| 点 Start | 必须合法数字才行，否则按钮 disabled + 错误提示 |
| 点 preset chip | `setStr(String(s))` |

按钮高亮（哪个 preset 选中）改成看**解析值**而不是字符串原文，所以 "60" 和 "060" 都能点亮 1m chip。

---

## Round 8（commit `56951a8`）：波形图阴影方向不一致

### 症状

dashboard 上有些通道阴影在线**下面**（CH2 ~2059，CH3 ~13846），有些通道阴影在线**上面**（CH7 ~-9.4），风格不统一。

### 真因

Recharts 的 `<Area>` 默认 `baseValue=0`。填充区是"线 ↔ baseline"之间：

| 通道情况 | y=0 位置 | 填充方向 |
|----------|----------|----------|
| CH2 ~2059（全正）| 在视图下方 off-screen | 线 ↓ 0 ⇒ 阴影**在线下** ✓ |
| CH7 ~-9.4（全负）| 在视图上方 off-screen | 线 ↑ 0 ⇒ 阴影**在线上** ✗ |
| CH6 跨 0 | 在视图中间 | 部分上、部分下 |

### 修法

```tsx
<Area baseValue={yMin} ... />
```

把 `baseValue` 锚定到 `yMin`（图的视觉底）后，无论数值正负，填充始终是"线 ↓ 屏幕底部"，所有卡片统一"area under curve"风格。

---

## 经验提炼

### 1. WebSocket 是异步的，state 是同步的

每次踩坑都是因为忘了这点。`recording_status` 是后端在过去某一刻的快照，到达前端时世界已经变了。

**模式**：本地动作（用户点 Start/Stop）后开 quarantine 窗，丢弃这段时间内可能的陈旧消息；只接受非冲突的、来自未来的状态变化。

### 2. 重锚 / seed 是对称地危险

只朝一个方向重锚就好（向前追赶 hibernation）。任何"双向漂移修正"都会因为延迟带来视觉跳变。极端简化是赢的。

### 3. controlled `<input type="number">` 不要用 number state

`Number("")` 是个隐藏地雷。永远用 string state 控制 input，转 number 只在 commit 时（onBlur / onSubmit）。

### 4. 长生命周期的全局副作用要 hoist 到 App 根

WS 订阅、计时器这种"跨页面要存活"的东西放在路由组件里，每次切页面都要重建 —— 代价是真实的（连接耗时、状态丢同步）。`<AppBridge/>` pattern 把它们拽到 `<App>` 根上，路由切换零成本。

### 5. 高频 state update 必须 rAF 节流

50Hz WS 消息 → React 50Hz 重渲染 → 主线程满载 → 用户点击没人理。`requestAnimationFrame` 把更新塞进 60Hz 屏幕刷新节拍，剩余帧间隙留给 input。配合 `startTransition` 能把导航这种不紧急的更新降到最低优先级。

### 6. Recharts `<Area>` 默认 `baseValue=0` 是个语义陷阱

它假设你的数据在 0 周围对称。负值数据视觉效果完全反过来，必须显式 `baseValue={yMin}` 才能跨数据范围统一。

---

## Commit 时间线

```
56951a8  fix(waveform): anchor area fill to chart bottom for consistent shading
5eaa43c  fix(recording): duration input no longer collapses to "0" on backspace
612225e  perf: rAF-throttle high-rate WS + startTransition for nav
ee84428  perf: hoist WS + recording timer to <AppBridge/> at app root
3556c10  fix(recording): drop heartbeat seed/catch-up; split CSV+audio drag handles
ef27a49  fix(recording): path mismatch + auto-stop callback + tick self-stop
2b3d462  fix(recording): heartbeat quarantine + monotonic anchor
34fe8ac  fix: BLE button intent + bridge data leakage + recording redo
976c1a5  chore(git): stop tracking .claude/settings.json
139cb33  dev: baseline + post-v1.0.0 fixes
dc18a8e  AinOne Dashboard v1.0.0          ← v1.0.0 上线点
```
