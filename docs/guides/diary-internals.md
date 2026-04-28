# Diary internals — implementation guide

A practical reference for "how the diary subsystem actually works."
Written for the future you who comes back six months from now and
wonders where to start. Pairs with [`docs/specs/diary.md`](../specs/diary.md)
(design intent + spec deltas) and
[`docs/journeys/diary-third-party-provider-debug.md`](../journeys/diary-third-party-provider-debug.md)
(the 401 retry-storm post-mortem).

## TL;DR

```
/diary  ───┐
   "Generate now"
            ▼
        Hono :3000
            │
            ▼
   handleTrigger ──▶ runAndPersist ──▶ runAgent
                          │                  │
                          │             spawn(claude -p)
                          │                  │
                          ▼          stdout: stream-json
                    diaryBus              ┌─assistant
                          │               ├─api_retry  ◄── auth-fail kill switch
                          │               └─result
                          ▼
                  /api/diary/stream  ──▶  every connected /diary tab
                  (NDJSON)               + /diary handles "new" event
                                         + Header badge bumps
                                         + Toast pops
```

## Module map

### Backend (Hono, TS, runs on :3000)

| File | Role |
|---|---|
| `backend/claude/diary/store.ts` | Atomic JSON IO for entries, config, agents file. Defines `DATA_DIR` (`backend/data/diary/`) and `DIARY_REPLIES_DIR` (`<repo>/diary-replies/`) |
| `backend/claude/diary/agentStore.ts` | Agent + secret CRUD. Resolves `${SECRET}` references. Always exposes the built-in Anthropic Haiku as a fallback option |
| `backend/claude/diary/contextBuilder.ts` | Pulls recent recordings from FastAPI (`/api/recordings/list`) and builds the user prompt |
| `backend/claude/diary/runner.ts` | Spawns `claude -p`, parses stream-json, kills on auth-retry-storm, single-flight guard, env isolation for custom providers |
| `backend/claude/diary/orchestrator.ts` | One run end-to-end: build context → run agent → persist entry → emit bus events |
| `backend/claude/diary/scheduler.ts` | `setInterval(60s)` daily HH:MM tick + boot catch-up |
| `backend/claude/diary/eventBus.ts` | In-process `EventEmitter` shared between runner, scheduler, and `/api/diary/stream` |
| `backend/claude/handlers/diary.ts` | All `/api/diary/*` HTTP handlers (~17 endpoints) |
| `backend/claude/diary/prompts/daily_observation.md` | Default system prompt for the built-in Haiku agent |

### Frontend (React + Zustand, runs on :5173)

| File | Role |
|---|---|
| `frontend/src/api/diaryApi.ts` | HTTP client + NDJSON stream consumer (`fetch().body.getReader()`) |
| `frontend/src/store/diaryStore.ts` | Zustand store; entries, config, agents, secrets, in-flight, toast signals, browser-notification side-effect |
| `frontend/src/components/diary/DiaryPage.tsx` | `/diary` timeline; agent picker, Generate/Cancel button, pinned in-flight chunk preview |
| `frontend/src/components/diary/EntryCard.tsx` | One entry row. Reply, Mark read, Delete (read-gated) |
| `frontend/src/components/diary/AgentEditor.tsx` | Two-mode form (Simple / Advanced). Provider+model card pickers. Auto-secret save |
| `frontend/src/components/diary/DiarySettingsPanel.tsx` | Settings tab body; schedule, agents list, secrets (collapsed by default) |
| `frontend/src/components/diary/providers.ts` | Provider registry (Anthropic + 8 third-party + custom) |
| `frontend/src/components/AppBridge.tsx` | App-lifetime owner of the diary stream connection (so cron events arrive even on `/dashboard` or `/chat`) |
| `frontend/src/components/layout/Header.tsx` | Diary tab + unread red-dot badge |
| `frontend/src/components/chat/ChatPage.tsx` | Pinned diary-context card on Reply handoff; first-send preface injection |

## Data on disk

```
<repo>/
├── backend/data/diary/             # gitignored
│   ├── diary_entries.json          # array of DiaryEntry, newest first
│   ├── diary_config.json           # schedule, notification, last_run, master switch
│   └── agents.json                 # { secrets: {NAME:value}, agents: {id:AgentConfig} }
└── diary-replies/                  # gitignored
    └── (empty — exists so chat sessions started from diary Reply
         have a stable cwd that the chat sidebar can group under)
```

`agents.json` holds API keys in plaintext. It's gitignored. The UI
masks values when displaying. Don't worry about it for a single-user
local prototype; revisit if this ever becomes multi-user / cloud.

## Provider env model — the load-bearing trick

Diary can talk to Anthropic, DeepSeek, MiniMax, Z.ai (GLM), Moonshot
(Kimi), Qwen, Ollama, or any router (claude-code-router / LiteLLM)
**because of how `claude` CLI's auth resolves**:

- `ANTHROPIC_BASE_URL` — endpoint to hit. Empty = default
  `api.anthropic.com`.
- `ANTHROPIC_AUTH_TOKEN` — sets `Authorization: Bearer <token>` HTTP
  header. Used by most third-party endpoints.
- `ANTHROPIC_API_KEY` — sets `x-api-key: <key>` HTTP header. Used by
  Anthropic native.
- `--model <id>` — passed verbatim. Provider-specific id format.

That's it. There's no "provider" CLI flag. Routing is 100%
env-driven.

### Per-agent env isolation (this prevents bugs)

When `agent.env.ANTHROPIC_BASE_URL` is set, runner:

1. **Strips every `ANTHROPIC_*` from `process.env` and
   `~/.claude/settings.json` env** before merging.
2. Merges the agent's own env on top.
3. **Sets BOTH `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` to the
   same value** so the auth resolver picks one and the actual HTTP
   request gets a usable header regardless of provider preference.
4. Logs `auth_resolved=ANTHROPIC_AUTH_TOKEN(filled)` to stderr — if
   it shows `(UNRESOLVED)`, the secret reference resolution
   failed. Fix the secret, don't blame the endpoint.

**Why**: a user with `ANTHROPIC_API_KEY=sk-ant-...` in their
`settings.json` (for direct Claude use) and a MiniMax agent ended up
with two competing auth credentials. Mixed headers → 401 → retry
storm → 5min hang. See the debug journey doc for the full story.

## Stream protocol — NDJSON, not SSE

`GET /api/diary/stream` returns `application/x-ndjson` (one JSON object
per `\n`-terminated line). Mirrors the chat handler's wire format so
both sides reuse the same `fetch().body.getReader()` parser.

Event types (see `backend/claude/diary/eventBus.ts`):

| `type` | When | Payload |
|---|---|---|
| `hello` | First send on a fresh connection | `{ t }` |
| `heartbeat` | Every 25s | `{ t }` |
| `started` | Runner spawns claude | `{ request_id, agent_id, trigger, started_at }` |
| `chunk` | Each assistant text delta | `{ request_id, delta }` |
| `new` | Entry persisted | `{ request_id, entry }` |
| `error` | Run failed | `{ request_id, error, stderr_excerpt? }` |
| `read` | Entry marked read | `{ entry_id }` |
| `deleted` | Entry deleted | `{ entry_id }` |

`error` is also Node's special EventEmitter sentinel — see "Things
that bit us, and how" below.

## How a manual run flows end-to-end

User clicks "Generate now" with the MiniMax agent picked.

1. **`DiaryPage.tsx`** calls `triggerNow('new_agent')`
2. **`diaryStore.triggerNow`** sets `generating: true`, calls
   `diaryApi.trigger('new_agent')`
3. **`POST /api/diary/trigger`** → `handleTrigger`:
   - Single-flight check (`manualTriggerRequestId`) — refuse with 409
     if another is in flight
   - Calls `runAndPersist({ trigger: 'manual', agentId, requestId,
     signal })`
4. **`orchestrator.runAndPersist`**:
   - Emits `started` to `diaryBus`
   - Calls `contextBuilder.build()` → fetches `/api/recordings/list`
     from FastAPI :8080, formats as a markdown table embedded in the
     prompt
   - Calls `runner.runAgent(agentId, prompt, { signal, onChunk })`
5. **`runner.runAgent`** → `runAgentImpl`:
   - Resolves secrets (`${MINIMAX_KEY}` → actual value)
   - Refuses to spawn if any env value still has literal `${...}`
   - Strips inherited `ANTHROPIC_*` if `usesCustomProvider`
   - Builds args: `-p <prompt> --output-format stream-json --verbose
     --model MiniMax-M2.7-Highspeed --append-system-prompt <agent's
     prompt> --tools "" --no-session-persistence -d api`
   - Spawns claude binary
   - Parses stream-json line by line:
     - `assistant` → accumulates body, fires `onChunk`
     - `system.api_retry` → logs warn; kills process after 2nd 401
     - `result` → captures `total_cost_usd`, `usage.{input,output}_tokens`
   - Throws `AgentError` on failure with `stderr_excerpt`
6. **`runAndPersist`** wraps the result into a `DiaryEntry`, calls
   `store.appendEntry`, emits `new` to `diaryBus`
7. **`diaryBus`** broadcasts to:
   - `GET /api/diary/stream` → all connected NDJSON clients
   - Frontend `diaryStore.handleStreamEvent` mutates state →
     re-renders DiaryPage, Header badge, Toast

Round-trip is 5–15 seconds depending on model. Token + duration
captured.

## How to add a new Anthropic-compat provider

1. Open `frontend/src/components/diary/providers.ts`.
2. Add an entry to `PROVIDERS`:

   ```ts
   {
     id: 'newprovider',
     label: 'New Provider',
     shortNote: 'Anthropic-compatible · whatever.com',
     baseUrl: 'https://api.newprovider.com/anthropic',
     authTokenEnvKey: 'ANTHROPIC_AUTH_TOKEN',
     apiKeyDashboard: 'https://newprovider.com/console',
     defaultModelId: 'fast-model',
     defaultAgentName: 'NewProvider Observer',
     models: [
       { id: 'fast-model', label: 'Fast Model', hint: 'cheap + fast' },
       { id: 'pro-model', label: 'Pro Model', hint: 'flagship' },
     ],
   },
   ```

3. (Optional) Add a new entry to `suggestSecretName`'s map so the
   auto-created secret has a friendly name (e.g. `NEWPROVIDER_KEY`).
4. Done. AgentEditor's simple-mode picker, model dropdown, and
   secret auto-save all read from `PROVIDERS` — there's no other
   place to update.

If the new provider uses `x-api-key` (Anthropic-style) instead of
`Authorization: Bearer`, set `authTokenEnvKey: 'ANTHROPIC_API_KEY'`.
The runner sets both at spawn time anyway, so this is mostly
cosmetic for the editor's hint text.

## How to debug a "stuck on Generating" report

In the backend terminal, look for these in order:

1. `[diary] agent <id> uses custom ANTHROPIC_BASE_URL=...; stripped
   inherited ANTHROPIC_* env; normalised API_KEY=AUTH_TOKEN`
   - Confirms the custom-provider isolation kicked in.
2. `[diary] spawn diag: model=... anthropic_env=[...]
   auth_resolved=ANTHROPIC_AUTH_TOKEN(filled)`
   - **`(filled)`** means the secret resolved correctly.
   - **`(UNRESOLVED)`** means the env value is still literal
     `${SOMETHING}`. The secret name in the agent's env doesn't match
     any saved secret. Fix: re-paste API key in agent editor.
3. `[diary cli api_retry] attempt=N/10 status=401 error=authentication_failed`
   - 401 = the provider rejects the key. Most likely cause: wrong key.
   - The runner kills after 2 consecutive 401s, so you'll see
     attempt=1/10 and attempt=2/10 then exit.
4. `[diary cli api_retry] ... status=4xx ...` (other 4xx)
   - 400 = malformed request. Check model id (typo / model
     deprecated).
   - 404 = endpoint URL wrong. Re-check `baseUrl` in `providers.ts`.
5. `[diary cli stderr] <anything>`
   - Live passthrough of claude CLI's own stderr. If `-d api` is on
     (auto-set for custom providers) you'll see HTTP request URLs
     too.
6. `[diary cli exit] code=0 signal=null` + `[diary] entry <id>
   saved` = success.
7. **No api_retry, no exit, just sits**: likely a TCP connection
   stall. Check the user's network can reach the endpoint with curl.

Quick endpoint sanity-check from the user's machine:

```bash
curl https://<provider-base-url>/v1/messages \
  -H "Authorization: Bearer $YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"<model-id>","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

200 = key + endpoint valid; runner config bug. 401 = key bad.

## Concurrency model

- **Single in-flight diary run, anywhere**:
  `runner.activeRunCount` caps at 1. Both the trigger handler and
  the test handler go through `runAgent`, so both paths are
  guarded.
- **Single in-flight manual trigger** (additional layer):
  `handleTrigger` tracks `manualTriggerRequestId` so a 2nd Generate
  click during an in-flight run gets a 409 with a friendly message
  instead of an opaque `ConcurrentRunError`.
- **Cron tick + manual at the same time**: cron's `runAndPersist`
  also goes through `runAgent` so it'll see `ConcurrentRunError` and
  log + skip if a manual trigger is mid-run. (Race window is small;
  cron runs once per day.)
- **Test agent button**: shares the same `runAgent` guard. If you
  click Test while Generate is running, you get a clear error.

## Auth-retry kill switch (load-bearing)

The bundled `claude` CLI binary retries 401s up to 10× with
exponential backoff (~5+ minutes). It does **not** honour
`ANTHROPIC_MAX_RETRIES` despite the SDK type defs listing it.

Runner sidesteps by parsing `system.api_retry` events from the CLI's
own stream-json and sending `SIGTERM` after the 2nd consecutive 401.
This turns a 5-minute hang into a 5-second clear error.

If you ever upgrade the CLI and the env var starts working, you can
simplify by trusting it instead — verify by setting
`ANTHROPIC_MAX_RETRIES=2` and watching: if `attempt=1/2` shows up in
the api_retry events (not `1/10`), the CLI's reading it. Until then,
the manual kill stays.

## Things that bit us, and how

### EventEmitter `'error'` is a foot-gun

Node's `EventEmitter.emit('error', payload)` **throws** if no `error`
listener exists, killing the process. We park a no-op
`bus.on('error', () => {})` at module load in `eventBus.ts`. Don't
remove it.

### `${SECRET}` placeholder leaking into HTTP headers

If `resolveSecrets` can't find a referenced secret, it returns the
literal `${NAME}` string. Sending that as an Authorization header
yields a 401 that **looks identical to a wrong key**. Runner now
explicitly refuses to spawn if any env value matches
`/^\$\{[A-Z0-9_]+\}$/`. Always check the spawn-diag log
(`auth_resolved=...(UNRESOLVED)`) when chasing a 401.

### `appendSystemPrompt` doesn't reach the model under `claude_code` preset

The frontend → `additionalSystemPrompt` → SDK `appendSystemPrompt`
wire is plumbed end-to-end but **does nothing** with `systemPrompt:
{ type: "preset", preset: "claude_code" }`. We instead inline the
diary entry as a markdown blockquote preface in the first user
message of a Reply chat. The dead wire is documented in
[`docs/specs/diary.md` §16](../specs/diary.md). Don't try to revive
it without first writing a unit test that proves it actually reaches
the model.

### `--bare` forces wrong header style

`--bare` mode strictly reads `ANTHROPIC_API_KEY` and sends `x-api-key`
headers. Most third-party endpoints (DeepSeek, MiniMax, Z.ai,
Moonshot, Qwen) require `Authorization: Bearer` (the
`ANTHROPIC_AUTH_TOKEN` style). We tried `--bare` for OAuth-bypass
reasons; turned out we didn't need it once we fixed the retry kill
switch. Don't add `--bare` back for third-party providers.

## How to test changes

| What you changed | Manual test |
|---|---|
| Provider in `providers.ts` | Settings → Diary → New agent → pick provider → save → Test button. Should be green in <10s |
| Runner spawn args | Trigger Generate now with built-in Haiku. Watch backend log for `[diary] spawn diag` |
| Stream events | Open `/diary` in two browser tabs. Trigger from one. Other tab should update without manual refresh |
| Force-delete | Set agent as daily schedule agent → try delete → should 409 → confirm second prompt → succeed |
| Concurrent guard | Click Generate then immediately Test on the same agent. Second should error out fast |
| EventBus crash hardening | Trigger an error scenario (bad agent) without any `/diary` tab open. Backend must NOT crash |
| Reply context | Click Reply on an entry. Chat page should show pinned card. Send "what was in the diary?" → assistant should quote the entry without using tools |

There are no automated tests yet. Worth adding:

- Unit test for `resolveSecrets` with missing secret (should leave
  literal `${...}`, runner pre-flight should reject).
- Unit test for env isolation: agent with custom `ANTHROPIC_BASE_URL`
  + inherited `ANTHROPIC_API_KEY` from process env → final env should
  have the agent's auth, not the inherited one.
- Integration test against a mock Anthropic-compat HTTP server that
  returns 401 → runner should kill after 2 retries with a clear
  AgentError.

## Where to start when extending

- **New provider** → `providers.ts` (see above).
- **New event trigger** (e.g. on recording-complete) → spec §11
  Phase 3. Add to `diaryBus`, register from FastAPI via webhook,
  guard with `daily_quota`.
- **New per-entry action** (e.g. "regenerate", "share") → add to
  `EntryCard.tsx` props + diaryStore actions + backend route.
- **New agent capability** (e.g. tools, MCP servers) → currently
  blocked by `--tools ""` in the runner. Lifting that means thinking
  about diary-scoped permission UX, which we deferred. Read the chat
  handler's `canUseTool` for prior art.
