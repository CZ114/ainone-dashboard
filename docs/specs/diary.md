---
type: spec
status: draft
last_updated: 2026-04-28
tags: [diary, ai-agent, claude-cli, autonomous-loop, scheduler]
---

# Diary Feature Spec (B4)

**Status**: draft, awaiting confirmation
**Owner**: CZ114
**Goal**: Make the dashboard *think on its own* — Claude (or any compatible model) periodically generates short observations from recent recordings, posted to a timeline. User reads, optionally replies (which reverts to a normal chat session).

---

## 1. Non-goals

- Not a generic notification system. Diary entries are AI-generated summaries, not push messages from arbitrary sources.
- Not multi-user. Single-user local prototype; no auth, no per-user state.
- Not a replacement for the report-pipeline (`ad-mind-pipeline`). Diary is "casual observations"; the formal report pipeline stays separate.
- Not real-time. Cron-style scheduling + manual trigger only. Phase 3 may add event-driven, but still loosely-coupled.
- Not a model abstraction layer. We delegate model switching to Claude CLI's existing env-based mechanism. No custom adapters.

---

## 2. Architecture (one diagram)

```
┌──────────────────────────────────────────────────────────────┐
│                    Hono backend (:3000)                       │
│                                                               │
│  ┌─ Existing (REUSED) ────────────────────────────────────┐  │
│  │  • SDK query() handler (handlers/chat.ts)              │  │
│  │  • SSE streaming pattern                               │  │
│  │  • Session/conversation handlers                       │  │
│  │  • settings.json env loader (getUserEnvFromSettings)   │  │
│  │  • Claude binary resolver (resolveClaudeBinary)        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ New (THIS SPEC) ──────────────────────────────────────┐  │
│  │                                                        │  │
│  │  scheduler  ──tick──►  runner  ──spawn──►  claude -p   │  │
│  │     ▲                    │                    │        │  │
│  │     │                    │ (per-agent env,    │        │  │
│  │  setInterval(60s)        │  --model,          │        │  │
│  │     │                    │  --append-system-  │        │  │
│  │     │                    │   prompt)          │        │  │
│  │     │                    ▼                    │        │  │
│  │     │              build context     stream-json out   │  │
│  │     │              GET /api/recordings        │        │  │
│  │     │              (FastAPI :8080)            ▼        │  │
│  │     │                              parse → DiaryEntry  │  │
│  │     │                                        │        │  │
│  │     │                         atomic write   │        │  │
│  │     │                  data/diary_entries    │        │  │
│  │     │                              .json     │        │  │
│  │     │                                        ▼        │  │
│  │     │                            EventBus.emit('new')  │  │
│  │     │                                        │        │  │
│  │     │                                        ▼        │  │
│  │     │                            SSE /api/diary/stream │  │
│  │     │                                                 │  │
│  └─────┼─────────────────────────────────────────────────┘  │
│        │                                                     │
└────────┼─────────────────────────────────────────────────────┘
         │ HTTP                                  ▲ SSE
         ▼                                       │
┌──────────────────────┐               ┌─────────┴───────────┐
│ FastAPI (:8080)       │               │ React (:5173)        │
│  /api/recordings      │               │  /diary timeline     │
│  /api/channels        │               │  Toast + Notif       │
│  (existing, untouched)│               │  Reply → /chat       │
└──────────────────────┘               └─────────────────────┘
```

**Two key design decisions:**

1. **Diary uses raw `claude -p` spawn, NOT the SDK's `query()`.** Reason: chat is interactive (sessions, permissions, abort, tool use), so SDK's machinery earns its keep there. Diary is one-shot batch generation with no tools — raw spawn is shorter, simpler, and avoids dragging in chat's session state.
2. **Model switching is delegated to Claude CLI itself.** Each agent provides its own `env` block (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`); the runner just merges and spawns. Non-Anthropic-protocol providers (DeepSeek/OpenAI/etc.) require the user to install a router (`claude-code-router` or LiteLLM) — but that's their config, not our code.

---

## 3. Reuse map

What we **DO NOT** write because it already exists:

| Existing piece | Where | How diary uses it |
|---|---|---|
| Recordings list API | `backend/app/api/recordings.py` | `runner` fetches recent entries to build context |
| Atomic JSON state pattern | `backend/app/extensions/state.py` (Python) | Port the `os.replace` idiom to TS in ~30 lines |
| SSE streaming pattern | `backend/claude/handlers/chat.ts` | Copy the `text/event-stream` headers + write loop |
| Claude binary resolver | `backend/claude/handlers/chat.ts:resolveClaudeBinary()` | Same function — diary spawn uses the same binary |
| `getUserEnvFromSettings` | `backend/claude/handlers/chat.ts` | Default fallback when an agent has no `env` of its own |
| Markdown renderer | frontend chat (`react-markdown`) | Render diary entry body; identical pipeline |
| Toast component | `frontend/src/components/Toast.tsx` | Pop "New diary entry" |
| Zustand store pattern | `frontend/src/store/chatStore.ts` | Mirror for `diaryStore.ts` |
| API client pattern | `frontend/src/api/claudeApi.ts` | Mirror for `diaryApi.ts` |
| Chat session / Reply path | `handlers/sessions.ts` + `handlers/chat.ts` | Reply button creates a regular chat session with the entry as seed |

**No new dependencies.** No `node-cron`, no `gray-matter`, no DB. Schedule check uses `setInterval(60_000)`; agent config is a single JSON file.

---

## 4. New components (the entire delta)

| File | Role | LOC estimate |
|---|---|---|
| `backend/claude/diary/store.ts` | Atomic read/write for `diary_entries.json` and `diary_config.json` | ~80 |
| `backend/claude/diary/agentStore.ts` | Read/write `agents.json` (CRUD + `${KEY}` resolution) | ~60 |
| `backend/claude/diary/contextBuilder.ts` | Fetch FastAPI, pack into prompt | ~50 |
| `backend/claude/diary/runner.ts` | Spawn `claude -p`, parse stream-json, persist | ~150 |
| `backend/claude/diary/scheduler.ts` | `setInterval` tick check; manual trigger entry | ~70 |
| `backend/claude/handlers/diary.ts` | REST + SSE endpoints | ~200 |
| `backend/claude/diary/prompts/daily_observation.md` | Prompt template | static |
| `backend/shared/types.ts` | + `DiaryEntry`, `DiaryConfig`, `AgentConfig` types | +50 |
| `frontend/src/api/diaryApi.ts` | HTTP client | ~80 |
| `frontend/src/store/diaryStore.ts` | Zustand store | ~100 |
| `frontend/src/components/diary/DiaryPage.tsx` | Timeline page | ~150 |
| `frontend/src/components/diary/EntryCard.tsx` | Single entry card | ~80 |
| `frontend/src/components/diary/AgentEditor.tsx` | Agent config form | ~200 |
| `frontend/src/components/diary/DiarySettingsPanel.tsx` | Schedule + agent picker | ~120 |
| `frontend/src/App.tsx` | + `/diary` route | +5 |
| `frontend/src/components/layout/*.tsx` | + sidebar entry | +5 |
| `backend/claude/app.ts` | + diary route registration + scheduler init | +10 |

**Total**: ~1,500 lines of new code, zero new runtime dependencies.

---

## 5. Data model

All persisted as JSON under `data/` (gitignored, project-root-relative).

### 5.1 `data/diary_entries.json`

```typescript
interface DiaryEntry {
  id: string;                          // ulid (or just timestamp+random for MVP)
  type: 'observation' | 'question' | 'reminder';
  title: string;                       // <60 chars, derived from first body line
  body: string;                        // markdown, may include footnote refs
  created_at: string;                  // ISO 8601
  trigger: 'cron' | 'manual' | 'event';

  agent_id: string;                    // which agent generated it
  model: string;                       // e.g. "deepseek-chat" or "claude-haiku-4-5"

  context_refs: {
    recordings: string[];              // recording timestamps consulted
  };

  read: boolean;
  reply_session_id?: string;           // set when user clicks Reply

  // Telemetry (best-effort, omitted if model didn't return)
  duration_ms?: number;
  cost_usd?: number;
}
```

File shape:
```json
{
  "version": 1,
  "entries": [ /* DiaryEntry[], newest first */ ]
}
```

### 5.2 `data/diary_config.json`

```typescript
interface DiaryConfig {
  enabled: boolean;                    // master switch
  schedule: {
    daily: { time: string; agent_id: string };  // time = "HH:MM" 24h local
    weekly?: { weekday: number; time: string; agent_id: string };
  };
  triggers: {
    on_recording_complete: { enabled: boolean; agent_id?: string };
  };
  notification: {
    browser: boolean;
    quiet_hours?: [string, string];    // ["22:00", "08:00"]
  };
  daily_quota: number;                 // hard cap on auto-generated entries per day
}
```

### 5.3 `data/agents.json`

Single file holds both agent definitions and secrets. Gitignored.

```typescript
interface AgentsFile {
  version: 1;
  secrets: Record<string, string>;     // e.g. {"DEEPSEEK_KEY": "sk-..."}
  agents: Record<string, AgentConfig>;
}

interface AgentConfig {
  name: string;                        // display
  description?: string;
  model: string;                       // passed as --model
  env: Record<string, string>;         // values may use ${SECRET_NAME}
  system_prompt: string;
  sampling?: {
    temperature?: number;
    max_tokens?: number;
  };
}
```

Example:

```json
{
  "version": 1,
  "secrets": {
    "DEEPSEEK_KEY": "sk-...",
    "ANTHROPIC_KEY": "sk-ant-..."
  },
  "agents": {
    "diary_observer": {
      "name": "Daily Observer",
      "description": "Brief factual observations on recent recordings",
      "model": "deepseek-chat",
      "env": {
        "ANTHROPIC_BASE_URL": "http://localhost:3456",
        "ANTHROPIC_API_KEY": "${DEEPSEEK_KEY}"
      },
      "system_prompt": "You are an observation assistant for a wearable AD-research dataset...",
      "sampling": { "temperature": 0.5, "max_tokens": 800 }
    },
    "diary_summarizer": {
      "name": "Weekly Summarizer",
      "model": "claude-sonnet-4-6",
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_KEY}"
      },
      "system_prompt": "Summarize one week of observations...",
      "sampling": { "temperature": 0.3, "max_tokens": 2000 }
    }
  }
}
```

`${SECRET_NAME}` is resolved at spawn time from the `secrets` block. Secrets never appear in the agents UI plain — just bullets + an unmask icon.

---

## 6. The `runAgent()` function (pseudocode)

```typescript
async function runAgent(
  agentId: string,
  userPrompt: string,
  onChunk?: (text: string) => void,
): Promise<{ body: string; model: string; duration_ms: number; cost_usd?: number }> {

  const agent = await agentStore.get(agentId);                   // throws if missing
  const env = resolveSecrets(agent.env, await agentStore.secrets());
  const claudeBin = resolveClaudeBinary();                       // existing helper

  const args = [
    '-p', userPrompt,
    '--output-format', 'stream-json',
    '--model', agent.model,
    '--append-system-prompt', agent.system_prompt,
    '--max-turns', '1',                                          // diary = single shot
  ];

  const t0 = Date.now();
  const child = spawn(claudeBin, args, {
    env: { ...process.env, ...env },                             // per-call override
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let body = '';
  let costUsd: number | undefined;
  for await (const line of readlines(child.stdout)) {
    const evt = JSON.parse(line);
    if (evt.type === 'assistant' && evt.message?.content) {
      const text = extractText(evt.message.content);
      body += text;
      onChunk?.(text);
    } else if (evt.type === 'result') {
      costUsd = evt.total_cost_usd;
    }
  }

  const code = await waitForExit(child);
  if (code !== 0) throw new AgentError(`claude exited ${code}: ${stderrCapture}`);

  return { body: body.trim(), model: agent.model, duration_ms: Date.now() - t0, cost_usd: costUsd };
}
```

That's the entire model-abstraction layer. The CLI binary is the abstraction.

---

## 7. API surface

All paths under `/api/diary/*`. All return JSON unless noted.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/diary/entries?limit=50&before=<id>` | Paginated timeline |
| GET | `/api/diary/entries/:id` | Single entry |
| POST | `/api/diary/entries/:id/read` | Mark read |
| POST | `/api/diary/entries/:id/reply` | Create chat session seeded with entry → returns `{session_id}` |
| POST | `/api/diary/trigger` | Manual run; body: `{agent_id?: string}` (default: today's daily agent) |
| GET | `/api/diary/stream` | SSE — events: `started`, `chunk`, `new`, `error`, `read` |
| GET | `/api/diary/config` | Current config |
| PATCH | `/api/diary/config` | Update config |
| GET | `/api/diary/agents` | List agents (secrets masked) |
| POST | `/api/diary/agents` | Create/replace one agent |
| DELETE | `/api/diary/agents/:id` | Delete agent (rejected if referenced by config) |
| POST | `/api/diary/agents/:id/test` | Run a 1-token ping; returns `{ok: bool, latency_ms, error?}` |
| GET | `/api/diary/secrets` | List secret keys (values masked) |
| PUT | `/api/diary/secrets/:name` | Set/update one secret value |
| DELETE | `/api/diary/secrets/:name` | Remove (rejected if referenced) |

**Reply path detail** (subtle): replying does NOT use the diary's agent. It creates a regular Claude chat session via existing `handleChatRequest` so tool use / MCP / slash commands all work normally. The entry body is injected as the first message context. UI shows a small note: *"Replies use Claude (full toolset)."*

---

## 8. Event flow (compact)

### Cold start (first ever launch)
1. Hono boots → `DiaryScheduler.init()` reads `diary_config.json` → file missing → write defaults `{enabled: false}` → no tick registered.
2. User opens `/diary` → empty state → "Try it now" or "Configure agents".
3. User adds DeepSeek key + saves an agent → Test passes → enables daily schedule.

### Daily cron tick
1. `setInterval(60_000)` fires → checks `now.HH:MM === schedule.daily.time` and `last_run_date < today` → match → call `runner.run('cron', config.schedule.daily.agent_id)`.
2. `contextBuilder` fetches `/api/recordings?limit=3` from FastAPI.
3. `runAgent(agent_id, prompt)` spawns `claude -p` with the agent's env.
4. Stream-json events parsed; `body` accumulated; SSE `chunk` events emitted (optional typewriter UI).
5. On exit code 0 → atomic-write entry → `EventBus.emit('diary.new')` → SSE `new` event → frontend Toast + sidebar badge bump.
6. Browser Notification API fires (if user authorized + not in quiet hours).

### Manual trigger / event trigger
Same as above but `trigger` field differs and (Phase 3) event trigger may use a different agent (`reactor`) and skip if quota exhausted.

---

## 9. UI sketches

### `/diary` (timeline page)

```
┌──────────────────────────────────────────────────────────┐
│  📓 Diary                                  [Generate now]│
│                                                          │
│  ─── Today ─────────────────────────────────────────     │
│  ┌──────────────────────────────────────────────────┐   │
│  │  09:00 · Daily Observer · deepseek-chat   ●NEW  │   │
│  │  Yesterday's HRV averaged 28ms, on the lower    │   │
│  │  end of your weekly baseline (32-45). Consider  │   │
│  │  a short rest before the next session.[¹]       │   │
│  │  [¹] hrv-interpretation                          │   │
│  │  [Reply]  [Mark read]  [⋯]                       │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ─── Yesterday ──────────────────────────────────────    │
│  ┌──────────────────────────────────────────────────┐   │
│  │  09:00 · Daily Observer · deepseek-chat          │   │
│  │  ...                                             │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### `/settings/diary` (schedule + agent picker)

```
Daily observation
   Time:        [ 09:00 ▼ ]   Daily quota: [ 3 ▼ ]
   Agent:       [ Daily Observer ▼ ]            [Edit]
   Last run:    yesterday 09:00 · ✓ ok · $0.002

Weekly summary
   Day/time:    [ Sunday ▼ ] [ 10:00 ▼ ]
   Agent:       [ Weekly Summarizer ▼ ]         [Edit]

Notifications
   Browser:     [×] enabled    Quiet: [22:00]–[08:00]

Manage agents                                    [+ New]
   Daily Observer       deepseek-chat       [Edit] [Test]
   Weekly Summarizer    claude-sonnet-4-6   [Edit] [Test]

Secrets                                          [+ New]
   DEEPSEEK_KEY      sk-•••• (used by 1 agent)   [Edit]
   ANTHROPIC_KEY     sk-ant-•••• (used by 2)     [Edit]
```

### Agent editor

```
┌────────────────────────────────────────────────────┐
│ Name           [ Daily Observer            ]       │
│ Model          [ deepseek-chat             ]       │
│                                                    │
│ Anthropic env (passed to claude -p):               │
│ ┌────────────────────────────────────────────────┐ │
│ │ ANTHROPIC_BASE_URL = http://localhost:3456     │ │
│ │ ANTHROPIC_API_KEY  = ${DEEPSEEK_KEY}           │ │
│ │ [+ add row]                                    │ │
│ └────────────────────────────────────────────────┘ │
│ Tip: leave empty to use ~/.claude/settings.json    │
│ defaults. Use ${NAME} to reference a saved secret. │
│                                                    │
│ System prompt:                                     │
│ ┌────────────────────────────────────────────────┐ │
│ │ You are an observation assistant for a         │ │
│ │ wearable AD-research dataset...                │ │
│ └────────────────────────────────────────────────┘ │
│ ~142 tokens                                        │
│                                                    │
│ Temperature  [───●───] 0.5                         │
│ Max tokens   [────●──] 800                         │
│                                                    │
│ [ Test (1-token ping) ]              [Cancel] [Save]│
└────────────────────────────────────────────────────┘
```

Test button result inline:
- ✓ green: `OK · 245ms · model echoed back`
- ✗ red: human-readable error mapped from claude-cli stderr (e.g. `auth failed (401)`, `model not found (404)`)

---

## 10. File-level changes

### Added

```
DIARY_SPEC.md                                    [this file]

data/                                            [new dir, gitignored]
├── agents.json
├── diary_config.json
└── diary_entries.json

backend/claude/diary/                            [new dir]
├── store.ts
├── agentStore.ts
├── contextBuilder.ts
├── runner.ts
├── scheduler.ts
├── eventBus.ts
└── prompts/
    └── daily_observation.md

backend/claude/handlers/diary.ts                 [new file]

frontend/src/components/diary/                   [new dir]
├── DiaryPage.tsx
├── EntryCard.tsx
├── AgentEditor.tsx
└── DiarySettingsPanel.tsx

frontend/src/api/diaryApi.ts                     [new file]
frontend/src/store/diaryStore.ts                 [new file]
```

### Modified

```
backend/claude/app.ts                  + import + register diary routes + init scheduler  (~10 lines)
backend/shared/types.ts                + DiaryEntry / DiaryConfig / AgentConfig types     (~50 lines)
frontend/src/App.tsx                   + /diary route                                     (~5 lines)
frontend/src/components/layout/*.tsx   + sidebar entry                                    (~5 lines)
.gitignore                             + data/                                            (~1 line)
```

**FastAPI (Python) is not modified.** Diary only consumes its existing read APIs.

---

## 11. MVP phasing

### Phase 1 — POC (1.5–2 days)

Goal: manual button → AI writes → entry shows up.

- [x] `data/` directory + atomic JSON IO helper
- [x] `agentStore` with hardcoded one agent (uses default settings.json env)
- [x] `runner.ts` — spawn `claude -p`, parse stream-json, return body
- [x] `contextBuilder` — fetches last 1 recording from FastAPI
- [x] `POST /api/diary/trigger` (manual only)
- [x] `GET /api/diary/entries`
- [x] `/diary` page with hardcoded refresh button (no SSE)
- [x] `EntryCard` with markdown render

**Done when**: clicking "Generate now" produces a markdown card within 10 seconds, no errors.

### Phase 2 — Schedule + Agents UI (2 days)

- [x] `setInterval(60_000)` tick loop with daily HH:MM check
- [x] SSE `/api/diary/stream` (mirror chat.ts pattern)
- [x] `diaryStore` Zustand mirror
- [x] Agent CRUD + `/settings/diary` UI
- [x] Test button with stderr-to-friendly-error mapping
- [x] Browser Notification API (opt-in)
- [x] Reply button → creates chat session, navigates to `/chat?session=<id>`
- [x] Read state + sidebar unread badge

**Done when**: schedule enabled at 09:00 → backend left running overnight → next morning entry exists, Toast appeared, badge shows 1, Reply enters chat with seeded context.

### Phase 3 — Optional, not committed yet (3–5 days)

- [ ] FastAPI emits webhook to Hono on recording_complete
- [ ] `reactor` agent + event-driven path
- [ ] Daily quota enforcement
- [ ] Weekly summary
- [ ] Quiet hours
- [ ] Cron expression support (replace simple HH:MM)

---

## 12. Open questions / risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | API key plain-text in `data/agents.json` | Single-user local prototype acceptable. Strict gitignore. UI never displays unmasked. Document in README. |
| 2 | Backend off → cron miss | On boot, check `last_run.daily < today AND now > schedule.time` → run a delayed entry tagged `delayed: true`. |
| 3 | Cost runaway (event triggers) | `daily_quota` config, default 3. Hit cap → drop event with log line. |
| 4 | claude-cli not installed | Reuse existing `resolveClaudeBinary()` failure path; surface in UI as "Claude CLI not found at expected paths". |
| 5 | Non-Anthropic provider via router that's not running | Test button catches at config time. At runtime, spawn fails fast (refused connection → mapped error). |
| 6 | Stream-json schema drift between Claude versions | Parser tolerates unknown event types (`if (evt.type === 'assistant')`). Skip unknowns. |
| 7 | "AI says you're fine" — clinical over-reliance | Permanent UI banner: *"Generated by AI. Not medical advice."* Agent prompts forbid diagnostic language. |
| 8 | User edits an agent currently being used by an in-flight run | Run holds a snapshot at spawn time; edits affect next run only. Document in UI. |
| 9 | Reply path inherits diary's cheap model? | No — Reply creates a **standard chat session** (via existing `/api/chat`), so it uses the user's normal Claude config. Document this seam clearly in UI. |
| 10 | Markdown XSS / injection from model output | Reuse the same react-markdown sanitization config as chat (already battle-tested). |

---

## 13. Definition of Done (Phase 1+2 combined)

A new user, given a working dashboard and a Claude API key, can:

1. Open `/settings/diary` → add `ANTHROPIC_KEY` secret → create a "Daily Observer" agent → press Test → see green ✓.
2. Set daily time to 5 minutes from now → wait → see a Toast pop up + badge increment.
3. Click into `/diary` → see the markdown card with content tied to a recent recording.
4. Click Reply → chat opens with the entry as context → ask "why?" → get a normal chat reply that references the entry.
5. Disable diary in settings → no further entries appear; existing entries remain readable.

If those five steps work clean on a fresh machine, ship it.

---

## 14. Confirmation checklist

Before implementation begins, confirm:

- [ ] Single-file `data/agents.json` (secrets + agents) is OK, vs separating into `secrets.json` + `agents/*.md`.
- [ ] `setInterval(60_000)` simple HH:MM scheduling for Phase 1+2 (defer cron expressions to Phase 3).
- [ ] Reply uses default Claude chat path, not the diary agent.
- [ ] Phase 3 is **deferred** — do not start until Phase 1+2 are running for a week.
- [ ] Default schedule is **disabled**; user must opt in (no surprise charges).
- [ ] `data/` is project-root-relative and gitignored.

---

## 15. Out of scope (explicit)

- Multi-tenant / cloud deployment
- Encrypted secret storage / OS keychain
- Streaming partial entries to UI as they generate (optional polish, not required)
- Importing diary entries from external sources
- Agent versioning / history
- A/B comparing two agents on the same entry
- Voice rendering of diary entries (TTS)

These may become follow-up specs once core diary is stable.

## USE example （expected final look not required everything in developing）

  ---
  场景 1：首次打开（冷启动 + 第一次设置）

  T+0s — 用户双击桌面图标 / 打开浏览器到 localhost:5173

  [Frontend] React 加载 → BackendGate 检查 :8080 + :3000 是否在线
      │
      ▼
  [Hono :3000 启动] app.ts createApp() 调用:
      │
      ├─ DiaryScheduler.init() 读 data/diary_config.json
      │   ├─ 文件不存在 → 写默认配置（enabled: false）
      │   └─ 不注册 cron job（默认关）
      │
      └─ 路由就绪

  T+2s — 前端首屏出来

  左侧边栏 ─ Dashboard / Chat / Settings / Diary [NEW · 0]
                                                ↑
                                          红点+badge=0（还没 entry）

  T+5s — 用户点 Diary

  [Frontend] 跳 /diary
      │
      ├─ GET /api/diary/entries → []  空数组
      └─ GET /api/diary/config  → {enabled: false, schedule: "0 9 * * *"}
      │
      ▼
  渲染 onboarding 空态:
     ┌─────────────────────────────────────────┐
     │  📓 Diary not running                    │
     │                                          │
     │  Claude can leave you a daily note       │
     │  about patterns it spots in your data.   │
     │                                          │
     │  [ Try it now ]   [ Enable daily 09:00 ] │
     │                                          │
     │  ⚠ Costs ~$0.02 per run · uses Claude API│
     └─────────────────────────────────────────┘

  T+10s — 用户点 "Try it now"（手动触发，验证一切能跑）

  [Frontend] POST /api/diary/trigger {kind: "manual"}
      │
      ▼
  [Hono] DiaryRunner.run("manual"):
      │
      ├─ ContextBuilder.build():
      │   GET http://localhost:8080/api/recordings?limit=3
      │   → [{ts: "20260428_140523", duration: 87, channels: [...]}]
      │
      ├─ 渲染 prompt 模板（注入 recordings 摘要）
      │
      ├─ query({prompt, model: "claude-sonnet-4-6"}) [SDK 流式]
      │   │
      │   ├─ stream message #1: {type: "init", session_id: "abc..."}
      │   │   └─► SSE push 给 /api/diary/stream 客户端: {kind: "started"}
      │   │
      │   ├─ stream messages #2-#N: text chunks
      │   │   └─► SSE push 增量内容（前端可显示打字机效果，可选）
      │   │
      │   └─ stream message: {type: "result", cost_usd: 0.018}
      │
      ├─ 组装 DiaryEntry { id, body, refs, cost_usd, ... }
      ├─ 写 data/diary_entries.json（原子）
      └─ EventBus.emit('diary.new', entry)
              │
              ▼
          SSE push: {kind: "new", entry: {...}}

  T+18s — 前端收到新 entry

  [Frontend] /api/diary/stream 收到 SSE event
      │
      ├─ diaryStore.addEntry(entry)
      ├─ Toast 弹一下 "📓 New diary entry"
      └─ Sidebar badge: Diary [NEW · 1]

  页面立刻渲染卡片:
     ┌─────────────────────────────────────────┐
     │ 📓 Today's observation · just now        │
     │                                          │
     │ Looking at your latest recording        │
     │ (20260428 14:05, 87s walking_normal),   │
     │ I noticed your HRV averaged 28ms which  │
     │ is on the lower end of your week's      │
     │ baseline (32-45). Consider a short      │
     │ rest before the next session.[¹]        │
     │                                          │
     │ [¹] wiki: hrv-interpretation.md         │
     │                                          │
     │ [Reply] [Mark read] [...]               │
     └─────────────────────────────────────────┘

  T+25s — 用户满意，回 Diary settings 开 daily cron

  [Frontend] PATCH /api/diary/config {enabled: true}
      │
      ▼
  [Hono] DiaryScheduler:
      cron.schedule("0 9 * * *", () => DiaryRunner.run("cron"))
      persist config
      │
      ▼
  返回 200 + 显示 "Next run: tomorrow 09:00"

  ---
  场景 2：第二天早上（cron 自动触发）

  T = 第二天 09:00:00 — 用户还在睡觉，dashboard 早就启动着

  [Hono] node-cron tick fires
      │
      ▼
  DiaryRunner.run("cron")  [和场景 1 流程一样]
      │
      │ ~10-15 秒后...
      ▼
  EventBus.emit('diary.new', entry)
      │
      ├─► SSE: 没有客户端连接（用户没开浏览器）→ 入内存队列
      └─► 持久化到 diary_entries.json （这一步保证了即使没人看也不丢）

  T = 10:30 — 用户起床，打开浏览器

  [Frontend] 加载 → BackendGate OK → 默认进 Dashboard
      │
      ▼
  Sidebar 拉 GET /api/diary/entries?unread=true&limit=5
      → [{id, title, created_at: "09:00"}]
      │
      ▼
  Sidebar: Diary [NEW · 1]   ← 红点提醒

  同时：

  [Frontend] App 加载时连上 SSE /api/diary/stream
      │
      ▼
  Hono 检测到新连接 → 不回放历史（避免重复弹窗），仅推未来事件

  T = 10:30:05 — 浏览器推送（如果用户授权过）

  Hono 在生成时其实已经发过浏览器通知
  （通过 service worker，授权过的话操作系统通知中心会留着）

  用户看到锁屏弹窗:
     ┌──────────────────────────────────┐
     │ 📓 Dashboard                      │
     │ Today's HRV is trending up       │
     │ from yesterday — nice work       │
     └──────────────────────────────────┘
     ↑ 点击直接跳 /diary 那条 entry

  T = 10:31 — 用户点开 Diary，看到 entry，按 Reply

  [Frontend] POST /api/diary/entries/<id>/reply
      │
      ▼
  [Hono] DiaryHandler.reply():
      1. 读 entry
      2. 构造 system message: "You wrote this earlier today: <entry.body>"
      3. 创建新 Claude session_id
      4. 把 entry 关联到 session: entry.reply_session_id = <new>
      5. 持久化
      6. 返回 {session_id, seed_messages: [...]}
      │
      ▼
  [Frontend] 跳转 /chat?session=<id>
      │
      ▼
  chatStore 加载 seed_messages → 用户看到聊天页已经有了上下文:
     ┌─────────────────────────────────┐
     │ 🤖 (Diary 09:00)                │
     │ "Today's HRV is trending up..."│
     │                                 │
     │ ─── continue conversation ───   │
     │                                 │
     │ [输入框]                        │
     └─────────────────────────────────┘

  T = 10:32 — 用户问"为什么会上升？"

  [Frontend] POST /api/chat {session_id: <reply_session>, message: "为什么会上升？"}
      │
      ▼
  [Hono] handleChatRequest() [完全走原有 chat 路径，零新代码]
      │
      ▼
  SSE 流式回复
      │
      ▼
  聊天对话正常进行，diary entry 已经成为这场对话的"种子上下文"

  ---
  场景 3：事件触发（Phase 3，用户刚完成一段录音）

  T = 14:23 — 用户在 dashboard 点 "Stop recording"

  [Frontend] POST /api/recording/stop
      │
      ▼
  [FastAPI :8080] RecordingService.stop():
      1. 关 WAV 文件
      2. 关 CSV 文件
      3. 落盘 sensor_20260428_142318.wav + .csv
      │
      └─► 新增 hook: HTTP POST http://localhost:3000/api/diary/event
                      {kind: "recording_complete", ts: "20260428_142318"}

  T = 14:23:01 — Hono 收到事件

  [Hono] DiaryHandler.event():
      │
      ├─ 检查 config.triggers.on_recording_complete? 否 → 丢弃
      │
      ├─ 检查 quiet_hours? 否
      │
      ├─ 检查 daily quota（防爆）：今天已生成 3/10 → 通过
      │
      └─ DiaryRunner.run("event", {recording_ts: "20260428_142318"})
          │
          ├─ ContextBuilder 这次只拉这一条录音的详细数据
          │   GET /api/recordings/20260428_142318/summary
          │
          ├─ 用 "post_recording_observation" 模板（更短，要求一句话点评）
          │
          └─ query() with model: "claude-haiku-4-5" [省钱用 Haiku]

  T = 14:23:08 — 用户还在 dashboard 上看实时波形，AI 主动开口

  界面右下角弹出气泡（不是日记卡片，是"对话气泡"样式）:

     ┌───────────────────────────────────────────────┐
     │ 🤖 Just now                                    │
     │                                                │
     │ Saw you finished a 2-min walking session.     │
     │ Your gait jerk was higher in the last 30s —   │
     │ tired? Want to log how you're feeling?        │
     │                                                │
     │ [Yes, log it] [Not now] [Stop these prompts]  │
     └───────────────────────────────────────────────┘

  - 点 Yes, log it → 跳 chat with 录音作为上下文，AI 引导用户口述感受
  - 点 Not now → 这条 entry 标 read=true, dismissed=true
  - 点 Stop these prompts → PATCH config triggers.on_recording_complete = false

  ---
  关键事件类型一览（SSE channel 上跑的）

  ┌──────────────────────┬────────────────────┬─────────────────────────────────────────────────┐
  │       event 名       │      何时发出      │                    前端反应                     │
  ├──────────────────────┼────────────────────┼─────────────────────────────────────────────────┤
  │ diary.started        │ Runner 开始跑      │ 显示 "Claude 正在思考..." 占位卡片              │

  界面右下角弹出气泡（不是日记卡片，是"对话气泡"样式）:

     ┌───────────────────────────────────────────────┐
     │ 🤖 Just now                                    │
     │                                                │
     │ Saw you finished a 2-min walking session.     │
     │ Your gait jerk was higher in the last 30s —   │
     │ tired? Want to log how you're feeling?        │
     │                                                │
     │ [Yes, log it] [Not now] [Stop these prompts]  │
     └───────────────────────────────────────────────┘

  - 点 Yes, log it → 跳 chat with 录音作为上下文，AI 引导用户口述感受
  - 点 Not now → 这条 entry 标 read=true, dismissed=true
  - 点 Stop these prompts → PATCH config triggers.on_recording_complete = false

---

## 16. Dead code / debt — `additionalSystemPrompt` injection path

**Status**: dead, kept in tree intentionally. Search marker:
`DEAD CODE — see docs/specs/diary.md "Dead code / debt"`.

### What it was

First attempt at the diary-Reply → chat handoff. Idea was to inject the
diary entry as a per-turn `appendSystemPrompt` so:

- Claude got the entry as background context.
- The visible chat history stayed clean (entry never showed as a user
  message).

Wire path:

1. `POST /api/diary/entries/:id/reply` returned
   `{ cwd, entry_id, additional_system_prompt }`.
2. Frontend stashed in sessionStorage, navigated to `/chat`.
3. ChatPage's first send included `additionalSystemPrompt: <entry>` in
   the `/api/chat` body.
4. Chat handler forwarded as SDK `appendSystemPrompt` option.
5. SDK's `claude_code` preset would (in theory) merge it into the
   system prompt for that turn.

### Why it's dead

In practice (Apr 2026, Claude Agent SDK 0.2.118 with
`systemPrompt: { type: "preset", preset: "claude_code" }`), the
appended prompt did **not** reach the model — Claude never had the
entry in scope and would shell out to `Bash`/`Read`/`Glob` to discover
diary files on disk. Confirmed in two live test sessions where
`appendSystemPrompt` was set but Claude responded as if it weren't.
Root cause not investigated; possibly the preset overrides /
deduplicates the appended chunk, or the SDK silently drops it under
the programmatic `query()` path (the diary RUNNER uses the CLI's
`--print --append-system-prompt` path which works fine).

### What replaced it

`ChatPage.handleSend` now **inlines the entry as a markdown blockquote
preface inside the first user message** when `inDiaryFirstSend` is
true. Visible in the bubble, written to the session JSONL, available
across `--resume`. Reliable, deterministic, no SDK magic.

### Why it's still in tree

Removing it touches 7 files (shared types, chat handler signature,
chat handler debug log, frontend wire types, diary handler reply
response, diary handoff plumbing, ChatPage handoff type). Each is
one-liner-ish but they form a consistent path; future Phase 3 work
might want a per-turn system prompt knob for unrelated reasons — e.g.
a "reactor" agent whose context *should* stay invisible in chat
history. Cleaner to keep the wire than rebuild it from scratch.

### Files marked

| File | What's dead |
|---|---|
| `backend/shared/types.ts` | `ChatRequest.additionalSystemPrompt` field |
| `backend/claude/handlers/chat.ts` | `executeClaudeCommand` `additionalSystemPrompt` param + `appendSystemPrompt` spread + `hasAdditionalSystemPrompt` debug log |
| `backend/claude/handlers/diary.ts` | `handleReply` builds + returns `additional_system_prompt` |
| `frontend/src/api/claudeApi.ts` | `ChatRequest.additionalSystemPrompt` field |
| `frontend/src/api/diaryApi.ts` | `ReplyResponse.additional_system_prompt` field |
| `frontend/src/components/diary/DiaryPage.tsx` | Reply handler stashes `additional_system_prompt` into the handoff |
| `frontend/src/components/chat/ChatPage.tsx` | `DiaryHandoff.additional_system_prompt` field (no longer read) |

### Decision rule

If Phase 3 ships and **no use case** for `additionalSystemPrompt` has
emerged — kill it all. `grep -rn 'DEAD CODE — see docs/specs/diary.md'`,
follow each hit, delete the field / param / spread / map entry.

If a Phase 3 feature does need it — first prove it actually reaches
the model (write a test that triggers a turn with a known marker
string in `appendSystemPrompt` and asserts the response references the
marker). Then update this section: remove the "dead" tag and document
what config makes it work.

---

## 17. Implementation deltas (Phase 1 + 2 ship state, Apr 2026)

What actually shipped vs. what the spec said, and why. Future readers
should treat this section as authoritative when it conflicts with the
earlier numbered sections — those describe the original design intent.

### 17.1 Stream protocol — NDJSON, not SSE

| Spec §7  | Shipped |
|---|---|
| `GET /api/diary/stream` Server-Sent Events | `GET /api/diary/stream` **NDJSON** (`application/x-ndjson`, one JSON per line) |

Reason: the existing chat handler at `backend/claude/handlers/chat.ts`
already uses NDJSON via `ReadableStream` + `application/x-ndjson` and
the frontend reads it via `fetch().body.getReader()`. Mirroring that
keeps the wire format consistent and lets `claudeApi`-style fetch
patterns be reused in `diaryApi.connectStream`. EventSource was
considered but rejected because it would have introduced a second
streaming idiom for one feature.

### 17.2 Data location — `backend/data/diary/`, not project-root `data/`

Spec §10 wrote "project-root `data/`". Shipped uses
`backend/data/diary/` to match the existing repo convention
(`backend/data/audio/`, `backend/data/csv/`, `backend/data/serial_logs/`
were already gitignored under that path). One gitignore line, one
mental model.

### 17.3 Diary follow-up chats — `<repo>/diary-replies/`

Reply button creates chats under a synthesised cwd at
`<repo>/diary-replies/`. The `ChatSidebar` already groups by `cwd`, so
all diary follow-ups land under one project header (`📓 Diary
replies`) without needing a new sidebar feature. The dir is
auto-created by the backend on first reply and gitignored.

### 17.4 Frontend nav — Header buttons, not sidebar

Spec §9 sketched a left sidebar with `Diary [NEW · n]`. Repo already
has a top `<Header>` with Dashboard / Chat / Settings tabs. Diary
shipped as a **fourth tab** with a red-dot unread badge on the button
itself. No sidebar.

### 17.5 Reply context handoff — inline preface, not `appendSystemPrompt`

Spec §7 implied the diary entry would be passed as system context so
the chat history stays clean. We tried that path (the
`additionalSystemPrompt` wire from frontend → chat handler → SDK
`appendSystemPrompt`) and it didn't work: with `systemPrompt: { type:
"preset", preset: "claude_code" }` the appended chunk never reaches
the model, so Claude responded as if the diary were absent and would
shell out to `Bash`/`Read`/`Glob` to discover the diary file on
disk. We switched to **prepending the entry as a markdown blockquote
preface inside the first user message**. Visible in the bubble,
written to the JSONL, available across `--resume`. Reliable.

The dead `additionalSystemPrompt` plumbing is documented in §16 above.

### 17.6 Provider model — direct Anthropic-compat endpoints, no router

Spec §2 design decision #2 said "non-Anthropic providers require a
router" (claude-code-router / LiteLLM). By Apr 2026 most major Chinese
+ international providers expose **native Anthropic-protocol
endpoints**, no router needed:

| Provider | Endpoint | Auth env |
|---|---|---|
| Anthropic | (default) | `ANTHROPIC_API_KEY` |
| DeepSeek | `https://api.deepseek.com/anthropic` | `ANTHROPIC_AUTH_TOKEN` |
| MiniMax (intl/cn) | `https://api.minimax.io/anthropic` / `…minimaxi.com/anthropic` | `ANTHROPIC_AUTH_TOKEN` |
| Zhipu Z.ai (intl/cn) | `https://api.z.ai/api/anthropic` / `…open.bigmodel.cn/api/anthropic` | `ANTHROPIC_AUTH_TOKEN` |
| Moonshot Kimi | `https://api.moonshot.ai/anthropic` | `ANTHROPIC_AUTH_TOKEN` |
| Alibaba Qwen | `https://dashscope-intl.aliyuncs.com/apps/anthropic` | `ANTHROPIC_AUTH_TOKEN` |
| Ollama | `http://localhost:11434/anthropic` | `ANTHROPIC_AUTH_TOKEN` (ignored) |
| Custom | user-supplied | user-supplied |

Registry lives in
`frontend/src/components/diary/providers.ts`. Adding a new provider
is a single object literal — see `docs/guides/diary-internals.md`.

### 17.7 Agent editor UX — Simple/Advanced two-mode

Spec §9 sketched a single dense form (name / model / env rows /
system prompt / sliders). Shipped as **two modes**:

- **Simple** (default): pick provider card → pick model card → paste
  API key → name + description. Auto-creates a per-provider secret
  (`MINIMAX_KEY`, `DEEPSEEK_KEY`, etc.) and writes the matching env
  block. Most users never touch raw env.
- **Advanced** (toggle): full env-rows + system-prompt + sampling
  editor. For routers, shared secrets, prompt tuning.

`detectProvider(env)` reverse-looks-up which provider card to select
when re-opening a saved agent.

### 17.8 Sampling fields — stored, not applied

`temperature` / `max_tokens` survive in the data model and editor but
**don't reach the model** — the bundled `claude` CLI doesn't expose
`--temperature` or `--max-tokens` flags. AgentEditor renders an amber
banner over those sliders saying so. If a future CLI version adds
flags, wire them up in `runner.ts` and remove the banner.

### 17.9 Token usage instead of $cost in UI

EntryCard previously showed `cost_usd`. Per user feedback that's an
implementation detail; replaced with **token count** (`tokens.input +
tokens.output`) captured from the CLI's `result.usage`. Old entries
without `tokens` fall back to a `body.length / 4` estimate.

### 17.10 Generate-now agent picker

Spec assumed cron is the primary path; "Try it now" was a one-liner.
Shipped includes a **per-button agent picker** so the user can fire a
specific agent without going through Settings. Defaults to
`config.schedule.daily.agent_id` if configured, else first agent in
the list. Built-in Haiku is **always** in the list (see §17.11).

### 17.11 Built-in Haiku always available

`agentStore.listAgents` always returns the built-in `diary_observer`
(claude-haiku-4-5) as the first option **unless the user explicitly
overrides that slot**. Reason: a misconfigured custom agent shouldn't
brick the diary — there's always a known-working fallback in the
dropdown.

### 17.12 Concurrent-run guard

Module-level `MAX_CONCURRENT_RUNS = 1` in `runner.ts`. Covers BOTH the
manual `Generate now` button AND the per-agent `Test` button — they
spawn through different code paths but share the same guard. Without
this, rapid clicks on Test or Generate stack up zombie `claude`
processes that hold network sockets and confuse the user.

### 17.13 Auth-retry kill switch

The bundled CLI's SDK retries 401s up to **10 times** with
exponential backoff (~5+ minutes total) and **does not honour the
`ANTHROPIC_MAX_RETRIES` env var** despite the SDK type definitions
listing it. Runner now watches the `api_retry` stream-json events and
sends `SIGTERM` after the **second consecutive 401**, surfacing
"Authentication failed (401)…" instead of a generic timeout 5+
minutes later.

### 17.14 Env isolation for non-Anthropic providers

When `agent.env.ANTHROPIC_BASE_URL` is set, runner **strips every
inherited `ANTHROPIC_*` from `process.env` and `~/.claude/settings.json`
env** before merging the agent env. Then it sets BOTH
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` to the same value (so
the CLI's auth resolver picks one regardless of which header style
the provider expects).

Background: a user with `ANTHROPIC_API_KEY=sk-ant-...` in
`settings.json` plus a MiniMax agent ended up with **two conflicting
auth credentials** in the spawned process env. The CLI mixed headers
and the request hung. Stripping inherited `ANTHROPIC_*` makes the
agent's env the sole source of truth for provider routing.

### 17.15 Force-delete agents

`DELETE /api/diary/agents/:id?force=1` clears any schedule / event
references **and disables the daily cron** (so it doesn't fire into
nothing) before deleting. Frontend offers this via a confirm dialog
on 409. Without `?force=1`, the endpoint refuses to delete an agent
that's still referenced.

### 17.16 Delete diary entries

Per-entry Delete button on `EntryCard`, gated behind "must be marked
read first" both client-side (button disabled) and server-side
(409). Prevents silently dropping a fresh cron entry the user hasn't
seen. Backend emits a `deleted` event to the NDJSON stream so multi-
tab views stay in sync.

### 17.17 EventBus crash hardening

`backend/claude/diary/eventBus.ts` parks a no-op `'error'` listener at
module load. Without this, emitting `{ type: 'error' }` when no
stream client is connected throws Node's `ERR_UNHANDLED_ERROR` and
**crashes the entire Hono process**. We hit this in production —
backend died silently and every subsequent request 500'd.

---

## 18. Phase 2.x feature requests on deck

User-requested follow-ups not yet implemented. Sized; pick one when
time allows.

- **Fork / drag chat sessions across projects** (~M) — User asked for
  the ability to drag a diary-reply chat into another project, or
  fork a diary chat into a fresh one. Needs ChatSidebar drag-drop UX
  + a backend endpoint to copy a session JSONL between project dirs.
- **Diary entry deduplication** (~S) — `contextBuilder` doesn't track
  which recordings have already been observed, so consecutive cron
  runs against the same recording window produce near-duplicate
  entries. Add a sidecar `last_observed_recordings.json` and skip
  recordings already covered by the previous N entries.
- **Browser notification refinement** — quiet hours respected, rate
  limit so cron + event triggers can't stack notifications, deep-link
  on click to the specific entry.
- **Phase 3 event triggers** — fire on `recording_complete` from the
  Python recording service (POST hook). Spec §11 has the design.