---
type: guide
status: active
last_updated: 2026-04-24
tags: [slash-commands, testing, api, claude-cli]
---

# Chat UI CLI 指令 & 后端命令测试指南

本文档覆盖两件事：

1. **Slash 命令系统**是怎么实现的 —— 包括前端 local 硬编码命令，和**前端通过后端扫盘、展开、发送来调用"真正的 CLI slash 命令"（skills / plugins / 用户自建 commands）**的完整链路
2. **后端"命令式" API**（slash-commands / pick-file / pick-folder / create-project / delete-project 等）在**开发期手工 + 自动**怎么测

文档目的：新功能开发时，知道在哪里挂钩；定位 bug 时，知道哪一层该看；跑测试时，知道用什么工具打哪个端点。

---

## 1. 架构速览

```
┌───────────────────────────────────────────────┐    ┌──────────────────────────────┐
│  前端（slash 菜单）                           │    │  后端（系统操作 + 文件扫描） │
│                                               │    │                              │
│  LOCAL built-ins (硬编码):                    │    │  GET  /api/slash-commands    │
│  /clear /help /cost /modes /history           │    │  POST /api/slash-commands    │
│  /new /model /compact /init /context          │    │              /expand         │
│                                               │    │  POST /api/system/pick-file  │
│  SERVER-discovered (从磁盘扫描):              │◄──►│  POST /api/system/pick-folder│
│  ~/.claude/skills/<name>/SKILL.md             │    │  POST /api/projects/create   │
│  ~/.claude/commands/*.md                      │    │  DELETE /api/projects        │
│  <cwd>/.claude/skills/<name>/SKILL.md         │    │  POST /api/chat (effort)     │
│  <cwd>/.claude/commands/*.md                  │    │                              │
│  ~/.claude/plugins/cache/**/skills/*/SKILL.md │    │                              │
│                                               │    │                              │
│  mergeCommands(local, server)                 │    │                              │
│       ↓ 派发                                  │    │                              │
│  - local: 直接在浏览器里 execute(ctx)         │    │                              │
│  - server: expand → sendPrompt → /api/chat    │    │                              │
└───────────────────────────────────────────────┘    └──────────────────────────────┘
```

命令按**来源**分两类、按**执行方式**又分两路：

| 类型 | 例子 | 来源 | 执行 | 备注 |
|------|------|------|------|------|
| **Local UI** | `/clear` `/help` `/modes` | 硬编码在 [slashCommands.ts](frontend/src/lib/slashCommands.ts) | 浏览器里跑 `execute(ctx)` | 改 UI 状态、弹 toast、切侧栏 |
| **Local CLI-built-in replicas** | `/compact` `/init` `/context` | 同上 | 部分通过 `sendPrompt` 发提示词给 Claude | 复刻 CLI 本来的 `/init` 等语义 |
| **Server skill** | `/academic-paper-translator`、`/karpathy-guidelines` | 磁盘 `SKILL.md` | 扫 → 展开模板 → `sendPrompt` | CLI 里也是同一文件 |
| **Server command** | 用户自建 `~/.claude/commands/xxx.md` | 磁盘 `.md` | 同上 | 支持 `$ARGUMENTS` `$1-$9` |
| **HTTP 命令式** | `/api/system/pick-file` | — | backend spawn OS dialog / mkdir / rm | 由 UI 按钮或 slash 间接触发 |

**关键设计**：所有命令最终都走**同一条消息管道** (`handleSend`)，无论是本地 `/compact` 还是服务端展开的 skill。这样 `requestId` 跟踪、stream 解析、session fork 处理都共用一套路径。

---

## 2. Slash 命令系统

### 2.1 文件结构

| 文件 | 职责 |
|------|------|
| [frontend/src/lib/slashCommands.ts](frontend/src/lib/slashCommands.ts) | Local 命令注册表、`buildServerCommand`、`mergeCommands`、`getMenuMatches`、`resolveCommand`、`SlashContext` 类型 |
| [frontend/src/components/chat/SlashCommandMenu.tsx](frontend/src/components/chat/SlashCommandMenu.tsx) | 键盘可导航的 dropdown 菜单，显示 source badge |
| [frontend/src/components/chat/ChatInput.tsx](frontend/src/components/chat/ChatInput.tsx) | textarea；监听 `/` 开头、驱动菜单、拦截 Enter |
| [frontend/src/components/chat/ChatPage.tsx](frontend/src/components/chat/ChatPage.tsx) | fetch server 命令、merge、`handleSlashDispatch`、组 SlashContext |
| [frontend/src/api/claudeApi.ts](frontend/src/api/claudeApi.ts) | `listSlashCommands` / `expandSlashCommand` 两个端点包装 |
| [backend/claude/handlers/sessions.ts](backend/claude/handlers/sessions.ts) | `handleListSlashCommands` / `handleExpandSlashCommand` / `walkPluginCache` / `parseFrontmatter` |

### 2.2 触发与检测

检测函数在 [slashCommands.ts](frontend/src/lib/slashCommands.ts)（`commands` 默认是 `SLASH_COMMANDS`，但 ChatInput 会把 merged 列表传进来）：

```ts
export function getMenuMatches(
  input: string,
  commands: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const t = input.trim();
  if (!t.startsWith('/')) return [];
  if (/\s/.test(t)) return [];       // 一旦空格出现，认为进入参数部分，关菜单
  if (t === '/') return commands;
  const lower = t.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(lower));
}
```

**故意的保守设计**：只在"input 整体以 `/` 起头且没空格"时才弹菜单。这样用户在消息里写 `what about /foo` 不会误触。

ChatInput 里用 `useMemo(getMenuMatches(input, commands), [input, commands])` 驱动菜单可见性 —— 无独立 open/close 状态，menuOpen 纯粹是 `matches.length > 0` 的函数。

### 2.3 本地 vs 服务端命令的生命周期

```
┌─ ChatPage 挂载 / cwd 变化时 ────────────────────────┐
│                                                    │
│  useEffect([currentCwd]):                          │
│    claudeApi.listSlashCommands(cwd)                │
│         → GET /api/slash-commands?cwd=<abs>        │
│    setServerCommands(data.commands)                │
│                                                    │
│  useMemo:                                          │
│    mergedCommands = mergeCommands(                 │
│      SLASH_COMMANDS,        ← local 硬编码         │
│      serverCommands         ← 刚 fetch 回来        │
│    )                                               │
│                                                    │
└────────────────────────────────────────────────────┘
         │
         ▼
┌─ ChatInput 每次渲染 ────────────────────────────────┐
│                                                    │
│  <ChatInput commands={mergedCommands} …/>          │
│  menuMatches = getMenuMatches(input, commands)     │
│                                                    │
└────────────────────────────────────────────────────┘
         │
         ▼
┌─ 用户按 Enter 选中某命令 ───────────────────────────┐
│                                                    │
│  resolveCommand(input, commands) → SlashCommand    │
│  onSlashDispatch(cmd, rawInput)                    │
│  ChatPage.handleSlashDispatch:                     │
│    args = rawInput.match(/^\/\S+\s+(.*)$/)?.[1]    │
│    ctx = { setInput, pushToast, sendPrompt, …,     │
│            cwd: currentCwd, args }                 │
│    cmd.execute(ctx)                                │
│                                                    │
└────────────────────────────────────────────────────┘
         │
         ├─ origin=local  → 直接改 state、发 toast 或 sendPrompt
         │
         └─ origin=server → await claudeApi.expandSlashCommand(
                              cmd.name, ctx.args, ctx.cwd
                            )
                            → POST /api/slash-commands/expand
                              { name, args, cwd }
                            ← { prompt: expanded }
                            ctx.sendPrompt(expanded)
                            → 走普通 handleSend → /api/chat 流
```

**没有缓存 command body**：`listSlashCommands` 只返回元信息（name/description/filepath），body 是 dispatch 时才通过 `/expand` 读。这样用户编辑 `SKILL.md` 的改动立刻生效，不用刷新或刷 cache。

**快照而非响应式**：`SlashContext` 在每次 dispatch 时重建，取的是 `useChatStore.getState()` 的快照。因为 execute 是一次性函数调用，不是渲染 —— 不需要订阅式 selector。

### 2.4 SlashContext 接口（完整）

```ts
interface SlashContext {
  setInput: (v: string) => void;              // 命令执行后清输入

  clearMessages: () => void;                  // /clear
  setSessionId: (id: string | null) => void;
  setDisplaySessionId: (id: string | null) => void;
  setTemporarySessionId: (id: string | null) => void;
  clearPendingAttachments: () => void;

  pushToast: (text, kind?) => void;            // 绝大多数命令用它输出
  openSidebar: () => void;                     // /history
  openNewProjectDialog: () => void;            // /new
  sendPrompt: (text: string) => void;          // /compact + 所有 server 命令

  messages: AllMessage[];                      // /cost /model /context 读历史
  permissionMode / thinkingMode / effortMode;  // /modes 读当前设定

  cwd: string | null;                          // server 命令传给 /expand
  args: string;                                // "/review PR-123" → "PR-123"
}
```

关键取舍：**命令不自己调 /api/chat**。所有发送都走 `sendPrompt` → ChatPage 的 `handleSend`，共用 requestId 追踪、stream 解析、session fork 处理、附件合成、effort/thinking 传递。

### 2.5 当前命令构成

**Local 硬编码（10 条，在 [slashCommands.ts::SLASH_COMMANDS](frontend/src/lib/slashCommands.ts)）**：

| 命令 | 行为 | 技术路径 |
|------|------|---------|
| `/clear` | 清消息 / sessionId / 临时 ID / 附件 / input | 改 store |
| `/compact` | 发送总结 prompt，提示随后 `/clear` | `sendPrompt` |
| `/cost` | toast：最近 result 的 cost + tokens + duration | 读 `messages` |
| `/help` | toast：列出所有本地命令名 + description | - |
| `/history` | 打开侧栏 drawer | `openSidebar` |
| `/new` | 弹 New Project dialog | `openNewProjectDialog` |
| `/model` | toast：最近 init 消息里的 `model` 字段 | 读 `messages` |
| `/modes` | toast：当前 Perm / Think / Effort 及解释 | 读 ctx |
| `/init` | 发 prompt 让 Claude 扫项目生成 `CLAUDE.md` | `sendPrompt` |
| `/context` | 聚合 session 所有 result 的 token + cost | 读 `messages` |

**Server 发现（数量按用户磁盘和插件而定）**—— 由 [backend::handleListSlashCommands](backend/claude/handlers/sessions.ts) 扫出：

| 源 | 文件模式 | badge 标签 |
|----|---------|-----------|
| user skill | `~/.claude/skills/<name>/SKILL.md` | `user skill` |
| user command | `~/.claude/commands/*.md` | `user cmd` |
| project skill | `<cwd>/.claude/skills/<name>/SKILL.md` | `project skill` |
| project command | `<cwd>/.claude/commands/*.md` | `project cmd` |
| plugin skill | `~/.claude/plugins/cache/**/skills/<name>/SKILL.md`（深度限 6） | `plugin skill` |
| plugin command | `~/.claude/plugins/cache/**/commands/*.md` | `plugin cmd` |

Dedup 顺序：`project > user > plugin`（同名时 project 赢）。Local built-ins 赢所有 server 名字冲突。

### 2.6 加一条本地命令

1. 在 [slashCommands.ts::SLASH_COMMANDS](frontend/src/lib/slashCommands.ts) 数组 push 一个 `SlashCommand`
2. 如果需要新上下文（`openSettings()` 之类），在 `SlashContext` 加字段，在 [ChatPage.handleSlashDispatch](frontend/src/components/chat/ChatPage.tsx) 组装时传进去
3. 不改菜单 UI、不改键盘处理、不改 merge 函数 —— 自动挂上

```ts
{
  name: '/dashboard',
  description: 'Jump to the sensor dashboard',
  icon: '📊',
  execute: (ctx) => {
    window.location.href = '/dashboard';
    ctx.setInput('');
  },
},
```

### 2.7 加一条服务端命令（CLI 自带方式）

**零代码**——在下面任一位置扔个 markdown 文件：

```
~/.claude/skills/review-pr/SKILL.md                (全局 skill)
~/.claude/commands/migrate.md                      (全局命令)
<project>/.claude/skills/domain-check/SKILL.md     (项目级)
<project>/.claude/commands/release.md              (项目级)
```

文件头 YAML frontmatter 至少要有 `description`，body 是传给 Claude 的提示模板：

```markdown
---
description: Draft a PR summary from the current diff.
argument-hint: [audience]
---
Please produce a PR summary targeted at {$1 or "reviewers"}. Read the
latest `git diff` and cover: what changed, why, testing done, and any
follow-ups. Keep under 10 lines.

Full user args: $ARGUMENTS
```

**替换规则**（后端 [handleExpandSlashCommand](backend/claude/handlers/sessions.ts)）：
- `$ARGUMENTS` → 命令名之后的完整字符串
- `$1` `$2` ... `$9` → 按空格分开的位置参数，未提供时替空串

用户输 `/review-pr team-lead` → 前端 `args="team-lead"` → 后端 `$ARGUMENTS=team-lead`、`$1=team-lead` → 展开后的 prompt 当普通消息发出。

**项目级命令的"作用域"**：后端按 `?cwd=<abs>` 参数决定要扫哪个项目的 `.claude/` 目录。前端通过 `useEffect([currentCwd])` 刷新，切项目自动换一组可用命令。

### 2.8 键盘交互

ChatInput 单一 handler `handleKeyDown` 根据 `menuOpen` 分路由：
- `ArrowUp/Down` → cycle `activeMenuIdx` (mod length)
- `Enter`（无 Shift）/ `Tab` → 派发 `menuMatches[activeMenuIdx]`
- `Escape` → `setInput('')`（清掉 `/` 前缀 = 菜单关）
- 其他按键放行，textarea 照常处理，input 变 → 菜单过滤自动更新

**为什么 menu 用 `onMouseDown` 而不是 `onClick`**：鼠标点 menu 会让 textarea blur，再走 click 时 selection 已丢失。`mouseDown + preventDefault` 在 blur 前拦住事件。

---

## 3. 后端 "命令式" HTTP API

这部分是**backend 提供的、像 CLI 子命令一样运作的 HTTP 端点**。每个都是幂等的、单次的、无状态的动作，不长连接、不 stream（除了 `/api/chat`）。

### 3.1 端点速查

| Method | Path | 用途 | Handler | 调用方 |
|--------|------|------|---------|--------|
| GET | `/api/slash-commands?cwd=<abs>` | 扫 skills/commands/plugins 返回元信息列表 | [sessions.ts::handleListSlashCommands](backend/claude/handlers/sessions.ts) | ChatPage mount 时 + cwd 变化时 |
| POST | `/api/slash-commands/expand` | 读文件、做 `$ARGUMENTS/$1-$9` 替换、返回展开的 prompt | [sessions.ts::handleExpandSlashCommand](backend/claude/handlers/sessions.ts) | 用户选中 server 命令时 |
| POST | `/api/system/pick-file` | 弹 OS 原生文件选择器 | [sessions.ts::handlePickFile](backend/claude/handlers/sessions.ts) | ChatInput 的 `+` 按钮 |
| POST | `/api/system/pick-folder` | 弹 OS 原生文件夹选择器 | [sessions.ts::handlePickFolder](backend/claude/handlers/sessions.ts) | NewProjectDialog 的 Browse 按钮 |
| POST | `/api/projects/create` | `mkdir -p` | [sessions.ts::handleCreateProject](backend/claude/handlers/sessions.ts) | `handleNewProject` |
| DELETE | `/api/projects` | 删掉 cwd 下所有 jsonl | [sessions.ts::handleDeleteProject](backend/claude/handlers/sessions.ts) | 侧栏项目 🗑️ 按钮 |
| POST | `/api/chat` (NDJSON stream) | 发一轮消息并接收流式响应（含 effort/thinking 选项） | [chat.ts::handleChatRequest](backend/claude/handlers/chat.ts) | ChatInput 提交 |

路由注册：[backend/claude/app.ts:74-91](backend/claude/app.ts)

**Vite proxy** ([frontend/vite.config.ts](frontend/vite.config.ts)) 白名单需要包含：
```
/api/chat, /api/projects, /api/abort, /api/sessions,
/api/system, /api/slash-commands
```
漏哪一个，前端调用对应端点会得到 Vite dev server 自己的 404 —— 排查时先看这里（见 `PROJECT_SIDEBAR_DEBUG_JOURNEY.md` 关卡 7b）。

### 3.2 GET /api/slash-commands

```jsonc
// query: ?cwd=D%3A%2FImperial%2Fmy-project
// response
{
  "commands": [
    {
      "name": "/academic-paper-translator",
      "description": "翻译学术论文 PDF 文件...",
      "source": "user-skills",
      "filepath": "C:/Users/陈哲/.claude/skills/academic-paper-translator/SKILL.md"
    },
    {
      "name": "/karpathy-guidelines",
      "description": "Behavioral guidelines to reduce common LLM coding mistakes...",
      "source": "plugin-skills",
      "filepath": "C:/Users/陈哲/.claude/plugins/cache/karpathy-skills/.../skills/karpathy-guidelines/SKILL.md"
    },
    // ... 每个 .md 文件一条
  ]
}
```

实现要点：
- 5 个源并行扫（user commands/skills + project commands/skills + plugin cache walk），Promise.all
- plugin walker 是深度上限 6 的递归扫描器，按 `<root>/**/skills/<name>/SKILL.md` 和 `<root>/**/commands/*.md` 匹配
- 只读 YAML frontmatter（name / description / argument-hint），**不读 body**（body 大，按需通过 `/expand` 拉）
- Dedup 顺序：project > user > plugin

**查不到用户 cwd 时**：项目扫描部分跳过，只返回全局（user + plugin）结果。

### 3.3 POST /api/slash-commands/expand

```jsonc
// request
{
  "name": "/review-pr",
  "args": "team-lead urgent",
  "cwd": "D:/Imperial/my-project"
}

// response
{
  "prompt": "Please produce a PR summary targeted at team-lead...",
  "source": "user-commands",
  "argumentHint": "[audience]"
}

// 未知命令
{ "error": "Unknown command: /foo" }  // 404
```

实现要点：
- **重新扫磁盘**（而不是缓存 `/list` 的结果）→ 用户实时编辑 SKILL.md 不需要刷新
- `parseFrontmatter` 切掉 `---` 之间的 YAML，剩下的是 body
- 替换：`$ARGUMENTS` 先（防止 $1/$2 里的数字被当成 `$ARGUMENTS` 的一部分吃掉），`$1–$9` 后，用 negative lookahead `(?!\d)` 避免 `$12` 被拆
- 返回的 `prompt` 直接可用作下一条 `/api/chat` 的 `message` 字段

### 3.4 POST /api/system/pick-file

```jsonc
// request
{
  "multiple": true,
  "initialDir": "D:/Imperial/individual",
  "includeContent": true,
  "maxContentBytes": 51200
}

// response (正常)
{
  "files": [
    {
      "path": "D:/foo/bar.py",
      "filename": "bar.py",
      "sizeBytes": 2134,
      "mimeType": "text/plain",
      "kind": "text",
      "content": "def main():\n    ..."
    }
  ]
}

// response (用户取消)
{ "files": [] }

// response (环境缺 zenity, Linux only)
{ "files": [], "error": "Native file picker unavailable..." }  // 501
```

实现要点：
- Windows 用 PowerShell `OpenFileDialog`，`-STA` 防挂起（默认 MTA 会卡）
- macOS `osascript` + `choose file` 
- Linux `zenity --file-selection`
- Text 识别基于后缀白名单（`TEXT_EXTENSIONS` in [sessions.ts](backend/claude/handlers/sessions.ts)）
- 文件 `> maxContentBytes` 自动降级为 `kind: 'other'`，只返 meta

### 3.5 POST /api/system/pick-folder

同上但单选文件夹。

```jsonc
// request
{ "initialDir": "D:/Imperial/individual" }
// response
{ "path": "D:/Imperial/individual/my-project" }   // 或 { "path": null } 取消
```

### 3.6 POST /api/projects/create

```jsonc
// request
{ "path": "D:/Imperial/individual/new-thing" }

// response
{ "success": true, "path": "D:/Imperial/individual/new-thing" }

// 非绝对路径 / 权限不足
{ "error": "Path must be absolute..." }  // 400
{ "error": "Failed to create directory: EACCES..." }  // 500
```

幂等 —— 目录已存在不会报错。

### 3.7 DELETE /api/projects

```jsonc
// request
{ "cwd": "D:/Imperial/individual/throwaway" }

// response
{
  "success": true,
  "cwd": "D:/Imperial/individual/throwaway",
  "deletedJsonlCount": 3,          // ~/.claude/projects/<encoded>/ 下删掉的 jsonl 数
  "keptNonHistoryCount": 0,        // 残留的非 jsonl 文件（比如 memory/ 目录）
  "failedCount": 0
}
```

**不会** `rm -rf` 项目目录本身 —— 只删 .jsonl，保留其他文件。目录为空才 rmdir。

### 3.8 POST /api/chat

NDJSON stream 端点。今次扩充的字段：

```jsonc
// request (ChatRequest)
{
  "message": "...",
  "requestId": "req_xxx",
  "sessionId": "uuid-or-new-session-timestamp",
  "workingDirectory": "D:/project",
  "permissionMode": "plan",                          // 可选
  "effort": "high",                                  // 可选 (NEW)
  "thinking": { "type": "enabled", "budgetTokens": 10000 }  // 可选 (NEW)
}
```

handler 条件把这些加到 SDK `query()` options：

```ts
// handlers/chat.ts
const queryOptions = { prompt, options: {
  ...(permissionMode ? { permissionMode } : {}),
  ...(effort ? { effort } : {}),
  ...(thinking ? { thinking } : {}),
  ...
}};
```

---

## 4. 开发期手工测试

### 4.1 PowerShell（推荐 —— Windows 上默认都有）

**查端口占用**（诊断"我改了代码但前端还看到 404"）：
```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object {
  $p = Get-Process -Id $_.OwningProcess
  "$($p.Id)  $($p.ProcessName)  $($p.StartTime)"
}
```

**测路由是否注册**：
```powershell
# 已知好的路由
Invoke-WebRequest -Uri http://127.0.0.1:3000/api/sessions -UseBasicParsing |
  Select-Object StatusCode
# → 200

# 新加的路由
Invoke-WebRequest -Method Post `
  -Uri http://127.0.0.1:3000/api/system/pick-file `
  -ContentType 'application/json' `
  -Body '{"multiple":false,"includeContent":true,"maxContentBytes":50000}' `
  -UseBasicParsing -TimeoutSec 300
# → 会阻塞直到用户在 OS 对话框选完文件；返回 { files: [...] }
```

**测 create-project**：
```powershell
Invoke-WebRequest -Method Post `
  -Uri http://127.0.0.1:3000/api/projects/create `
  -ContentType 'application/json' `
  -Body '{"path":"D:/throwaway/test-project"}' `
  -UseBasicParsing
```

**测 delete-project（只删 jsonl）**：
```powershell
Invoke-WebRequest -Method Delete `
  -Uri http://127.0.0.1:3000/api/projects `
  -ContentType 'application/json' `
  -Body '{"cwd":"D:/throwaway/test-project"}' `
  -UseBasicParsing
```

**测 slash command 发现**（期望看到 user/plugin skills 列表）：
```powershell
# 不带 cwd — 只返全局（user + plugin）
Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/slash-commands' -UseBasicParsing |
  Select-Object -ExpandProperty Content | ConvertFrom-Json | Select-Object -ExpandProperty commands |
  Select-Object name, source, description -First 20

# 带 cwd — 加上项目级
$cwd = [uri]::EscapeDataString('D:/Imperial/individual/esp32_sensor_dashboard')
Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/slash-commands?cwd=$cwd" -UseBasicParsing |
  Select-Object -ExpandProperty Content | ConvertFrom-Json | Select-Object -ExpandProperty commands |
  Group-Object source | Select-Object Count, Name
```

**测 slash command 展开**（期望看到原 SKILL.md body 里的文字）：
```powershell
$body = @{
  name = '/academic-paper-translator'
  args = ''
  cwd  = 'D:/Imperial/individual/esp32_sensor_dashboard'
} | ConvertTo-Json

Invoke-WebRequest -Method Post `
  -Uri http://127.0.0.1:3000/api/slash-commands/expand `
  -ContentType 'application/json' `
  -Body $body -UseBasicParsing |
  Select-Object -ExpandProperty Content | ConvertFrom-Json |
  Select-Object -ExpandProperty prompt | Select-Object -First 400
```

**测 $ARGUMENTS 替换**（用你自己 `.md` 里含 `$ARGUMENTS` / `$1` 的命令）：
```powershell
$body = @{
  name = '/some-user-cmd'
  args = 'alpha beta gamma'
} | ConvertTo-Json
Invoke-WebRequest -Method Post `
  -Uri http://127.0.0.1:3000/api/slash-commands/expand `
  -ContentType 'application/json' -Body $body -UseBasicParsing | ... # 看展开后的 prompt
```

### 4.2 curl (Git Bash / WSL)

```bash
# 发一次 chat 消息（带 effort/thinking）
curl -N -X POST http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "message": "reply just pong",
    "requestId": "req_manual_test_1",
    "workingDirectory": "D:/Imperial/individual/learn/skillsLearn",
    "permissionMode": "default",
    "effort": "high",
    "thinking": { "type": "enabled", "budgetTokens": 10000 }
  }'
```

`-N` 关掉 buffering，让你看到实时的 NDJSON 行。

### 4.3 浏览器 DevTools

打开 DevTools → Network → 过滤 XHR/Fetch：
- 提交消息 → 能看到 `/api/chat` 的 NDJSON 流
- 点项目 → 看 `/api/sessions/:id/messages`
- 点 `+` 附件 → 看 `/api/system/pick-file`

或者直接在 Console 里测：
```js
fetch('/api/system/pick-file', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ multiple: true })
}).then(r => r.json()).then(console.log);
```

**注意**：浏览器这里 `/api/*` 走的是 Vite dev server 的 proxy（`localhost:5173`），需要 [vite.config.ts](frontend/vite.config.ts) 里有对应白名单条目。见 `PROJECT_SIDEBAR_DEBUG_JOURNEY.md` 关卡 7b。

### 4.4 自动化单元测试（vitest）

后端测试在 [backend/claude/handlers/](backend/claude/handlers/)：

```bash
cd d:/Imperial/individual/esp32_sensor_dashboard/backend/claude
npm test
```

覆盖的是 handler 级行为（mock 掉 SDK 的 `query`，断言 handler 用对的参数调它）。

**例子** —— 验证 `permissionMode` 正确透传（[chat.test.ts](backend/claude/handlers/chat.test.ts)）：

```ts
it("should handle permissionMode alongside other parameters", async () => {
  const chatRequest: ChatRequest = {
    message: "Test message with all params",
    workingDirectory: process.cwd(),   // 真实存在的 dir，避开 statSync 的预检
    permissionMode: "plan",
    // ...
  };
  mockContext.req.json = vi.fn().mockResolvedValue(chatRequest);
  await handleChatRequest(mockContext, requestAbortControllers);
  await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled());
  expect(mockQuery).toHaveBeenCalledWith({
    prompt: "Test message with all params",
    options: expect.objectContaining({
      permissionMode: "plan",
      cwd: process.cwd(),
      // ...
    }),
  });
});
```

**加测试的模板**：写一个断言新加的字段（如 `effort` / `thinking`）确实按期望传给了 `query()`。照搬上面这个用例的 ceremony，改掉 input + expected 即可。

**限制**：
- 不会启真 CLI；`query()` 是 mock 的
- 不测 PowerShell / osascript / zenity 集成 —— 因为 CI 里没有 GUI
- `/api/system/pick-*` 这类端点建议用 4.1 的 PowerShell 手工测

---

## 5. 端到端验收剧本（一次性拷贝）

每次改完 chat 相关代码，跑一遍：

```
1. 重启 backend（确认 log 里没 EADDRINUSE）
2. 浏览器打开 chat 页，DevTools Network 开着

3. 工具条 pills 默认显示：
   - Perm: Ask    Think: Auto    Effort: Auto
   - 中间如果选了项目会显示 📁 xxx/xxx

4. 点 + 附件按钮：
   → 看到 /api/system/pick-file 请求
   → 弹原生选择器 → 选文件 → 回传后 textarea 上方出现 pill

5. 输入 / ：
   → 菜单弹出「10 条 local 内置 + N 条服务端发现」
   → DevTools Network 里应看到 /api/slash-commands?cwd=... 的 GET
   → Server-discovered 条目右边有灰色 badge（`user skill` / `plugin skill` / …）

6. 输 /clear → Enter：
   → 消息区清空，pills 清空，session id 清空

7. 输 /modes：
   → toast 三行显示当前 Perm/Think/Effort

8. 点 Perm pill 一次：
   → 变 Perm: Plan
   → toast 弹出 "Plan — Claude drafts a plan..." 完整描述
   → 刷新页面 → 仍然是 Plan（localStorage 持久）

9. 发一条真消息："reply just pong"：
   → backend console 应看到 [chat] spawn diag 里有 permissionMode: 'plan'
   → 回应的 result → /cost 能显示 tokens + 费用

10. 切到 Effort pill = High，再发一条消息：
    → spawn diag 里多 effort: 'high'
    → Claude 回应应比 Auto 时更慢更详细

11. /history → 侧栏抽屉打开
12. /new → 弹 New Project 对话框
    → Browse → 弹原生文件夹选择器
    → 选完后路径回填
    → Create & open → /api/projects/create 被调

13. /init → 不弹 toast、不开 dialog，直接发 prompt 让 Claude 写 CLAUDE.md
    → DevTools 看到 /api/chat 的 stream
    → 消息区显示 "Please scan this project and create a CLAUDE.md..."

14. /context → toast 显示当前 session 的累计 input/output/cache tokens + 估费

15. 选一条服务端 skill（例如 /karpathy-guidelines）：
    → DevTools 看到 /api/slash-commands/expand 的 POST（返回展开后的 prompt）
    → 紧接着看到 /api/chat 的 NDJSON stream
    → Claude 用 skill 定义的风格回应

16. 在 ~/.claude/commands/test.md 新建一个文件（frontmatter + body 带 $ARGUMENTS）：
    → 切项目后 /api/slash-commands 列表里多一条 /test
    → 输 "/test hello world"，args="hello world" 传给 /expand
    → 返回的 prompt 里 $ARGUMENTS 被替换成 "hello world"

17. 切项目到一个有 .claude/skills/ 的 cwd：
    → useEffect 触发 /api/slash-commands 重取
    → 菜单里多几条 `project skill` badge 的命令
    → 切回没有的项目，这些条目消失
```

---

## 附录：文件索引

**前端**
- [frontend/src/components/chat/ChatInput.tsx](frontend/src/components/chat/ChatInput.tsx)
- [frontend/src/components/chat/ChatInputTools.tsx](frontend/src/components/chat/ChatInputTools.tsx)
- [frontend/src/components/chat/SlashCommandMenu.tsx](frontend/src/components/chat/SlashCommandMenu.tsx)
- [frontend/src/components/chat/AttachmentPills.tsx](frontend/src/components/chat/AttachmentPills.tsx)
- [frontend/src/lib/slashCommands.ts](frontend/src/lib/slashCommands.ts)
- [frontend/src/lib/attachments.ts](frontend/src/lib/attachments.ts)
- [frontend/src/store/chatStore.ts](frontend/src/store/chatStore.ts)
- [frontend/src/api/claudeApi.ts](frontend/src/api/claudeApi.ts)

**后端**
- [backend/claude/handlers/chat.ts](backend/claude/handlers/chat.ts)
- [backend/claude/handlers/sessions.ts](backend/claude/handlers/sessions.ts)
- [backend/claude/app.ts](backend/claude/app.ts)
- [backend/shared/types.ts](backend/shared/types.ts)

**测试**
- [backend/claude/handlers/chat.test.ts](backend/claude/handlers/chat.test.ts)
- [backend/claude/handlers/](backend/claude/handlers/) （其他 test 文件）
