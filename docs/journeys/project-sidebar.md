---
type: journey
status: archived
last_updated: 2026-04-24
tags: [sidebar, ui, theme, picker, claude-cli]
---

# 项目分组侧栏 Debug 全记录

> 起点只是想修 "点击 New Chat 当前对话消失" 的一个小 bug，中途被拖进 sidebar 重构 / 主题系统 / CLI 路径 / 后端 spawn / native 文件夹选择器五条独立战线，每一条都长着一个非直观的坑。这篇复盘按 **每一步为什么那样走** 记录，不是整理最终方案——每一关卡都说明当时假设、证据、被否证、下一步换的方向。

---

## 起点：症状

用户随手报一个 bug：

> "我在当前聊天聊完了之后点 new chat，这个当前对话记录会直接消失"

表面看是 UI bug。直觉推断：`handleNewChat` 应该只清 UI state，不该动磁盘。

---

## 关卡 1：一个反过来的 guard，把意图和行为做成了反义词

打开 `ChatPage.tsx::handleNewChat`：

```ts
const handleNewChat = useCallback(async () => {
  // Delete current session if exists (to clean up temp session)
  if (sessionId && !sessionId.startsWith('new-session-')) {
    await claudeApi.deleteSession(sessionId);
  }
  // ...clear UI state...
}, [...]);
```

注释说 **"清理 temp session"**，但条件判断 `!sessionId.startsWith('new-session-')` 意思是 **"不是 temp session 才删"**——也就是 **删真的 session，保留临时的**。注释和代码意图完全相反。

而前段时间刚把后端的 `handleDeleteSession` 改成 **group-delete**（删整组 fork 文件）—— 这把 bug 的破坏力从 "删 1 个 jsonl" 放大成 "删整组聊天记录"。症状就来了：点 New Chat → 当前对话从磁盘消失 → 侧栏也消失。

**修复**：直接删掉这段 delete 逻辑。"New Chat" 在语义上是 additive，不该碰磁盘。删除是 "Clear Chat" 按钮和侧栏垃圾桶的职责，这两个都有独立入口。

教训：**当一段代码的注释和行为给出相反的 mental model 时，往往说明它早就错了，只是以前某个辅助条件掩盖了症状**。group-delete 一上，遮羞布没了。

---

## 关卡 2：项目分组侧栏（feature，本身简单但牵出三个隐患）

用户追加需求：

> "像 claudecodeui 一样按 project 显示，可以改主题"

分组本身不难——`session.cwd` 后端已经有，前端按 cwd 分组，加个 expand/collapse 和计数徽标。真正有意思的是后面几个 follow-up 在这个结构上继续叠问题：

- 顶部 `+ New Chat` 要改成 `+ New Project` → 引出 **extraProjects** 这个新数据源
- 每行右边要加 `+` 点了在该项目下开新 chat → 引出 **pin workingDirectory** 的需求
- 新项目要磁盘 mkdir → 引出 **后端 `/api/projects/create`**
- 项目要能删 → 引出 **后端 `DELETE /api/projects`**

每多一个 feature，侧栏的 data contract 就多一条边。`extraProjects`（纯前端 localStorage）和 `sessions[].cwd`（后端磁盘权威）两个来源要 merge，埋下 **关卡 8** 的种子。

---

## 关卡 3：主题切换——"跟随系统默认" + 一行组件代码不动

用户说：

> "默认跟随系统，任务 b 再顺遍帮我在 dashboard 界面也实装上"

scan 一下全仓库，11 个 `.tsx` 文件、**83 处** 用了硬编码的 `bg-window-bg` / `card-bg` / `text-primary` 这类 class。逐处加 `dark:` variant 不现实。

参考 claudecodeui 的方案：**CSS variables + 切换 `<html>` 的 class**。Tailwind class 名一行不动，vars 在 `:root.dark` / `:root.light` 下解析成不同值。

实现：
- `tailwind.config.js` 颜色改成 `rgb(var(--color-xxx) / <alpha-value>)` 引用
- `index.css` 两套 vars
- `ThemeContext` 区分 `preference`（`'light' | 'dark' | 'system'`）和 `resolvedTheme`（实际渲染的 `light | dark`）
- 左键切 light↔dark，右键循环 `system → light → dark → system`（蓝色小点标识 system 态）

83 处用法零改动自动切换成功。

这关没坑，但值得记下来这个思路——**架构的 indirection 层做对了，大规模 refactor 可以变成两个文件的改动**。

---

## 关卡 4：升级到新 SDK 后，`"claude"` 字符串变成墓碑

这一关的坑从几天前就开始埋了：

之前为修 resume fork bug，把 `@anthropic-ai/claude-code@1.0.108` 升级成 `@anthropic-ai/claude-agent-sdk`。老 SDK 自带 `cli.js`，spawn 的是 `node path/to/cli.js`；新 SDK 没有 `cli.js`，改成 spawn 独立的 `claude.exe` 原生二进制。升级时按 claudecodeui 的配方改成了：

```ts
pathToClaudeCodeExecutable: process.env.CLAUDE_CLI_PATH || "claude",
```

这在 claudecodeui 的测试环境里是通的。但用户这边发消息就报：

```
ReferenceError: Claude Code native binary not found at claude.
```

**第一反应**：是不是 SDK 不做 PATH 解析？

**查证**：翻 `sdk.mjs` 的 `spawnLocalProcess`：

```js
spawnLocalProcess($){
  let G=JR(X,J,{cwd:Y,stdio:...,signal:W,env:Q,windowsHide:!0});
  //                                         ↑ 没有 shell:true
}
```

`child_process.spawn` 不开 shell、Windows 下 **不做 PATH 解析、不自动加 `.exe`**——于是 `spawn("claude")` 直接 ENOENT。

**至于 claudecodeui 为什么能跑**：猜测他们测试时要么设了 `CLAUDE_CLI_PATH` 环境变量指向绝对路径，要么在 WSL/Linux 跑。Windows + 裸 `"claude"` 这条路在新 SDK 下根本不通。

**修法**：写个 `resolveClaudeBinary()`，按平台 probe 标准安装位置，返回绝对路径。

---

## 关卡 5：`os.homedir()` 干净，但 `validateClaudeCli` 污染——两个世界

接下来关键选择：如何拿到 claude.exe 的绝对路径？

项目里已有一个 `validateClaudeCli()`——但它之前输出的路径是 `C:\Users\����\.local\bin\claude.exe`，中文用户名被 mojibake 成 `����`。用这个路径走不通。

**假设**：Node on Windows 对非 ASCII 路径就是有问题？

**对照实验**：写个独立脚本测 `os.homedir()`：

```js
import os from 'node:os';
const home = os.homedir();
console.log('homedir:', JSON.stringify(home));
console.log('bytes:', Buffer.from(home).toString('hex'));
```

输出：

```
homedir: "C:\\Users\\陈哲"
bytes:   433a5c55736572735ce99988e593b2
              ^^^^^^^^^ ^^^^^^^^^^^^
              "C:\Users\"    "陈哲" 的正确 UTF-8
```

**假设被否**：Node 自己的 `os.homedir()` 走 Win32 W-API，Unicode **完全干净**。

真正出问题的是 `validateClaudeCli()` 里的 **"tracing" 路径**——它会 spawn `claude --version` 之类并捕获 stderr，那个字节流在 Windows 上经过 Node 的 `stdio` 编码层转成字符串时被 GBK 当 UTF-8 解、或反之，产生 mojibake。污染的只是这条旁路，不是 `os.homedir()`。

**方案**：`resolveClaudeBinary()` 完全绕开 `validateClaudeCli`。直接 `os.homedir()` + `path.join` 拼路径，`fs.existsSync` 验证。Unicode-safe by construction。

签名：

```ts
function resolveClaudeBinary(): string {
  if (process.env.CLAUDE_CLI_PATH && existsSync(process.env.CLAUDE_CLI_PATH)) {
    return process.env.CLAUDE_CLI_PATH;
  }
  const home = os.homedir();
  const candidates = process.platform === "win32"
    ? [path.join(home, ".local", "bin", "claude.exe"), /* ... */]
    : [path.join(home, ".local", "bin", "claude"), /* ... */];
  for (const c of candidates) if (existsSync(c)) return c;
  return process.platform === "win32" ? "claude.exe" : "claude";
}
```

用户那台机器上 probe 到 `C:\Users\陈哲\.local\bin\claude.exe`，fs.existsSync 返回 true——路径是干净的 Unicode。

---

## 关卡 6：`"native binary not found"` 不是在讲 binary——是 ENOENT 的谎报

上面都修完，重启后端，用户再发消息：

```
ReferenceError: Claude Code native binary not found at C:\Users\陈哲\.local\bin\claude.exe
```

**路径是对的**（中文没 mojibake），binary 也存在（`fs.existsSync` 刚验过），报错却说找不到。

**第一反应**：SDK 是不是有自己的 fs check？

**查证**：翻 sdk.mjs 的 exit handler：

```js
if (L0(g$)) {
  let G4 = j8
    ? `Claude Code native binary not found at ${G}...`
    : `Claude Code executable not found at ${G}...`;
  this.exitError = ReferenceError(G4);
}
```

**关键发现**：这个错误不是 pre-flight fs 检查，是 **spawn 成功、子进程启动、然后异常退出之后的 fallback 报错**。`L0(g$)` 是对 exit code 的判定。

那就是子进程自己死掉了。第一时间给 handler 加 stderr 捕获：

```ts
stderr: (chunk: string) => {
  console.log("[claude-cli stderr]", chunk.trimEnd());
},
```

让用户重启后端再发消息，把 stderr 输出贴回来。

但这里出了个**插曲**：用户重启失败（端口 3000 被占），贴回来的仍是旧 backend 的报错，没有新 stderr 行。一番 `kill-port` 指令后终于拿到新日志，但 **stderr 还是空**。

空 stderr 意味着子进程**没来得及写任何东西就死了**。那一定不是启动过程的问题。

同时加了 handler 自己的诊断日志：

```ts
console.log("[chat] spawn diag:", {
  resolvedCliPath, cliExists: existsSync(resolvedCliPath),
  cwd, sessionIdInput: sessionId, isResume: ..., userEnvKeys: ...
});
```

用户下一次重试的 log 长这样：

```
[chat] spawn diag: {
  resolvedCliPath: 'C:\\Users\\陈哲\\.local\\bin\\claude.exe',
  cliExists: true,
  cwd: 'test',                         ← ！
  sessionIdInput: 'new-session-...',
  isResume: false,
  userEnvKeys: []
}
```

看到 `cwd: 'test'`——用户在 `+ New Project` prompt 里输入了 `"test"` 这样一个 **相对路径**。后端没做路径校验，直接传给 SDK；SDK 传给 `child_process.spawn({ cwd: "test" })`；Windows 去找当前工作目录下的 `./test` 目录，没有→ENOENT。

**真相**：ENOENT 无论是 **binary 找不到** 还是 **cwd 找不到**，`child_process` 回的都是同一个错误码。SDK 的 fallback message 把所有 ENOENT 一律翻译成 "native binary not found at X"。所以 error message 和真实原因完全脱钩——误导了至少两轮。

**两处修**：

1. 前端 `handleNewProject`：拦截非绝对路径，弹 alert 给例子：
   ```
   "test" is not an absolute path.
   Please enter the full path, e.g.
     D:/Imperial/individual/my-project  (Windows)
     /home/you/my-project               (Linux/Mac)
   ```
2. 后端 handler：spawn 前 `statSync(cwd)`，目录不存在就 yield 人话 error：
   ```
   Working directory does not exist: "test". Create the folder first, or enter a valid absolute path.
   ```

教训：**SDK 的 error message 可能把多个根本原因压缩到一条字符串里。看到它先别信**——查错误在 SDK 代码里的 trigger condition，看它到底在讲什么。

---

## 关卡 7：Native 文件夹选择器，两次 404 挡在两个不同的 server

这关用户要的是把输绝对路径的那个 prompt 升级成系统原生的文件夹选择对话框。方案清晰：

- Browser 的 `showDirectoryPicker()` 出于隐私不给绝对路径
- 但 backend 和 user 在同一台机器（`127.0.0.1`）
- 让 backend 弹系统 dialog，把选择结果返给前端

后端实现：
- Windows → PowerShell `System.Windows.Forms.FolderBrowserDialog`（`-STA` 模式避免挂起）
- macOS → `osascript "POSIX path of (choose folder...)"`
- Linux → `zenity --file-selection --directory`

前端 Dialog 两个模式的输入框旁都加 `Browse` 按钮。写完测一下——

### 7a: 第一个 404，前端炸的 cryptic 错

用户点 Browse：

```
Folder picker failed: Failed to execute 'json' on 'Response': Unexpected end of JSON input
```

**第一反应**：后端抛异常返回了空 body？

**快速判断**：如果是纯粹 404（未注册路由），Hono 默认返回 **plaintext `"Not Found"`**（不是 JSON）。前端 `response.json()` 拿到非 JSON 字符串，抛这个错。

加防御性 parse（先 `response.text()` 再尝试 `JSON.parse`）：下次出错能看到实际 body 前 120 字符 + "restart the backend" 提示。

同时告诉用户：**重启后端**。tsx watch 对 "跨文件新增 export + 新挂路由" 这种改动有时会漏。

### 7b: 重启后还是 404，但这次 error message 是人话了

用户重启后看到：

```
Folder picker failed: HTTP 404
```

好——前端防御性 parse 生效了。但 backend 真的还是 404？

**用 PowerShell 直测 backend**：

```powershell
# GET /api/sessions              → 200
# DELETE /api/projects           → 200 (with proper JSON body)
# POST /api/system/pick-folder   → 弹出系统文件夹对话框
```

三个都通了。**后端完全 OK**。

但浏览器点 Browse 还是 404。看前端 console 仔细看 URL：

```
POST http://localhost:5173/api/system/pick-folder 404 (Not Found)
                    ^^^^
              Vite dev server，不是 backend
```

前端打的是 `localhost:5173`——Vite dev server 的端口。Vite 以代理形式把 `/api/*` 转发到 backend 的 3000 端口。其他路由都好好的，唯独 `/api/system/pick-folder` 404。

**看 `vite.config.ts`**：

```ts
proxy: {
  '/api/chat': { target: 'http://localhost:3000', ... },
  '/api/projects': { target: 'http://localhost:3000', ... },
  '/api/abort': { target: 'http://localhost:3000', ... },
  '/api/sessions': { target: 'http://localhost:3000', ... },
  // ← 没有 /api/system
  '/api/serial': { target: 'http://localhost:8080', ... },
  // ...
}
```

**白名单式 proxy**，一条一条列。没命中任何规则的 `/api/*` 请求被 Vite 当成自己的静态资源请求，它手里没这个文件 → 自己返 404。请求 **从未触达 backend**。

**修**：

```ts
'/api/system': {
  target: 'http://localhost:3000',
  changeOrigin: true,
},
```

Vite 改 config 不会热重载自己，**必须重启 Vite dev server**。重启后 Browse 按钮一点就弹系统对话框。

教训：

- 404 这种错误消息本身没告诉你**是谁返的 404**。看完整 URL。
- 白名单式 proxy 每加一条后端路由都要动 config。**symptomatic footprint 很大**。将来可以合成正则：`'^/api/(chat|projects|abort|sessions|system)'`。
- `vite.config.ts` 改了必须重启——Vite 自己的 config 不走 HMR。

---

## 关卡 8：看上去同一个项目，sidebar 画了两次

用户截图：

```
▼ CHaTEST/test1     0  +    ← 空的
  No chats yet — click + to start one.
▼ CHaTEST/test1     1  +    ← 里面有测试对话
  2026/4/24 13:11:53
  测试测试
  1 messages
```

同一个 displayName，两个不同的 group。sidebar 的 `groupByProject` 按 `session.cwd` 做 Map key：

```ts
for (const session of sessions) {
  const cwd = session.cwd || '';
  let group = map.get(cwd);  // ← 直接用原始 cwd
  // ...
}
for (const path of extraProjects) {
  if (!map.has(path)) map.set(path, { ... });
}
```

两个 data source 的 cwd 字符串形式不同：

| 来源 | 形式 | 例子 |
|------|------|------|
| `sessions[].cwd`（读自 jsonl） | Windows 原始格式 | `D:\CHaTEST\test1` |
| `extraProjects`（New Project dialog 规范过） | 正斜杠 | `D:/CHaTEST/test1` |

两个字符串不等 → Map 里两个 key → sidebar 两个组。

**方案**：引入 `canonicalCwd()` —— 仅作为 Map key 使用，不影响显示和回调：

```ts
function canonicalCwd(cwd: string): string {
  if (!cwd) return '';
  let out = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows FS 大小写不敏感；整体小写（仅限盘符前缀的路径）
  if (/^[A-Za-z]:\//.test(out)) out = out.toLowerCase();
  return out;
}
```

- `D:\CHaTEST\test1` → `d:/chatest/test1`
- `D:/CHaTEST/test1` → `d:/chatest/test1`

两边 Map key 一致，合并成一个 group。组内 `group.cwd` 保留**第一次遇到的原始形式**（sessions 来的那个，是 ground truth），displayName 和回调照常用。

同一套 canonical 比较也得应用在：
- `handleNewProject` 的 dedup 检查（不然 extraProjects 会堆积重复字符串）
- `handleDeleteProject` 的 `hasSessions` 和 `isInExtras` 判断
- `handleDeleteProject` 清理 extras 时 filter：不再按 `p !== cwd`，改为 `canonicalCwd(p) !== targetCanon`——**顺带清掉历史重复条目**，自然 self-heal

教训：**Map 用字符串做 key 之前想清楚——同一个逻辑实体在不同 data source 里可能长不一样**。canonical form 是 single source of truth 的守门员。

---

## 最终 data flow 梳理

```
用户打开 Chat 页面
  │
  ▼
前端 loadProjectsAndSessions
  - GET /api/sessions      → sessions[]（各自带 cwd，Windows-native 反斜杠）
  - localStorage 读 extraProjects  → string[]（正斜杠）
  │
  ▼
ChatSidebar.groupByProject(sessions, extraProjects)
  - canonicalCwd(x) 作为 Map key：backslash→/、盘符路径整体 lowercase
  - group.cwd 存第一次见到的原始形式（优先 session 的）
  - group.sessions 按 updatedAt 倒序
  - groups 按 latestUpdatedAt 倒序（新增 extraProject 的 latestUpdatedAt=now() 置顶）
  │
  ▼
用户点 `+ New Project`
  - NewProjectDialog 弹出
  - 默认 "Create new folder" 模式：Parent + FolderName 两个输入框
  - Parent 从 localStorage['chat-new-project-default-parent'] 预填
  - Browse 按钮 → POST /api/system/pick-folder
      → Windows: PowerShell FolderBrowserDialog
      → 返回选中的绝对路径，回填
  - Submit → handleNewProject(absolutePath)
      → isAbsolute 校验 → alert 如果不是
      → POST /api/projects/create { path } → mkdir -p（幂等）
      → 加入 extraProjects（canonical 去重）
      → handleNewChatInProject(path)
          → setProjects([{ path: cwd }])  // 锁定下一次 handleSend 的 workingDirectory
          → 清 sessionId/displaySessionId/temporarySessionId/messages
          → pushToast("New chat ready in ...", "success")
          → GET /api/sessions → 刷新 sidebar
  │
  ▼
用户在该项目下发消息
  - 前端 handleSend 用 projects[0].path 作为 workingDirectory
  - 后端 resolveClaudeBinary() → 绝对路径到 claude.exe
  - 后端 statSync(cwd) 预检 → 不存在时 yield 人话 error
  - agent SDK spawn claude.exe（Unicode-safe 路径）
  - 新 jsonl 写入 ~/.claude/projects/<encoded-cwd>/
  │
  ▼
用户点某个项目右边的 🗑️
  - hasSessions? 若有 confirm → DELETE /api/projects { cwd }
      → 后端按 encodedName 算出 ~/.claude/projects/<encoded> 目录
      → 删所有 .jsonl、保留其他文件（memory/ 等）
      → 空目录才 rmdir
  - persistExtraProjects(filter 所有 canonical 匹配的) // 顺带清重复
  - 如果当前 activeGroup.cwd canonical 匹配：清 UI
  - 刷新 sessions 列表
```

---

## 今天学到的

1. **注释和代码给出相反 mental model → 往往说明依赖的"隐式前提"已经改了**。之前 delete 的范围小，注释错了也无感；一旦后端变 group-delete，bug 就露头。
2. **`child_process.spawn` 在 Windows 不自动走 PATH、不自动加 `.exe`**。新 SDK 的 `spawn` without shell 使得 `"claude"` 字符串必须是绝对路径。
3. **`os.homedir()` 是 Unicode-safe 的。validateClaudeCli 的 tracing 路径不是**。凡涉及非 ASCII 路径，优先走 Node 内置的 W-API 方法，别走 captured stderr。
4. **SDK 的 error message 可能把多个根本原因压缩成一条**。`"native binary not found"` 可能是 binary 缺失、可能是 cwd 不存在——因为 `child_process` 回给 SDK 的是同一个 ENOENT。看 SDK 代码里的 trigger condition 比信 message 本身靠谱。
5. **HTTP 404 本身不说是谁返的**。URL 里的 host:port 才是。浏览器里看到 `localhost:5173` 的 404 就知道是 Vite dev server 自己返的，不是 backend。
6. **白名单式 proxy config 可维护性低**。每加一条后端 API 要改 config 重启 Vite。合并成正则 key 一次到位更好。
7. **Map 用字符串做 key 之前要 canonical**。尤其 Windows 路径有 3 种轴不确定性：分隔符（`\` vs `/`）、盘符大小写、路径大小写。任一不一致都会造出重复 group。
8. **tsx watch 对跨文件改动的热重载不可靠**。加新 handler export + 在别处挂新路由，watch 偶尔不重新 eval。重启 = 解决 80% 的 "code 和跑着的 server 不一致" 疑问。

每一关都不在代码逻辑本身，都在**工具栈的某个默认行为**上。debug 时知道栈里每一层的默认是什么，比在应用代码里找逻辑 bug 重要得多。
