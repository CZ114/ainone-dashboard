# Claude Session 一致性 Debug 全记录

> 一个 "点击老聊天记录继续聊天" 的 bug，牵出 SDK 行为、CLI 打包方式、Windows 非 ASCII 路径编码三层互相独立的问题。过程中多次被假设误导、被实证纠正，最后靠一次"手动测对照组"彻底厘清。这篇复盘不是讲最终方案，而是讲**每一步为什么那样走**——假设、证据、被否证、换方向。

---

## 起点：症状

用户在自建 Web UI 里点侧栏的老 session 继续聊天，观感上是在 resume，但 browser console 的 debug 日志另有所指：

```
[DEBUG] system/init received, session_id: bfe89d84... requestId: req_..._851z6mbyy
[DEBUG] handleSend - sidToSend: bfe89d84...
[DEBUG] system/init received, session_id: cb85f213...   ← 服务器返回了新 id
[DEBUG] handleSend - sidToSend: bfe89d84...              ← 下一轮还在发老 id
[DEBUG] system/init received, session_id: 41e87a1c...   ← 又一个新 id
```

**肉眼推断：**
- 后端每轮都给回一个全新的 session_id
- 前端完全忽略这些新 id，继续发最初的
- 表面在 resume，实际每轮分叉

问题核心是 "前端该不该跟随新 id"？直觉说"当然要跟"，但要先看代码为什么没跟。

---

## 关卡 1：前端不吸收服务器返回的新 session id

**定位路径**：`useStreamParser.ts` 收到 `system/init` → 调 `replaceTemporarySession` → 看 `chatStore.ts`：

```ts
replaceTemporarySession: (realSessionId, requestId) => {
  if (requestId && state.lastSessionUpdateRequestId !== null &&
      state.lastSessionUpdateRequestId !== requestId) {
    return;  // 并发守卫
  }
  if (state.temporarySessionId) {   // ← 只在新 chat 时生效
    set({ sessionId: realSessionId, temporarySessionId: null, ... });
  }
},
```

两处有病：

1. **条件判断的 if** 只在 `temporarySessionId` 非空时更新 —— 这字段只有"新 chat 且没拿到真实 id"那个瞬间才有值；resume 时 `temporarySessionId` 恒为 null，整个 set 直接被跳过
2. **并发守卫** 用的是 `lastSessionUpdateRequestId`，一旦第一次赋值就再也不清空 —— 之后每个请求的 requestId 都和它不匹配，永远被拒

**修复思路：**
- 服务器返回的 session_id 就是权威，不管新 chat 还是 resume 都采纳
- 并发守卫换成 `currentRequestId`（每次请求结束会被 `setCurrentRequestId(null)` 清掉），只在真有 in-flight 冲突时拒

```ts
replaceTemporarySession: (realSessionId, requestId) => {
  if (requestId && state.currentRequestId && state.currentRequestId !== requestId) {
    return;  // 只拒真正的 stale 响应
  }
  set({
    sessionId: realSessionId,
    temporarySessionId: null,
    lastSessionUpdateRequestId: requestId || null,
  });
},
```

**这一步让 sessionId 开始跟随服务器的新 id 了。** 以为完事了，其实只是揭开第一层。

---

## 关卡 2：意外跳出来的 404 模型错误

改完 session 问题，用户反馈另一个报错：

```
API Error: 404 {"type":"error","error":{"type":"not_found_error",
  "message":"model: minimax-m2.7"}, "request_id":"req_011CaM1N..."}
```

关键线索：`request_id` 是 `req_011CaM1...` 格式——**这是 Anthropic 官方 API 的 id 格式**，不是 MiniMax 的。用户说他命令行里已经切回 Sonnet 4.7 了，只有 Web UI 还在报 minimax。

搜代码找 `minimax`：

```ts
env: {
  ...process.env,
  ...userEnv,
  ANTHROPIC_AUTH_TOKEN: userEnv.ANTHROPIC_AUTH_TOKEN || getEnv("...") || "",
  ANTHROPIC_BASE_URL: userEnv.ANTHROPIC_BASE_URL || getEnv("...") || "",
  ANTHROPIC_MODEL: "MiniMax-M2.7",   // ← 写死
},
```

**根因**：后端硬编码了 `ANTHROPIC_MODEL`，无视用户在 `~/.claude/settings.json` 里切到什么模型。`ANTHROPIC_BASE_URL` 跟随用户设定切到 Anthropic 官方 endpoint 了，但 model 字段还在发 `MiniMax-M2.7`，Anthropic 自然 404。

**修复**：让后端的 env 注入和命令行本身**完全对齐**——读 `~/.claude/settings.json` 的 env 块，全透传（不写死那 3 个 key）：

```ts
// 和 Claude CLI 自己的 env-loading 保持一致：读全量
async function getUserEnvFromSettings(): Promise<Record<string, string>> {
  // ...
  for (const [key, value] of Object.entries(settings.env)) {
    if (typeof value === "string" && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

// queryOptions 里：
env: {
  ...process.env,
  ...userEnv,
  // 不再硬编码 ANTHROPIC_MODEL / ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN
},
```

**这个 bug 跟 session 无关，但是"通用适配"思路的一次预演：别自己瞎写，follow 上游约定。**

---

## 关卡 3：修好了 session id 跟随，发现还在 fork

sessionId 已经会跟着新 id 跑了，按理说 context 就该保留了。但用户又发来一段 log：

```
[DEBUG] handleSend - sessionId: new-session-...  workingDirectory: .../skillsLearn
[DEBUG] system/init received, session_id: 6a4e3d3e-656d-...  ← 第 1 轮
[DEBUG] handleSend - sessionId: 6a4e3d3e-656d-...
[DEBUG] system/init received, session_id: 259ec50a-70f8-...  ← 第 2 轮居然又是新 id
[DEBUG] handleSend - sessionId: 259ec50a-70f8-...
[DEBUG] system/init received, session_id: 30180cc0-6341-...  ← 第 3 轮还是新 id
```

用户问："这合理吗？"

**本能地就要上磁盘验证**——别停留在 API 层面猜。去 `~/.claude/projects/.../` 看：

```bash
$ wc -l 6a4e3d3e*.jsonl 259ec50a*.jsonl 30180cc0*.jsonl
   3 6a4e3d3e-...jsonl   # turn 1: 1 user + 1 assistant
   4 259ec50a-...jsonl   # turn 1-2: 2 + 2
   7 30180cc0-...jsonl   # turn 1-3: 3 + 3
```

**证据确凿**：每轮 `--resume` 都生成一个新 jsonl 文件，新文件完整复制之前所有消息 + 本轮新内容。**上下文没丢**（最新 fork 包含全部历史），但 session id 跳、磁盘文件堆。

这是 Claude Code SDK print 模式下 `--resume` 的既定行为——**fork on resume**。interactive 模式不是这样（CLI 进程不退出，一直 append 到同一个文件），print 模式是每次 spawn 一个新进程，靠 `--resume` 传递历史，CLI 顺手分叉保留分支点。

此时有 3 条路：
- **A. 删除旧 fork**：每次 resume 成功后把上一个文件删掉
- **B. SDK streaming input 重写**：一个 `query()` 喂多轮 `AsyncIterable`，进程长连
- **C. 读侧分组聚合**：不动写侧，读 session 列表时按根消息 uuid 把一组 fork 合成一条

直觉是 A 最简单，但"万一哪天想分叉" 就没法了。于是想先看看别人怎么做。

---

## 关卡 4：对照组 claudecodeui —— 看他们怎么处理

去隔壁的 `claudecodeui-main` 开源项目翻代码。他们后端 `claude-sdk.js` 核心逻辑：

```js
if (sessionId) sdkOptions.resume = sessionId;  // 和我们一样

for await (const message of queryInstance) {
  if (message.session_id && !capturedSessionId) {
    capturedSessionId = message.session_id;  // 采纳
    ws.setSessionId(capturedSessionId);
    if (!sessionId && !sessionCreatedSent) {
      ws.send({ kind: 'session_created', newSessionId: ... });  // ← 只有新 chat 才发
    }
  }
}
```

他们也是 per-turn spawn + `--resume`，所以磁盘上也会 fork。**关键是读侧** `server/projects.js:696-749`：

```js
// 把每个 session 的第一条用户消息（parentUuid === null）当成"对话身份证"
allEntries.forEach(entry => {
  if (entry.type === 'user' && entry.parentUuid === null && entry.uuid) {
    const firstUserMsgId = entry.uuid;
    // 所有 fork 都继承这个根消息，uuid 相同
    sessionGroups.set(firstUserMsgId, { latestSession, allSessions: [...] });
  }
});

// 侧栏只显示每组的最新 fork
const latestFromGroups = Array.from(sessionGroups.values()).map(group => {
  if (group.allSessions.length > 1) {
    session.isGrouped = true;
    session.groupSize = group.allSessions.length;
  }
  return { ...group.latestSession };
});
```

聪明：**"第一条用户消息的 uuid" 是稳定的对话身份证**，所有 fork 都带着它，天然可分组。
这就是方案 C，比 A 优雅——不丢分支数据，磁盘侧不变只改读取展示。

---

## 关卡 5：实施分组聚合方案（方案 C）

**后端**（`handlers/sessions.ts`）：
- `groupSessions()` 按 `firstUserMsgId` 分组，每组只返回最新的
- `handleSessionMessages` 加载同组所有 fork 的消息
- `handleDeleteSession` 删整组 fork 文件（避免"浮出下一条"）

**前端**（`chatStore.ts`、`ChatPage.tsx`、`ChatSidebar.tsx`）：
- 新增 `displaySessionId` —— 稳定的"对话标签"，进入会话时钉住，后续不跟 fork 变
- Header 显示 `displaySessionId.slice(0, 8)` 而不是跳变的 `sessionId`
- 侧栏高亮兼顾 `sessionId === session.sessionId` 和 `groupSessions?.includes(sessionId)`
- 发送完刷新 sessions 列表
- 分组条目右下角 "`N branches`" 徽标

跑一轮：Header 不跳了、侧栏只有一条、徽标显示 `3 branches` —— UX 完整。但用户又问了个尖锐问题。

---

## 关卡 6：用户反问 —— "为什么其他地方不 fork？"

用户说：我在 VSCode 里、在终端 `claude` 里聊天，session id 都稳定，`N branches` 徽标从来没见过，你们 web UI 就会？

**两种模式的根本差异**：

```
【Interactive 模式】
  claude CLI 进程（一直活着）
    你: 消息1 → AI: 回复1 ──append─► session.jsonl
    你: 消息2 → AI: 回复2 ──append─► session.jsonl
  → 没用过 --resume，进程从没死

【Web UI / print 模式】
  turn 1: spawn CLI → 写 W.jsonl → exit
  turn 2: spawn CLI --resume W → 读 W → fork 写 X.jsonl → exit
  turn 3: spawn CLI --resume X → 读 X → fork 写 Y.jsonl → exit
  → 每轮新进程，靠 --resume 传递历史
```

**核心认知**：`--resume` 是"跨进程传递历史"的手段，interactive 模式根本不需要它。fork 不是 bug，是 CLI 为 print 模式设计的——允许从任何历史点派生。

做 Web UI 要避免 fork 有 3 档：
- **直连 Anthropic API**（ChatGPT 模式，自己管历史）
- **SDK streaming input**（一个 query() 长连）
- **手动管子进程**（复刻 interactive 模式）

方案 C 的分组聚合是第 4 种务实选择——不避免 fork，读侧聚合掉。

至此以为尘埃落定。但接下来用户扔来一份 AI 总结文档，说 claudecodeui 是怎么保持"同一 session 一致性"的——总结里**核心断言是 SDK 追加到同一 JSONL**。这跟磁盘证据明显矛盾，于是进入下一关。

---

## 关卡 7：AI 总结的核心断言可疑，打个问号

AI 总结的要点：
> SDK 内部会按 resume 去 ~/.claude/projects/... 里加载该 session 的历史**并续写**
> 第二条消息：… SDK **追加到同一 JSONL**

但我们刚刚才在用户项目里磁盘核实过——3 轮 = 3 个文件。两种可能：

| 可能性 | 判断 |
|--------|------|
| a. AI 总结作者没验磁盘，看 `options.resume = sessionId` 就脑补"续写" | 高 |
| b. `@anthropic-ai/claude-agent-sdk` 0.2.x 真改了 --resume 行为 | 中 |
| c. 某个 preset option 触发了不 fork 分支 | 低 |

我原本赌 70% 是 a（AI 读代码不看 side effect 的经典失误）。**建议用户去 claudecodeui 跑 3 轮实测，`ls` 核验磁盘**。

---

## 关卡 8：实证颠覆假设 —— 新 SDK 真的不 fork

用户用 WebSocket 客户端直接测 claudecodeui，3 轮对话：

```
Turn 1: sessionId = null          → system/init returns a22fdbc5
Turn 2: sessionId = a22fdbc5      → system/init returns a22fdbc5  ← 同一个
Turn 3: sessionId = a22fdbc5      → system/init returns a22fdbc5  ← 同一个
Turn 3 问 "我之前说了什么"        → AI 正确回忆起前两轮的颜色+食物
```

磁盘核实：

```bash
$ wc -l ~/.claude/projects/.../a22fdbc5*.jsonl
36 lines   ← 3 轮全装在 1 个文件里
```

**证据确凿：`@anthropic-ai/claude-agent-sdk@0.2.118` 真的改了 `--resume` 语义——原地 append，不 fork。**

我下意识的"CLI 二进制行为一致"的推理被推翻了。新 SDK 应该是内部换了协议（可能是新引入的 stream-json stdin 模式或者别的机制），让 `--resume` 在 print 模式也能原地续写。

**教训**：再自洽的推理，抵不过一条 `wc -l`。

---

## 关卡 9：SDK 升级

既然新 SDK 已经解决了根源问题，最好的方案就是升级。对比：

| | 老 `@anthropic-ai/claude-code@1.0.108` | 新 `@anthropic-ai/claude-agent-sdk@0.2.118` |
|---|---|---|
| ships cli.js | ✓ | ✗（用独立安装的 `claude` 原生二进制） |
| --resume fork | ✓ | ✗ |
| CLAUDE.md 默认加载 | ✓ | ✗（需要 `systemPrompt: preset 'claude_code'`） |
| settings.json 默认读取 | ✓ | ✗（需要 `settingSources: [...]`） |
| 默认工具集 | ✓ | ✗（需要 `tools: preset 'claude_code'`） |

改动清单：
- `package.json` / `deno.json` / `package-lock.json` 换包
- 3 个源文件的 import 路径换
- `handlers/chat.ts` 加 3 个 preset option 恢复老行为
- `history/parser.ts` / `timestampRestore.ts` 类型收窄（`SDKUserMessage.message` 是 `MessageParam` 没 `.id`，需 `"id" in message` 守卫）
- `handlers/chat.test.ts` 加 `await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled())` 修测试 race（老 SDK 时靠运气过，新 SDK 模块稍重就暴露了）

升级完跑测试 —— 全绿。然后启动后端实测，新坑冒出来。

---

## 关卡 10：中文用户名 mojibake —— "native binary not found"

启动后端，发消息报错：

```
⚠️  Claude CLI script path detection failed
   Falling back to using the claude executable directly.
   Using fallback path: C:\Users\����\.local\bin\claude.exe   ← 乱码！

error chat Claude Code execution failed:
  ReferenceError: Claude Code native binary not found at
  C:\Users\����\.local\bin\claude.exe
```

用户名 `陈哲` 被解码成 `����`。但 `claude --version` 在 bash 里能跑（返回 `2.1.118`），`ls` 也能看到真文件存在：

```bash
$ ls -la "C:/Users/陈哲/.local/bin/claude.exe"
-rwxr-xr-x ... 249035936 claude.exe   # 249MB 原生二进制，Anthropic 新版发行形式
```

**定位**：backend 的 `validateClaudeCli` 有段老代码——用 "node wrapper tracing" 技巧去找 `cli.js` 的真实路径。这是为**老 SDK**（bundled cli.js）设计的。新 SDK 没有 cli.js，tracing 失败，fallback 到 `.exe` 路径，但字符编码在某个环节从 UTF-8 被当成 CP936 / Latin-1 解读成了乱码。然后把这个坏路径传给 SDK，SDK 的 `fs.access` 当然找不到。

对照 claudecodeui 怎么做：

```js
sdkOptions.pathToClaudeCodeExecutable = process.env.CLAUDE_CLI_PATH || 'claude';
```

**就是不自己算路径，传命令名 `"claude"` 让 SDK 通过 PATH 解析。** Windows 的 `CreateProcess` 原生支持 Unicode，绕过 Node 侧那个把 `陈哲` 弄坏的字符串链。

**修复**：

```ts
// 之前
const queryOptions = {
  options: {
    executable: "node",
    executableArgs: [],
    pathToClaudeCodeExecutable: cliPath,  // 乱码风险
    // ...
  }
};

// 之后
void cliPath; // legacy from old SDK, 保留签名忽略内容
const resolvedCliPath = process.env.CLAUDE_CLI_PATH || "claude";

const queryOptions = {
  options: {
    pathToClaudeCodeExecutable: resolvedCliPath,  // 交给 SDK + PATH
    // executable/executableArgs 删掉，让 SDK 用它自己的默认
    // ...
  }
};
```

**教训**：跨层传路径字符串在 Windows 中文环境下不稳。**传名不传路径**，交给 OS 级 PATH 解析。

---

## 收官验证

4 轮对话的 console log：

```
[DEBUG] handleSend - sessionId: 9047f711-... workingDirectory: .../skillsLearn
[DEBUG] system/init received, session_id: 9047f711-...   ← turn 1
[DEBUG] handleSend - sessionId: 9047f711-...
[DEBUG] system/init received, session_id: 9047f711-...   ← turn 2 同一个
[DEBUG] handleSend - sessionId: 9047f711-...
[DEBUG] system/init received, session_id: 9047f711-...   ← turn 3 同一个
[DEBUG] handleSend - sessionId: 9047f711-...
[DEBUG] system/init received, session_id: 9047f711-...   ← turn 4 同一个
```

磁盘：

```bash
$ wc -l 9047f711-...jsonl
61 lines   ← 4 轮对话装在 1 个文件里
```

---

## 复盘：每一站的教训

### 1. API 层面的观察 ≠ 磁盘层面的真相
sessionId 看着换了一个和看着没换，**对磁盘上有几个 jsonl 是独立事实**。Debug 到一半一定要跳出当前抽象层，往下钻一层验证。

### 2. 假设要标注置信度，被证据推翻不丢人
我一度很确信"SDK --resume 一律 fork"——基于老 SDK 的观察和对 CLI 二进制行为一致性的推理。用户一个 3 轮实测就把它推翻了。**推理可以自洽，但不能对抗测量。**

### 3. AI 总结要看它有没有引用 side effect 证据
AI 读代码倾向于从 API signature 推语义，容易把 "`options.resume = sessionId`" 解读成 "追加到同一个文件"，实际那只是 CLI flag 的映射，磁盘上做什么另说。**凡是关键行为断言，自己去磁盘 / 网络 / 进程再验一道。**

### 4. 对照组的真正价值是"同一个问题的不同答案"
去看 claudecodeui 不是为了抄，是为了知道**还有哪些解法**。分组聚合是我们没想到的第 4 条路——比删除旧 fork 优雅，比重写 streaming input 便宜。有时候读一份陌生项目比盯着自己项目发呆有用。

### 5. "传路径" vs "传命令名" 在跨编码环境下差别巨大
Windows 中文路径 mojibake 是老问题了。能让 OS 做的事（PATH 解析、子进程 spawn）就不要自己在应用层拼字符串。**越靠近 OS 层，Unicode 越可靠。**

### 6. 升级依赖不是"换个包名"那么简单
新版 SDK 把"默认开"改成了"显式 opt-in"—— CLAUDE.md 加载、settings.json 读取、默认工具集都要你主动配置 preset 才能保持老行为。**升级时读一遍 CHANGELOG/breaking，别靠跑起来再报错去补。**

### 7. 遗留代码值得留着 backward-compat
我们实现的 `displaySessionId` / `isGrouped` / `groupSessions` 在新 SDK 下大部分时候"没事做"，但对磁盘上已经存在的老 fork 群仍然有用——让侧栏干净、历史可加载。**不是所有防御性代码都要在新方案上线时删掉，它们可能是老数据的向后兼容层。**

---

## 最终架构一图流

```
用户点侧栏 session X
    │
    ▼
前端 handleSelectSession(X)
    - setSessionId(X)
    - setDisplaySessionId(X)   ← 稳定标签钉住
    - GET /api/sessions/X/messages
    │
    ▼
后端 handleSessionMessages
    - 找 X.jsonl 的 firstUserMsgId
    - 找所有 firstUserMsgId 相同的 fork 文件（处理老数据）
    - 合并排序返回
    │
    ▼
用户发消息
    - 前端发 sessionId=X（最新的 sessionId）
    │
    ▼
后端 handleChatRequest
    - pathToClaudeCodeExecutable: "claude" （PATH 解析，避免 mojibake）
    - options.resume = X
    - tools/systemPrompt/settingSources preset
    │
    ▼
claude-agent-sdk spawns claude.exe
    - 新 SDK 的 --resume: 原地追加到 X.jsonl（不 fork）
    - system/init 回 session_id = X（不变）
    │
    ▼
前端 replaceTemporarySession(X, requestId)
    - currentRequestId 守卫通过
    - sessionId 更新为 X（==原值，无副作用）
    - displaySessionId 保持
    │
    ▼
Header 显示 X 的前 8 位，永远不变
侧栏列表刷新，仍然只显示这条 session
磁盘上只多了一些行到 X.jsonl
```

就这样，从 "点击继续聊天有 bug" 走到彻底解决。真实世界的 debug 从来不是"找到一个 bug 修一个 bug"，是剥洋葱——每修一层露出下一层，每一层都在教你之前哪里的心智模型错了。
