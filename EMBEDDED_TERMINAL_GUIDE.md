# 嵌入式终端完整实现指南

> 从"在浏览器里塞一个真的 Windows PowerShell + Claude CLI"这个需求出发，一步步拆到 PTY、WebSocket、xterm.js 三层的技术细节。目标读者：之前没做过浏览器内终端、想理解每个技术抉择为什么这么选的开发者。

---

## 0. 背景与动机

**场景**：用户已经有了一个 Claude Code 的 Web UI（聊天气泡那种），但他们想要一个选项，能在网页内部直接启动一个**完整的 Claude CLI 交互终端** —— 同样的键盘体验、同样的 `/clear /compact /init` 命令、同样的文件编辑能力 —— 而不是离开浏览器去另一个终端窗口。

**第一次尝试**（失败的）：后端写个 `POST /api/system/launch-terminal`，用 `cmd /c start wt.exe -d <cwd> claude.exe` 弹**外部**终端。两个问题：

1. Windows 路径里一有空格或中文，`cmd /K "cd /d <cwd> && <claude>"` 的嵌套引号就炸。实际报错："文件名、目录名或卷标语法不正确"。
2. 离开了浏览器就失去了 Web UI 的意义 —— 用户还是想在同一个标签页里完成一切。

**第二次尝试**（本文讲的）：把终端**嵌进浏览器**。三件套：

- **xterm.js** 在前端画终端（画屏、处理 ANSI 颜色、光标、键盘）
- **node-pty** 在后端起真的伪终端（conpty on Windows）
- **WebSocket** 把两头的字节流双向打通

这是 VS Code 内置终端、claudecodeui、Theia 等几乎所有"浏览器内终端"的标准组合，稳、快、跨平台。

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                          浏览器                                 │
│                                                                 │
│   用户点"终端"按钮                                              │
│         │                                                       │
│         ▼                                                       │
│   TerminalModal  ──────────────────────────                     │
│         │                                   │                   │
│         ▼                                   ▼                   │
│   EmbeddedTerminal (React)                  close()             │
│   ├── new xterm.js Terminal                                     │
│   ├── FitAddon + WebLinksAddon                                  │
│   ├── ResizeObserver (debounced)                                │
│   └── new WebSocket('/ws/shell')                                │
│                           │  keystrokes (onData)                │
│                           │  ↓                                  │
│                           │  {type:'input', data:'a'}           │
│                    ─────────────────                            │
└─────────────────────│─────────────│───────────────────────────────
                      │             │
                      │   Vite dev server (5173) 代理             
                      │   ws: true 转发 Upgrade                   
                      ▼             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Node 后端 (3000)                             │
│                                                                 │
│   @hono/node-server ── http.Server ──┐                          │
│                                      ▼                          │
│                         server.on('upgrade')                    │
│                         if path=/ws/shell                       │
│                            │                                    │
│                            ▼                                    │
│                      WebSocketServer.handleUpgrade              │
│                            │                                    │
│                            ▼                                    │
│                      handleConnection(ws)                       │
│                            │                                    │
│                            │ init → pty.spawn                   │
│                            ▼                                    │
│                      node-pty IPty                              │
│                            │  (conpty on Windows)               │
│                            ▼                                    │
│                   powershell.exe + "claude"                     │
│                            │                                    │
│                            ▼                                    │
│                   Claude CLI 交互式 REPL                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**三条数据路径**，全部通过同一个 WebSocket：

| 方向 | 消息类型 | 载荷 | 频率 |
|------|---------|------|------|
| 用户按键 → PTY | `input` | `{data: "a"}` | 每键一次 |
| PTY 输出 → 屏幕 | `output` | `{data: "...ANSI..."}` | 高频（逐字节流） |
| 窗口 resize → PTY | `resize` | `{cols, rows}` | 50ms 节流 |

加上三个带外控制：`init`（前端告诉后端 cwd 和初始尺寸）、`ready`（后端确认 PTY 起来了）、`exit`（PTY 退出时通知前端）。

---

## 2. 为什么是这三个组件

### 2.1 为什么 xterm.js 而不是自己画

终端仿真器远比看起来复杂：

- **ANSI 转义序列**：光标定位 `\x1b[12;5H`、颜色 `\x1b[38;5;196m`、清屏 `\x1b[2J`、各种 DEC 私有模式
- **字符宽度**：CJK 宽字符占 2 列，emoji 占 2 列，零宽连字符怎么算
- **光标闪烁**、**选中高亮**、**滚动缓冲**、**软换行 vs 硬换行**
- **粘贴**（bracketed paste `\x1b[200~...`）、**鼠标事件上报**

自己实现大概 2 万行、3 年。xterm.js 是 VS Code 用的库，全都处理好了。

### 2.2 为什么 node-pty 而不是 `child_process.spawn`

`child_process.spawn` 给你的是**管道**（pipe）。管道和终端（tty）的本质区别：

| | 管道 | 终端 |
|-|------|------|
| `isatty()` 返回 | false | true |
| 大部分 CLI 检测到后的行为 | 关闭颜色、禁用交互 prompt、禁用 progress bar、行缓冲 | 正常交互模式 |
| 支持 resize 信号 | 无 | SIGWINCH + 行列数 |
| 支持 Ctrl+C 作为 SIGINT | 不直接 | 是（真实键盘行为） |

Claude CLI 在管道模式下会关掉 REPL，直接非交互跑完就退。我们要真正的交互 REPL，就必须用 **PTY**（pseudo-terminal）。

Windows 上 PTY 叫 **conpty**（Win10 1809+ 引入），之前只能用兼容层（winpty）。`node-pty` 自动选更好的那个，给你跨平台统一 API。

### 2.3 为什么 WebSocket 而不是 SSE / long polling

PTY 数据**双向**。SSE 只能服务器→客户端；long polling 双向但延迟高、连接反复建立。WebSocket 一次 TCP + 低开销帧，是事实标准。

`ws` npm 库是最常用的 Node 实现，活跃维护，Hono 不自带 WS 但能和 `ws` 共用同一个 `http.Server`。

---

## 3. 分层实现

### 3.1 层 1：后端 PTY + WebSocket

文件：[backend/claude/handlers/shell.ts](backend/claude/handlers/shell.ts)

**3.1.1 选 Shell**

```ts
function pickShell(): { shell: string; args: string[]; initCmd: string } {
  const initCmd = "claude";
  if (process.platform === "win32") {
    return {
      shell: "powershell.exe",
      args: ["-NoLogo", "-NoExit", "-Command", initCmd],
      initCmd,
    };
  }
  return {
    shell: process.env.SHELL || "/bin/bash",
    args: ["-c", `${initCmd}; exec ${process.env.SHELL || "/bin/bash"} -l`],
    initCmd,
  };
}
```

三个判断：

1. **Windows 用 PowerShell 而非 cmd** —— cmd 默认 GBK 编码，中文路径会乱码；PowerShell 在 Win10+ 默认 UTF-8，稳。
2. **`-NoExit` 让 PowerShell 在 `claude` 退出后不关 shell** —— 这样用户关完 Claude 还能继续 `git log`、`ls`、检查文件，和原生终端一致。
3. **Unix 用 `exec $SHELL -l`** —— 同样意思，Claude 退出后 drop 到登录 shell。

**3.1.2 PTY spawn**

```ts
pty = ptySpawn(shell, args, {
  name: "xterm-256color",
  cols, rows,
  cwd,
  env: {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  },
});
```

每个 env 变量的作用：

- `TERM=xterm-256color`：告诉 CLI 这是一个支持 256 色的终端 —— 许多工具（vim、less、htop、claude 自己）会查 `TERM` 决定颜色能力
- `COLORTERM=truecolor`：额外告诉支持 24-bit 真彩色（ANSI 38;2;R;G;B）
- `FORCE_COLOR=3`：Node 生态约定 —— 即使检测到非 TTY 也强制启用颜色，多数 Claude 输出路径会走这个分支

**3.1.3 数据管道（onData / write）**

```ts
pty.onData((data) => {
  send(ws, { type: "output", data });
});
```

每次 PTY 输出字节，原样包进 JSON 帧发到前端。不做任何过滤 / 解析 —— 让 xterm.js 处理所有 ANSI。

反方向：

```ts
if (msg.type === "input") {
  pty.write(msg.data);
}
```

前端打字就是原封不动的 `pty.write`。包括控制字符（Ctrl+C 是字节 `0x03`、Enter 是 `\r`、方向键是 `\x1b[A` 之类），xterm.js 已经帮你编码好，后端不用管。

**3.1.4 Upgrade 挂钩**

最 subtle 的一步 —— 怎么让 WS 和 Hono 共用端口：

```ts
export function attachShellWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", "http://localhost").pathname;
    if (pathname !== "/ws/shell") return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws);
    });
  });
}
```

关键是 **`noServer: true`** —— 不让 `WebSocketServer` 自己监听端口，手工介入 `server.on('upgrade')` 事件。为什么？因为 HTTP 和 WS 共享一个 TCP server（这是 WS 协议的本意），Hono + @hono/node-server 已经占了这个 server，我们**只想认领 `/ws/shell` 路径的 Upgrade 请求**，其他路径（如果未来有的话）可以路由给别的 handler。

调用处 ([cli/node.ts](backend/claude/cli/node.ts))：

```ts
const server = runtime.serve(args.port, args.host, app.fetch) as Server;
attachShellWebSocket(server);
```

为了能拿到 `server`，我**把 `runtime.serve()` 的返回类型从 `void` 改成 `unknown`** ——接口允许，但 Node 版本实际返回 `http.Server`。类型断言一次在边界处。

### 3.2 层 2：Vite 代理 WebSocket

文件：[frontend/vite.config.ts](frontend/vite.config.ts)

```ts
'/ws/shell': {
  target: 'ws://localhost:3000',
  ws: true,
  changeOrigin: true,
},
```

三行，但每个字段都至关重要：

- **`target: 'ws://...'`**（不是 http）—— scheme 用 `ws://` 让 Vite 知道要转发 WebSocket 协议
- **`ws: true`** —— 开启 WS 代理；Vite 默认只代理 HTTP，这个标志让它也认 `Upgrade: websocket` 头并把 upgrade 完整转发给后端
- **`changeOrigin: true`** —— 转发时把 Host 改成 target 主机，某些后端（不包括我们的）会校验

**没有这条代理会怎样？** 浏览器请求 `ws://localhost:5173/ws/shell` → Vite 不认识 → 作为普通 HTTP GET 响应 404 → 前端 `WebSocket` 触发 `onerror`。症状：modal 打开后状态条永远显示 "Connecting…" → "WebSocket connection failed"。

### 3.3 层 3：前端 xterm.js 容器

文件：[frontend/src/components/shell/EmbeddedTerminal.tsx](frontend/src/components/shell/EmbeddedTerminal.tsx)

**3.3.1 初始化**

```ts
const term = new Terminal({
  cursorBlink: true,
  fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
  fontSize: 13,
  scrollback: 10000,
  theme: resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME,
  allowProposedApi: true,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());
term.open(containerRef.current);
fit.fit();
```

几个参数注意：

- `fontFamily` 指定**等宽字体**（serif 或比例字体在终端里光标定位会错）
- `scrollback: 10000` —— 保留 1 万行历史（默认 1000 太少）
- `allowProposedApi: true` —— 某些 addon 需要才能 load
- **FitAddon** 让 xterm.js 根据容器 DOM 尺寸算出正确的 cols/rows
- **WebLinksAddon** 把输出里的 URL 自动识别成可点击链接
- **不加 WebglAddon** —— Canvas 渲染已经够快，WebGL 会多 30KB 包体积 + 偶发 GPU 兼容问题

**3.3.2 连接 WebSocket**

```ts
function buildWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/shell`;
}

const ws = new WebSocket(buildWsUrl());

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'init',
    cwd,
    cols: term.cols,
    rows: term.rows,
  }));
};
```

- 走**相对路径**（`location.host`），自然跟着页面走；开发时是 5173，生产时是 API 部署的 host
- `wss:` 对 `ws:` 由页面协议决定 —— HTTPS 页面必须 WSS

**3.3.3 绑定三路数据**

```ts
// 1. PTY → xterm
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'output') term.write(msg.data);
  else if (msg.type === 'exit') { /* ... */ }
  // ...
};

// 2. xterm → PTY
const inputSub = term.onData((data) => {
  ws.send(JSON.stringify({ type: 'input', data }));
});

// 3. DOM → FitAddon → PTY
const ro = new ResizeObserver(() => {
  // debounce 50ms
  setTimeout(() => {
    fit.fit();
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }, 50);
});
ro.observe(container);
```

**为什么 ResizeObserver 要 debounce**：modal 打开时有动画，短时间内会触发多次 resize；每次都 `pty.resize()` 会引起终端闪烁。50ms 足够覆盖动画帧率又不会让用户察觉到延迟。

**3.3.4 清理**

```ts
return () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  ro.disconnect();
  inputSub.dispose();
  ws.close();
  term.dispose();
};
```

**顺序重要**：
1. 先清 resize timer（否则 timer 回调会访问已 dispose 的 term）
2. 断 ResizeObserver
3. 取消 xterm 的 onData 订阅
4. 关 WS → 后端 `ws.on('close')` → `pty.kill()`
5. dispose term → xterm 释放 canvas 和 DOM

React 的 `useEffect` cleanup 保证 unmount 时必跑一次。

### 3.4 层 4：UI 粘合（modal + 侧栏按钮）

**[TerminalModal.tsx](frontend/src/components/shell/TerminalModal.tsx)** 是全屏覆盖层：

```tsx
<div className="fixed inset-0 z-[70] ...">
  <div className="flex-1 min-h-0 flex flex-col ...">
    <header>Close button</header>
    <EmbeddedTerminal cwd={cwd} />
  </div>
</div>
```

`z-70` 在 drawer (z-50) 和 toast (z-60) 之上。

**ChatSidebar 侧栏按钮** 触发 `onLaunchTerminal(cwd)`，ChatPage 里：

```ts
const handleLaunchTerminal = useCallback((cwd: string) => {
  setTerminalCwd(cwd);        // 触发 <TerminalModal> 挂载
  setSidebarOpen(false);      // 收起 drawer 避免抢焦点
}, []);
```

`terminalCwd` 用 `string | null` 而非 boolean —— null 就 unmount，有值就挂载。React 对 cwd prop 变化会整个 remount `<EmbeddedTerminal>`，等于杀掉旧 PTY 换新的，干净。

---

## 4. 场景演练

### 场景 A：用户从零打开终端

```
用户  ChatSidebar  ChatPage  Modal       EmbeddedTerm  WS      Vite   Backend  node-pty  PowerShell+Claude
 │       │           │         │            │          │       │        │         │           │
 │──点击─▶│           │         │            │          │       │        │         │           │
 │       │─onLaunch─▶│         │            │          │       │        │         │           │
 │       │           │─setCwd─▶│挂载         │          │       │        │         │           │
 │       │           │         │─props──────▶│挂载       │       │        │         │           │
 │       │           │         │            │─new Terminal + FitAddon  │        │         │           │
 │       │           │         │            │─term.open(container)      │        │         │           │
 │       │           │         │            │─fit.fit() → cols/rows   │        │         │           │
 │       │           │         │            │─new WebSocket('/ws/shell')│        │         │           │
 │       │           │         │            │          │──proxy to──▶│──upgrade──▶│         │           │
 │       │           │         │            │          │             │        │─handleUpgrade        │
 │       │           │         │            │          │             │        │─handleConnection     │
 │       │           │         │            │◀─onopen──│             │        │         │           │
 │       │           │         │            │─send init{cwd,cols,rows}│        │         │           │
 │       │           │         │            │          │             │        │─ptySpawn('powershell',│
 │       │           │         │            │          │             │        │          [-NoExit,    │
 │       │           │         │            │          │             │        │           -Command,   │
 │       │           │         │            │          │             │        │           'claude'])  │
 │       │           │         │            │          │             │        │─onData wire          │
 │       │           │         │            │          │             │        │─onExit wire          │
 │       │           │         │            │          │             │        │◀───────spawn──────┐ │
 │       │           │         │            │          │             │        │                   │ │
 │       │           │         │            │          │             │        │                   │ start
 │       │           │         │            │          │             │        │                   │ shell
 │       │           │         │            │          │             │        │                   │ + run claude
 │       │           │         │            │◀───────send {ready}───────────────│                 │ │
 │       │           │         │            │─状态栏变"Ready"                                      │ │
 │       │           │         │            │                                                      │ │
 │       │           │         │            │◀───output: "Welcome to Claude..."───────────────────│
 │       │           │         │            │─term.write(data) → 画屏                              │ │
 │       │           │         │            │                                                      │ │
 │◀─看到 Claude prompt────────────────────────────────────────────────────────────────────────────│
```

几个值得看的细节：

- `fit.fit()` 必须在 `term.open(container)` 之后 —— 只有挂到 DOM 才能测量
- `init` 消息里带 cols/rows 是让 PTY 从**一开始**就知道终端尺寸，Claude 的 prompt 不会因为尺寸不对重画
- `ready` 让前端 UI 从 "Connecting" 变 "Terminal ready"，给用户确定感

### 场景 B：用户按一个 `a`

```
用户按键盘 'a'
  │
  ▼
浏览器 keydown/keypress 事件
  │  → xterm.js 容器 DOM 元素捕获
  ▼
xterm.js 内部 key handler
  │  → 转成字节 "a" (0x61)
  │  → emit onData callback
  ▼
EmbeddedTerminal 的 onData listener
  │
  ▼
ws.send(JSON.stringify({ type: 'input', data: 'a' }))
  │
  │  → WebSocket frame over TCP
  ▼
Vite 5173 (透明转发)
  │
  ▼
Backend /ws/shell handler
  │
  ▼
JSON.parse → { type: 'input', data: 'a' }
  │
  ▼
pty.write('a')
  │  → conpty STDIN 写入 0x61
  ▼
PowerShell 接收
  │  → 进入 Claude CLI 的 stdin
  ▼
Claude CLI REPL 处理
  │  → 追加到当前输入缓冲
  │  → 回显到 stdout (echo mode)
  ▼
pty.onData 触发
  │  → 拿到 "a" 的 bytes (可能还带 ANSI 光标移动)
  ▼
ws.send({ type: 'output', data: 'a' })
  │
  ▼
前端 ws.onmessage
  │
  ▼
term.write('a')
  │  → xterm.js 在光标位置画一个 'a' 字符
  ▼
用户看到屏幕出现 'a'
```

**来回一次的延迟是多少**？本地 + Vite 代理大约 1-3 ms，跨网络就看 RTT。用户感知不到。

**注意回显是 PTY 负责的，不是前端**。这是"真终端"的特征 —— 你看到的每个字符都从后端画回来，不是前端假装的。意味着如果你写了 `Read-Host -AsSecureString`，密码键入不会回显（因为 PowerShell 关了 echo），前端不用特别处理。

### 场景 C：用户拉大浏览器窗口

```
用户拖动浏览器边缘
  │
  ▼
DOM 重新布局 → modal 容器尺寸变化
  │
  ▼
ResizeObserver 回调 (每帧可能触发一次)
  │
  ▼
setTimeout(doResize, 50)  // 有 pending 就清掉再设
  │  (连续 resize 只有最后一次生效)
  ▼
50ms 后 doResize:
  ├── fit.fit()
  │     ├── 测 container 像素尺寸
  │     ├── 除以字符宽/高 → 新 cols/rows
  │     └── term.resize(cols, rows) → 内部重新布局画屏
  │
  └── ws.send({ type: 'resize', cols, rows })
       │
       ▼
     Backend: pty.resize(cols, rows)
       │
       ▼
     conpty 调整终端尺寸
       │
       ▼
     PowerShell / Claude 收到 SIGWINCH (Unix) 或等效通知
       │
       ▼
     下次绘制按新尺寸重排 (如 Claude CLI 的 box-drawing prompt 会重新画)
```

**为什么 debounce**？没 debounce 的话拖动过程中每帧（16ms）都会 `pty.resize` 一次，conpty/Claude 重排 60 次/秒，屏幕会抖。50ms debounce 让用户拖稳了才去重排，体验顺滑。

### 场景 D：用户关闭终端

```
用户点 Close 按钮
  │
  ▼
TerminalModal onClick → onClose
  │
  ▼
ChatPage: setTerminalCwd(null)
  │
  ▼
<TerminalModal open={false}> → 返回 null, unmount
  │
  ▼
<EmbeddedTerminal> 也 unmount
  │
  ▼
useEffect cleanup 执行 (顺序固定):
  1. clearTimeout(resizeTimer)    // 防止 stale timer 回调
  2. ro.disconnect()               // 停止观察 DOM
  3. inputSub.dispose()            // 停止监听键盘
  4. ws.close()                    // 触发 backend 的 close 事件
  5. term.dispose()                // 释放 canvas / 事件绑定
     │
     │
     ▼ (WS close 异步传到后端)
Backend: ws.on('close') → cleanup()
  │
  ▼
pty.kill()
  │
  ▼
conpty 发 signal → PowerShell 收到退出信号
  │
  ▼
Claude CLI 收到 SIGHUP / pipe broken → 退出
  │
  ▼
PowerShell 继承的子进程清理 → PowerShell 本身退出
  │
  ▼
conpty 释放
```

**如果前端没 close，只是拔了网线会怎样**？
- 前端 ws 卡住，term 还在屏幕上
- 后端等 TCP 超时（平台相关，通常几分钟）→ `ws.on('close')` 最终会触发 → PTY 被杀

如果需要更快侦测，可以加 `ping/pong`（我没加，因为本地不会网断）。

### 场景 E：Claude CLI 主动 `/exit`

```
用户在 Claude 里输 /exit
  │
  ▼
Claude 处理 → process.exit(0)
  │
  ▼
PowerShell 收到子进程退出
  │
  ▼
-NoExit 保证 PowerShell 本身继续活着
  │  (prompt 回到用户 home 或 cwd，显示 PS C:\...>)
  ▼
用户可以继续打 git log / ls / etc 或者再次输 claude
  │
  ▼
用户最终打 exit 退 PowerShell
  │
  ▼
PowerShell 真的退出 → PTY 的 process 退出
  │
  ▼
pty.onExit 触发 → ws.send({ type: 'exit', code: 0 })
  │
  ▼
前端 term.write("[exit 0]") + 状态栏显示 "Session ended"
  │
  ▼
(此时 ws 还没 close，用户可以看到最后输出。下一步：用户点 Close 按钮)
```

**为什么不强制 `/exit` 后立刻关 modal**？用户可能想再次 `claude`，或者只是查看状态。我们把关闭时机完全留给用户。

---

## 5. Gotchas（踩过的坑）

### Gotcha 1：`fit.fit()` 在 DOM 挂载前调用

```ts
term.open(container);
fit.fit();  // ← container 刚挂，可能 0x0
```

第一次 fit 可能返回错数（例如 modal 正在打开动画，当下 container 尺寸是 0）。解决：首帧后再 fit 一次：

```ts
window.requestAnimationFrame(() => {
  fit.fit();
  ws.send({ type: 'resize', cols: term.cols, rows: term.rows });
});
```

### Gotcha 2：ESC 键双重含义

- 用户按 ESC 在**终端里**：应当 send 给 PTY（vim / emacs / readline 都用 ESC）
- 用户按 ESC **在外面**（例如 close 按钮有焦点）：应当关 modal

解决：TerminalModal 监听 keydown，但只有当 `event.target` **不在 `.xterm` 容器内**时才 `onClose`：

```ts
const target = e.target as HTMLElement | null;
const inTerminal = target?.closest('.xterm') != null;
if (!inTerminal && e.key === 'Escape') onClose();
```

### Gotcha 3：cwd prop 变化时的完整 remount

EmbeddedTerminal 的 `useEffect` 依赖 `[cwd]`。如果 cwd 变了，React 会：
1. 运行 cleanup（关 ws、kill pty、dispose term）
2. 重新运行 effect（新 ws、新 pty、新 term）

这**正是我们想要的** —— 不同 cwd 本质就是不同 PTY。写这种"整个东西按 key 重建"的 pattern 时要确保 cleanup 足够完整，否则会泄露。

### Gotcha 4：Vite 代理不生效

症状：`WebSocket connection failed`，DevTools Network 里 `/ws/shell` 显示 404 或待完成状态。

常见原因：
- 忘了 `ws: true` → Vite 把它当 HTTP
- `target` 写 `http://...`（应该 `ws://...`）
- Vite 没重启 —— **改 `vite.config.ts` 不会 HMR 自己**，必须 Ctrl+C 重启 dev server

### Gotcha 5：Windows 中文路径乱码

即使用了 PowerShell，如果用户系统是 CHS codepage，Claude CLI 某些输出经过管道转换可能还是会乱。测试：在 cwd `D:/项目/测试/` 下启动终端，看 prompt 和 `pwd` 输出。

我们的 env 没强制 `chcp 65001`，靠 PowerShell 默认 UTF-8 和 `TERM=xterm-256color` 组合。**如果你遇到乱码**，可以在 `pickShell()` 里加：

```ts
args: ["-NoLogo", "-NoExit", "-Command", `chcp 65001 > $null; ${initCmd}`],
```

### Gotcha 6：PTY spawn 失败但 WS 已经 open

如果 `node-pty` 模块加载失败（prebuilt 不匹配当前 Node 版本），`ptySpawn` 直接抛同步错误。我们的处理：

```ts
try {
  pty = ptySpawn(...);
} catch (error) {
  send(ws, { type: "error", message: `Failed to spawn PTY: ${error}` });
  ws.close();
  return;
}
```

前端 ws.onmessage 收到 `{type:'error'}` → 状态栏变红色 + 显示消息。

如果是 `node-pty` 加载就崩溃（require 时），服务器起不来，就根本到不了这一步。这时候 `npm rebuild node-pty` 能解决。

---

## 6. 调试手册

### 症状 → 根因 → 修

| 症状 | 优先看 | 可能原因 |
|------|-------|---------|
| 模态打开 永远 "Connecting…" | Browser DevTools Network → `/ws/shell` | Vite 代理没配（缺 `ws:true`）/ Vite 没重启 |
| "Connecting…" 瞬间变 "error" | Backend console | node-pty 加载失败 / PTY spawn 异常（看 error 消息） |
| "Ready" 但屏幕一直黑 | Backend console + 前端 onmessage log | PTY 没有输出？`FORCE_COLOR` 没设？shell args 错？ |
| 能看到 prompt 但输不进去 | 前端 onData 是否触发 | xterm container 没焦点 → 点一下容器 |
| 调整窗口终端内容错位 | fit.fit() 是否调用 | ResizeObserver 初次是否触发；手动 `term.resize(...)` 试一下 |
| 中文路径乱码 | PowerShell `$OutputEncoding` | 加 `chcp 65001` 或换 `System.Text.UTF8Encoding` |
| 关模态后服务端 log 有 "PTY leak" | `ws.on('close')` 有没有清 pty | 检查 cleanup 调用 pty.kill |
| 浏览器 tab 关了但 backend 说 PTY 还活着 | 底层 TCP 未 FIN | 这是正常的 —— backend 等系统 TCP keepalive（几分钟），之后 pty.kill。可以加 WS ping 加速 |

### 测试命令

**后端 WS endpoint 通不通（bypass Vite，直接打 backend）**：

```bash
# 需要装 wscat: npm i -g wscat
wscat -c ws://127.0.0.1:3000/ws/shell
# 连上后手工发:
> {"type":"init","cwd":"D:/Imperial/individual","cols":80,"rows":24}
< {"type":"ready"}
< {"type":"output","data":"PS D:\\Imperial\\individual>[0m "}
> {"type":"input","data":"ls\r"}
< {"type":"output","data":"..."}
```

**前端直接连**（绕过 UI 调试 WS 协议）：

```js
// 浏览器 console
const ws = new WebSocket(`ws://${location.host}/ws/shell`);
ws.onmessage = e => console.log('<<', JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({
  type:'init',
  cwd:'D:/Imperial/individual',
  cols:80, rows:24
}));
```

**node-pty prebuilt 是否可用**：

```bash
cd backend/claude
node -e "const p = require('node-pty'); console.log(p); p.spawn(process.platform==='win32'?'cmd.exe':'bash',[],{cols:80,rows:24,cwd:process.cwd()}).onData(d=>process.stdout.write(d));"
# 应该看到一个 shell prompt 输出到你当前终端
```

---

## 7. 扩展方向

### 7.1 多终端标签

目前一次一个。要多个，把 `terminalCwd: string | null` 升成 `terminals: Array<{id, cwd}>`，TerminalModal 变成 tab 容器，每个 tab 一个 `<EmbeddedTerminal key={id}>`（key 保证独立 PTY）。

### 7.2 session 持久化（关 modal 不杀 PTY）

Claudecodeui 做法：后端 `ptySessionsMap` 按 `cwd` 做 key 存活 PTY，30min 超时杀。前端 WS close 时后端不 kill pty；重连时按 key 找回。

代价：状态机复杂度 +1 档。收益：切模态时对话上下文不丢。

### 7.3 复制粘贴

xterm.js 默认选中 = 复制到 clipboard（通过 navigator.clipboard）。Ctrl+V 要拦截：

```ts
term.attachCustomKeyEventHandler((e) => {
  if (e.key === 'v' && (e.ctrlKey || e.metaKey) && e.type === 'keydown') {
    navigator.clipboard.readText().then(text => {
      ws.send(JSON.stringify({ type: 'input', data: text }));
    });
    return false;
  }
  return true;
});
```

### 7.4 WebGL 渲染器

大流量滚动（如 `tail -f` 大日志）Canvas 会卡。装 `@xterm/addon-webgl`，`term.loadAddon(new WebglAddon())`。性能提升明显但多 30KB 包 + 偶发上下文丢失需要处理。

### 7.5 自定义 shell

用户可能想用 WSL bash 而非 PowerShell。在 ChatInputTools 或设置里加个选项，前端 init 消息带 `shell: 'wsl'`，后端按用户选择替换 `pickShell()`。

---

## 8. 完整文件索引

**新增**
- [backend/claude/handlers/shell.ts](backend/claude/handlers/shell.ts) — PTY + WebSocket handler（核心，~180 行）
- [frontend/src/components/shell/EmbeddedTerminal.tsx](frontend/src/components/shell/EmbeddedTerminal.tsx) — xterm.js 容器 + WS 客户端（~220 行）
- [frontend/src/components/shell/TerminalModal.tsx](frontend/src/components/shell/TerminalModal.tsx) — 全屏 modal 壳（~65 行）

**修改**
- [backend/claude/runtime/node.ts](backend/claude/runtime/node.ts) — `serve()` 返回 `http.Server` 以便挂 WS
- [backend/claude/runtime/types.ts](backend/claude/runtime/types.ts) — Runtime.serve 返回类型 `void → unknown`
- [backend/claude/cli/node.ts](backend/claude/cli/node.ts) — 启动后 `attachShellWebSocket(server)`
- [backend/claude/app.ts](backend/claude/app.ts) — 移除死掉的 external-terminal 路由
- [backend/claude/handlers/sessions.ts](backend/claude/handlers/sessions.ts) — 删掉旧的 `handleLaunchTerminal` / `findOnPath`
- [frontend/src/api/claudeApi.ts](frontend/src/api/claudeApi.ts) — 移除 `launchTerminal` 方法
- [frontend/src/components/chat/ChatPage.tsx](frontend/src/components/chat/ChatPage.tsx) — `handleLaunchTerminal` 改成打开 modal；渲染 `<TerminalModal>`
- [frontend/vite.config.ts](frontend/vite.config.ts) — 加 `/ws/shell` 的 WebSocket 代理

**依赖**
- 后端：`node-pty@^1.2.0-beta.12`、`ws@^8.14.2`、`@types/ws`（dev）
- 前端：`@xterm/xterm@^5.5.0`、`@xterm/addon-fit@^0.10.0`、`@xterm/addon-web-links@^0.11.0`

**代码量**：大约 **500 行净增**（含注释），核心算法代码不到 300 行。剩下的是样板和 TypeScript 类型。

---

## 9. 一句话小结

> 前端用 **xterm.js** 画终端屏幕，后端用 **node-pty** 开真的 PTY 跑 shell + Claude CLI，中间用一个 **WebSocket** 双向流字节，Vite 的 **ws 代理** 让 dev 环境也能用。关键细节只有三个：**`WebSocketServer({noServer:true})` 让 Hono 和 WS 共用 http.Server**、**vite 代理需要 `ws: true` 否则 404**、**ResizeObserver 必须 debounce 否则终端抖**。其他的都是锦上添花。
