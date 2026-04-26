# 把原生 Claude Code 选择器搬进 Web Chat — 一步步实现指南

> 你已经有了一个 Web Chat（聊天气泡 + 流式输出 + 工具调用展示），用户想要 IDE 里那种"Claude 问问题，用户从选项里挑一个"的原生体验，但现在每次 `AskUserQuestion` 工具被调用时只能看到一坨 JSON。这篇文章从"为什么 SDK 默认不给你这个 UI"讲起，一路拆到键盘绑定的边角。
>
> **目标读者**：已经把 Claude Agent SDK 跑起来、能流式拿到 `assistant`/`tool_use`/`tool_result` 消息，但没碰过 `canUseTool` 回调的开发者。

---

## 0. 为什么需要这个

**原生 CLI** 跑 `claude code` 时，遇到 `AskUserQuestion` 工具会进 TUI 模式：终端清屏，画一个紧凑的列表，箭头键选，Enter 提交。这是 CLI 自己实现的，跟 SDK 协议无关。

**SDK** 跑 headless（你的后端调 `query()`）时，CLI 不在前台，没人来画这个 UI。SDK 的处理方式是：把 `AskUserQuestion` 当成普通工具，调用一次 `canUseTool(toolName, input, opts)` 让宿主决定怎么办。如果宿主什么都不做，工具会卡住或失败。

所以"把原生选择器搬进 Web Chat"的本质是：

1. **后端**：在 `canUseTool` 里把工具调用挂起（`new Promise(resolve => …)`），同时告诉前端"现在有个待批准的工具"
2. **前端**：渲染一个跟原生 TUI 视觉/键盘等价的组件，用户点完后通过 HTTP 把结果送回后端
3. **后端**：拿到结果，`resolve()` 那个 Promise，SDK 继续往下跑

这条链路本质就是把"等用户输入"这个动作跨进程跨语言地做了一次 RPC。

---

## 1. 先理解你要拦截的位置

### 1.1 SDK 三种调用工具的姿态

| 模式             | `permissionMode`     | `canUseTool` 是否被调用                       |
| ---------------- | -------------------- | --------------------------------------------- |
| 全自动           | `bypassPermissions`  | 否（直接执行）                                |
| 写操作自动       | `acceptEdits`        | 部分（Edit/Write 跳过；Bash/网络仍然问）       |
| 默认             | `default`            | **是**（每个工具都问）                        |
| 计划             | `plan`               | **是**（只读探索 + ExitPlanMode 时问一次）    |
| 模型分类         | `auto`               | 否（SDK 内置分类器自己决定）                  |

如果你想最大化拦截，把模式设成 `default`，然后 `canUseTool` 就会在每个工具调用前被同步等待。

### 1.2 `CanUseTool` 的签名

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  opts: {
    signal: AbortSignal;          // 用户中止时这个会 abort
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;               // SDK 预渲染的提示文案
    displayName?: string;
    description?: string;
    toolUseID: string;            // 跟 assistant 消息里的 tool_use_id 对应
    agentID?: string;
  }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny';  message: string; interrupt?: boolean };
```

注意：

- 它返回 `Promise` —— 你可以异步等任意久。
- `signal.aborted` 会在用户取消请求时变 true，你必须 resolve 这个 Promise，否则 SDK 永远不结束。
- `allow` 的 **runtime Zod schema 要求 `updatedInput` 必须是 record**（即使 TS 类型说可选）。我踩过这个坑——见 [SPEC.md §14.9 Bug #2](./SPEC.md#bug-2-zoderror-on-allow-once)。

---

## 2. 后端 Step 1：让 `canUseTool` 能"喊话"前端

### 2.1 第一次尝试（错的）：直接 yield 给现有的流

你现有的 `executeClaudeCommand` 大概长这样：

```ts
async function* executeClaudeCommand(...) {
  for await (const m of query({...})) {
    yield { type: 'claude_json', data: m };
  }
  yield { type: 'done' };
}
```

天真做法：在 `canUseTool` 回调里直接 `yield` 一个新的 chunk type。**不行**——`canUseTool` 是 SDK 调你的回调，它跑在 SDK 的内部 await 链里，跟你这个外部 generator 不是同一个上下文，没办法 `yield`。

### 2.2 正确做法：手写一个异步队列

把 generator 从"直接 yield"改成"从队列里拉"。SDK 循环和 `canUseTool` 都往队列里 `push()`：

```ts
async function* executeClaudeCommand(message, requestId, ...) {
  // --- 队列基础设施 ---
  const queue: StreamResponse[] = [];
  let waker: (() => void) | null = null;
  let producerDone = false;
  let producerError: unknown = null;

  const wake = () => { const w = waker; waker = null; w?.(); };
  const push = (chunk: StreamResponse) => { queue.push(chunk); wake(); };

  // --- canUseTool：挂起 SDK，告诉前端 ---
  const canUseTool: CanUseTool = (toolName, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      const id = randomUUID();
      pendingPermissions.set(id, { resolve, requestId, originalInput: input });
      push({
        type: 'permission_request',
        permission: { id, toolName, input, toolUseId: opts.toolUseID, ... },
      });
      // 用户中止时也要释放
      opts.signal.addEventListener('abort', () => {
        if (pendingPermissions.delete(id)) {
          resolve({ behavior: 'deny', message: 'aborted' });
        }
      }, { once: true });
    });

  // --- 后台跑 SDK 循环 ---
  const sdkLoop = (async () => {
    try {
      for await (const m of query({ ...options, canUseTool })) {
        push({ type: 'claude_json', data: m });
      }
    } catch (err) {
      producerError = err;
    } finally {
      producerDone = true;
      // 走到这儿 SDK 已经完结了，任何还挂着的批准请求都得被释放
      abortPendingPermissionsForRequest(requestId);
      wake();
    }
  })();

  // --- 主排出循环 ---
  while (!producerDone || queue.length > 0) {
    if (queue.length > 0) { yield queue.shift()!; continue; }
    await new Promise<void>((r) => { waker = r; });
  }
  await sdkLoop;
  if (producerError) throw producerError;
  yield { type: 'done' };
}
```

**为什么这样能保证顺序**：所有事件都过同一个 FIFO 队列，前端永远先收到 `permission_request` 才会收到该工具被批准后的 `claude_json`，因为它们 push 顺序就是这样。

**为什么要 `abortPendingPermissionsForRequest` 三次（finally + catch + outer try-finally）**：稳。Promise 没释放 = SDK 永远 await = 整个流卡住。我宁愿调三次也不愿漏一次。

### 2.3 模块级 `pendingPermissions`

跨请求共享一张表，让另一个 HTTP 端点也能找到挂起的 Promise：

```ts
const pendingPermissions = new Map<string, {
  resolve: (r: PermissionResult) => void;
  requestId: string;
  originalInput: Record<string, unknown>;  // 给 allow 的 updatedInput 兜底
}>();

export function resolvePendingPermission(id: string, decision: WireDecision): boolean {
  const entry = pendingPermissions.get(id);
  if (!entry) return false;
  pendingPermissions.delete(id);

  if (decision.behavior === 'allow') {
    entry.resolve({
      behavior: 'allow',
      updatedInput: decision.updatedInput ?? entry.originalInput, // ← Zod 要求
      ...(decision.acceptedSuggestions ? { updatedPermissions: ... } : {}),
    });
  } else {
    entry.resolve({ behavior: 'deny', message: decision.message || 'Denied by user.' });
  }
  return true;
}
```

`originalInput` 这个字段值得专门讲：SDK 的 `PermissionResult.allow` 在 TS 里写 `updatedInput?: Record<…>`（可选），但 runtime Zod 拒绝 `undefined`。你必须传一个 record。最自然的默认值就是工具的原始 input —— 等于"放行，啥都不改"。

---

## 3. 后端 Step 2：加一个回填端点

```ts
// handlers/permission.ts
export async function handlePermissionResponse(c: Context) {
  const body = await c.req.json();
  if (!body?.id || !body.decision) return c.json({ error: 'bad request' }, 400);
  const ok = resolvePendingPermission(body.id, body.decision);
  return c.json({ ok });
}

// app.ts
app.post('/api/chat/permission', (c) => handlePermissionResponse(c));
```

就这么简单。前端 POST `{id, decision}` 过来，后端找到对应的 Promise resolve 掉，SDK 那边的 `await canUseTool(...)` 就拿到结果继续往下跑了。

**为什么不用 WebSocket**：你已经有一个 NDJSON 流在跑，再开一个 WS 是浪费。HTTP POST 用来接收单次决定足够了 —— 决定不像音频那样需要双向高频。

---

## 4. 前端 Step 1：解析新的 stream chunk

之前 `useStreamParser` 大概只认识 `claude_json | done | error`：

```ts
if (chunk.type === 'claude_json' && chunk.data) { ... }
else if (chunk.type === 'done') { ... }
else if (chunk.type === 'error') { ... }
```

加一个分支：

```ts
else if (chunk.type === 'permission_request' && chunk.permission) {
  const p = chunk.permission;
  addMessage({
    type: 'permission_request',
    permissionId: p.id,                 // 服务器 id（用于 RPC）
    toolName: p.toolName,
    input: p.input,
    toolUseId: p.toolUseId,
    title: p.title, displayName: p.displayName,
    description: p.description, decisionReason: p.decisionReason,
    suggestions: p.suggestions,
    decided: { status: 'pending' },     // 重要：bubble 自己的状态机
  });
  setIsThinking(false);                  // SDK 在等用户，关掉转圈圈
  continue;
}
```

`decided` 字段是这个气泡的状态机，初始 `pending`，用户答完后会变成 `allowed` / `answered` / `denied` / `aborted`。store 里加一个 `setPermissionDecision(id, status)` action 用来翻面。

### 4.1 流结束时的兜底

如果用户中途按了 abort 按钮，或者 SDK 因为别的原因结束了流，那些还挂着的 permission bubble 会永远显示"等用户答复"——但根本没人会答复。所以流结束时把它们全部扫一遍：

```ts
const closeOutstandingPermissions = () => {
  const live = useChatStore.getState().messages;
  for (const m of live) {
    if (m.type === 'permission_request' && m.decided.status === 'pending') {
      setPermissionDecision(m.permissionId, { status: 'aborted' });
    }
  }
};

// 在 'done' / 'error' / catch 里都调一次
```

**为什么用 `useChatStore.getState()` 而不是闭包里的 `messages`**：闭包是在 hook 渲染时捕获的，可能已经过期。直接读 store 拿到最新一帧。

---

## 5. 前端 Step 2：通用 Allow / Deny 气泡（不是问答场景的兜底）

不是每个工具都是问答型的。Bash、Read、Write 这些就是普通的"放不放它跑"。所以先做一个通用气泡：

```tsx
function PermissionRequestComponent({ message }) {
  const [submitting, setSubmitting] = useState(false);
  const [denying, setDenying] = useState(false);
  const [denyReason, setDenyReason] = useState('');

  const send = async (nextDecided, body) => {
    setSubmitting(true);
    const ok = await claudeApi.respondPermission(message.permissionId, body);
    setSubmitting(false);
    if (ok) setPermissionDecision(message.permissionId, nextDecided);
    else /* show error, leave bubble in pending */;
  };

  return (
    <div className="rounded border bg-card-bg border-l-2 border-l-amber-500 ...">
      <header>🔐 Claude wants to run {message.toolName}</header>
      {!denying ? (
        <>
          <button onClick={() => send({status:'allowed', always:false}, {behavior:'allow'})}>Allow once</button>
          <button onClick={() => setDenying(true)}>Deny</button>
        </>
      ) : (
        <>
          <textarea value={denyReason} onChange={e => setDenyReason(e.target.value)} />
          <button onClick={() => send(
            {status:'denied', message: denyReason},
            {behavior:'deny', message: denyReason || 'Denied by user.'}
          )}>Send rejection</button>
        </>
      )}
    </div>
  );
}
```

**注意点**：

- **乐观更新是错的**：如果 POST 失败但你已经把气泡变成"Allowed"，用户看到的是假象 —— SDK 那边其实还在等。先 await，成功才翻面。
- **Deny 的 message 字段用户可定制**：原生 IDE 就支持"Don't run rm here, use git instead." 这种指导，等于让用户在拒绝的同时给 Claude 一个 hint。
- **`Allow always`** 当且仅当 SDK 在 `opts.suggestions` 里给了规则时才显示。多数工具不会给。

---

## 6. 前端 Step 3：AskUserQuestion 专用选择器（核心戏肉）

### 6.1 输入形状

`AskUserQuestion` 的 `input` 长这样：

```json
{
  "questions": [
    {
      "question": "你平时使用哪些开发工具？",
      "header": "开发工具",
      "options": [
        { "label": "VS Code", "description": "微软出品的轻量编辑器" },
        { "label": "JetBrains IDE", "description": "WebStorm / IntelliJ" },
        ...
      ],
      "multiSelect": true
    },
    ...
  ]
}
```

在通用气泡里检测 `toolName === 'AskUserQuestion'`，如果是就走选择器；不是就走 Allow/Deny。

### 6.2 第一次尝试（错的）：每个选项一张大卡片

我先做了个用 `<input type="radio">` / `<input type="checkbox">` + 大圆角 label 的版本。语义化 HTML 自带键盘支持，听起来很美好。

**用户反馈**：

> 这样也太抽象了，我需要的是实际能够选择，支持键盘输入几乎原生 Claude 选项的体验

意思是：

- 大卡片占一屏（VS Code 是单行密排）
- description 把节奏拖垮
- native radio/checkbox 视觉很挫，跟终端风格不搭
- 没有数字快捷键
- 无法自定义答复

### 6.3 第二次尝试（成的）：紧凑行 + 数字快捷键 + 自定义文本

```tsx
function AskUserQuestionPicker({ questions, disabled, onSubmit }) {
  const [selections, setSelections] = useState(() => questions.map(() => new Set<number>()));
  const [activeQ, setActiveQ] = useState(0);          // 当前激活的题
  const [cursors, setCursors] = useState(() => questions.map(() => 0));  // 每题各自的光标位
  const [custom, setCustom] = useState('');           // 兜底自定义答复
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 挂载时立即 focus，键盘可用
  useEffect(() => { rootRef.current?.focus(); }, []);

  const pick = (qi, oi) => {
    setSelections(prev => {
      const next = prev.map(s => new Set(s));
      const cur = next[qi];
      if (questions[qi].multiSelect) {
        if (cur.has(oi)) cur.delete(oi); else cur.add(oi);
      } else {
        cur.clear(); cur.add(oi);
      }
      return next;
    });
    setCursors(prev => { const n = prev.slice(); n[qi] = oi; return n; });
  };

  const submit = () => {
    if (custom.trim()) {
      onSubmit(custom.trim(), custom.trim());            // 自定义文本完全覆盖
      return;
    }
    if (selections.some(s => s.size === 0)) return;       // 还没全答
    const formatted = questions.map((q, i) => {
      const picked = q.options.filter((_, idx) => selections[i].has(idx)).map(o => o.label);
      return `${q.header || q.question}: ${picked.join(', ')}`;
    }).join('\n');
    onSubmit(formatted, formatted.replace(/\n/g, '; '));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.target === textareaRef.current) {
      if (e.key === 'Escape') { textareaRef.current?.blur(); rootRef.current?.focus(); }
      return;  // 在 textarea 里其他键都给浏览器
    }
    if (e.target !== rootRef.current) return;  // Tab 到了 button 就放行

    const q = questions[activeQ]; const cursor = cursors[activeQ];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cursor < q.options.length - 1) setCursor(activeQ, cursor + 1);
      else if (activeQ < questions.length - 1) {       // 跨题 wrap
        setActiveQ(activeQ + 1); setCursor(activeQ + 1, 0);
      }
    }
    else if (e.key === 'ArrowUp') { /* 镜像 */ }
    else if (e.key === ' ') { e.preventDefault(); pick(activeQ, cursor); }
    else if (e.key === 'Enter') {
      e.preventDefault(); pick(activeQ, cursor);
      if (!q.multiSelect && activeQ < questions.length - 1) setActiveQ(activeQ + 1);
    }
    else if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key) - 1;
      if (idx < q.options.length) { e.preventDefault(); pick(activeQ, idx); }
    }
    // Tab 故意不拦截 → 浏览器原生流向 textarea → Submit
  };

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} className="...">
      {questions.map((q, qi) => (
        <div key={qi} onMouseDown={() => setActiveQ(qi)} className={qi === activeQ ? 'border-l-blue-500' : ''}>
          <header>{q.header} — {q.question} <span>{q.multiSelect ? 'multi' : 'pick one'}</span></header>
          <ul>
            {q.options.map((opt, oi) => {
              const isSelected = selections[qi].has(oi);
              const isCursor = qi === activeQ && cursors[qi] === oi;
              return (
                <li key={oi} onMouseDown={(e) => { e.preventDefault(); setActiveQ(qi); pick(qi, oi); rootRef.current?.focus(); }}
                    className={isCursor ? 'bg-card-hover' : 'hover:bg-card-hover/60'}>
                  <span className={isSelected ? 'bg-emerald-600 text-white' : 'border'}>
                    {isSelected ? '✓' : oi + 1}
                  </span>
                  <span>{opt.label}</span>
                  {opt.description && <span className="text-xs text-muted">— {opt.description}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <textarea ref={textareaRef} value={custom} onChange={e => setCustom(e.target.value)}
                placeholder="Or type a custom reply..." />
      <button onClick={submit} disabled={!ready}>{custom.trim() ? 'Send reply' : 'Submit'}</button>
    </div>
  );
}
```

### 6.4 关键 UX 决策（会被反复踩坑的）

| 决策                            | 为什么                                                                  |
| ------------------------------- | ----------------------------------------------------------------------- |
| `tabIndex={0}` + `useEffect` focus | 用户直接按 ↑↓ 就生效，不用先点一下                                      |
| `onMouseDown` 而不是 `onClick`     | 鼠标点选项后，`mousedown.preventDefault()` 阻止焦点偷走，键盘流不被打断  |
| ↑↓ 跨题 wrap，不再 wrap 回顶部     | 用户走到末尾按 ↓ 没反应 = 自然提示"到底了"；wrap 回顶反而困惑           |
| Tab 不拦截，让浏览器接管           | Submit 按钮原生 focusable，Tab 到它按 Enter 就提交                     |
| 数字键 1-9 在当前激活题里生效      | 用户视线落在哪题，数字就作用在哪题                                      |
| 自定义文本覆盖所有选择             | 给"我想说点别的"留逃生口，按钮文案变 `Send reply` 提示用户               |
| `Cmd/Ctrl+Enter` 全局提交          | 在 textarea 里也能用，跟系统级 IDE 习惯一致                            |
| 不在最末题 Enter 自动提交          | `selections` 是闭包捕获的旧值，提交时会用错的状态。用 Cmd+Enter 或按钮统一 |

### 6.5 答复的回程

SDK 没有"用户回答了"这种返回类型。最自然的渠道是 `behavior: 'deny'` + `message: <格式化答案>`。Claude 会把 deny message 当作 tool 输入回到对话里：

```ts
const onAskSubmit = (formatted, summary) => {
  send(
    { status: 'answered', summary },                        // bubble 状态
    { behavior: 'deny', message: formatted },               // 回 SDK
  );
};
```

**副作用**：SDK 会合成一条 `is_error: true` 的 tool_result 塞回流里，前端默认会渲染成红色 ⚠️ Tool error 气泡 —— 难看且重复（permission bubble 已经显示 `✓ Answered — ...` 了）。

**修法**：在 `useStreamParser` 解析 tool_result 时丢掉 `toolName === 'AskUserQuestion'` 的：

```ts
if (toolName === 'AskUserQuestion') continue;
```

这是个产品决定，不是技术 bug。如果将来 SDK 出了真正的"用户回答"返回类型，把这个 continue 删了就行。

---

## 7. 视觉别走偏：跟项目一致

第一版我把整个气泡填了琥珀色 —— 用户原话："琥珀色在浅色模式下看不清"，"配色丑"。教训：

1. **大色块不是"重要"的同义词**。重要靠位置和层级，不靠涂色。
2. **跟现有气泡一致最重要**。chat 里别的气泡都用 `bg-card-bg + border-card-border`，permission bubble 也用，只在左边加一道 2px 色条作为"意图提示"（amber = 警告 / blue = 询问）。
3. **暗模式用 `darkMode: 'class'` 时，`dark:` 前缀就够了**，不需要为每个色重写 CSS variable。但所有"主体色"用主题 token（`text-primary`/`text-muted`），只让"意图色"（amber/blue）双套写法。
4. **按钮要实色**：`bg-blue-600 hover:bg-blue-500` 在白底和黑底都立得住；`bg-blue-600/80` 在白底就糊。

---

## 8. 端到端验收剧本

走完这五个场景就基本可以发版了：

### Scenario A：单选问答（最简单）

1. 把 mode 切到 `Ask before edit`
2. 让 Claude 调一次 AskUserQuestion，1 题 4 选项 single-select
3. 进 picker，光标默认在选项 1
4. 按 `2` → 选项 2 高亮 ✓
5. 按 `Tab` → 焦点跳到 textarea；再 `Tab` → 跳到 Submit；按 `Enter` → 提交
6. Bubble 折叠成 `✓ Answered — 开发工具: JetBrains IDE`
7. Claude 收到答复继续往下

### Scenario B：多选 + 自定义

1. 2 题，第一题 multi-select，第二题 single-select
2. 用 `↑↓` 在第一题里走，按 `Space` 选 1、3
3. `↓` 到底再 `↓` —— 跨题 wrap 到第二题第一项
4. 在第二题填自定义 textarea："我想说点别的"
5. 按 `Cmd+Enter` 提交
6. 答复的是 textarea 里的文本（覆盖了选项）

### Scenario C：用户中止

1. Claude 发起 AskUserQuestion，picker 显示，光标闪
2. 用户没答，直接点 ChatInput 的 ⏹ 中止
3. Backend abort signal 触发 → `canUseTool` 的 Promise resolve 成 deny → SDK 退出
4. 流结束，前端 `closeOutstandingPermissions` 把 picker bubble 翻成 `aborted`
5. 用户能看到 "Request was no longer pending; click had no effect."

### Scenario D：普通工具（验通用 Allow/Deny 还在）

1. Claude 想跑 Bash `rm -rf foo`
2. 看到琥珀色气泡 `🔐 Claude wants to run Bash`
3. 点 `Show full input` 看完整 args
4. 点 `Deny` → 出 textarea → 输入"换个方式吧" → `Send rejection`
5. Claude 收到 deny + 这段 message，调整策略

### Scenario E：刷新页面（不测就要踩）

1. 进行到 picker 阶段时刷新浏览器
2. 后端 `pendingPermissions` 还挂着那个 Promise（前端没了，但 SDK 还在等）
3. 大概率用户重新发一条新消息时会走到 `acquireLock` 锁上了 —— 可以选择：
   - (a) 用户再发消息时拒绝并提示"上一轮还在 SDK 那边等批准"
   - (b) 加一个全局 reset 端点
   - (c) 后端给 `pendingPermissions` 加超时（推荐，比如 5 分钟没人来就自动 deny）

你的项目目前没处理 (c)，是已知缺陷。生产环境上之前补一下。

---

## 9. 调试技巧

| 现象                                            | 可能原因                                                                | 怎么验                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| 气泡出来了但点 Allow 没反应                     | `respondPermission` 返回 false（id 已被解析过）                         | DevTools Network 看 POST /api/chat/permission 响应 |
| 点了 Allow 后 Claude 报 ZodError                | `updatedInput` 没填                                                     | 后端日志 grep ZodError；改 default 到 originalInput|
| Picker 不响应键盘                               | `tabIndex` 没设或没 focus                                               | DevTools 看 `document.activeElement`              |
| 选项点击会让 picker 失焦                        | 用了 `onClick` 而不是 `onMouseDown` + `preventDefault`                  | 改成 mousedown                                    |
| 工具一发就回 deny，从来不让用户答              | `permissionMode` 是 `bypassPermissions` 或 `auto`，canUseTool 不会调用 | 切到 `default` 验                                 |
| SDK 永远不结束                                  | 有 Promise 没释放                                                        | 数 `pendingPermissions.size`，应该跟随 abort 归零 |

---

## 10. 进阶想法（没做但能做）

- **Edit input 模式**：通用气泡的 Allow 可以加个"先改再 allow"，把 input 编辑后用 `decision.updatedInput` 送回。SDK 会用新 input 跑工具。
- **Plan mode 的 ExitPlanMode 专属 UI**：plan 模式跑完会发一次 `ExitPlanMode` 工具调用，input 里有完整计划。可以做一个像 plan-card 的特殊 bubble，整段 markdown 渲染计划 + Approve/Reject。
- **Suggestions 持久化**：`Allow always` 当前只在 session 里生效。可以把 `acceptedSuggestions` 写到 `~/.claude/settings.json` 的 `permissions.allow` 数组里，跨 session 持久化。
- **批量 Approve**：当 Claude 短时间内连发 N 个工具调用时（比如 plan 模式下），UI 可以聚合成一张表 "Approve N tools"，一次性允许或筛选。

---

## 11. 收口检查表

实现完之后过一遍：

- [ ] 后端 `pendingPermissions` 在 `finally`、`catch`、abort listener 三处都有清理
- [ ] 前端 `useStreamParser` 流结束时调 `closeOutstandingPermissions`
- [ ] `respondPermission` 失败时 bubble 不假装 commit
- [ ] AskUserQuestion 的 tool_result 在 parser 里被 continue 掉
- [ ] `auto` 模式存进 localStorage 时 schema 兼容（旧用户切到新版不会爆 PermissionMode 类型）
- [ ] 暗/浅模式都过一遍肉眼，按钮、文字、focus ring 全部可见
- [ ] 键盘走完一整个 Scenario A 不用碰鼠标
- [ ] 5 个 permission mode pill 切换都能看到对应行为变化（auto 不弹 / bypass 不弹 / default 每个都弹）

写完这套，你就拥有了一个跟原生 CLI / VS Code 内置 Claude 几乎等价的问答体验，而且因为是浏览器 React，扩展性比终端 TUI 好得多。

---

*Last updated: 2026-04-26*
