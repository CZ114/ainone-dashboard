# Changelog

All user-facing changes to AinOne Dashboard.

## v1.1.3 — 2026-04-28

### Added

- **Diary: AI-generated daily observations.** New `/diary` route shows
  short markdown observations Claude leaves about your recent
  recordings, on a schedule or on demand. Each entry is one paragraph
  + a few bullets, grounded in actual recording timestamps and
  sensor stats. Reply opens a real chat session pre-loaded with the
  entry as context, persisted under the `📓 Diary replies` project
  group in the chat sidebar.
- **Multi-provider model support — no router needed.** Diary agents
  can target Anthropic, DeepSeek, MiniMax (intl + cn), Zhipu Z.ai
  (intl + cn), Moonshot Kimi, Alibaba Qwen, or Ollama via each
  provider's native Anthropic-protocol endpoint. Pick provider →
  pick model → paste API key → done. Custom mode for routers /
  any-other-endpoint. Registry lives in
  `frontend/src/components/diary/providers.ts` — adding a new
  provider is a single object literal.
- **Daily schedule + browser notifications.** Set `HH:MM` in
  Settings → Diary, optionally enable browser notifications. Cron
  ticks every 60s; if the dashboard wasn't running when the
  schedule fired, a delayed entry is generated on next boot
  (tagged `delayed: true`).
- **Live in-flight preview.** The `/diary` page shows the assistant's
  text streaming in as the agent writes, via NDJSON broadcast over
  `/api/diary/stream`. Sibling tabs see the same updates.
- **Per-entry actions.** Reply (with diary context inlined into the
  first user message), Mark read, Delete (read-gated). Header shows
  an unread red-dot badge that survives navigation.
- **Settings → Diary tab.** Master enable, daily schedule + agent
  picker, quiet hours, browser notifications, agent CRUD with
  built-in Test (1-token ping with friendly 401/404/connection-
  refused mapping), and a collapsible Secrets manager (auto-managed
  by simple-mode agent edits — most users never touch it).

### Fixed

- **Spurious 5-minute "timeout" against third-party providers.** The
  bundled `claude` CLI retries 401s up to 10× with exponential
  backoff (~5+ min total) and **does not honour the documented
  `ANTHROPIC_MAX_RETRIES` env var**. Diary's runner now watches the
  `api_retry` stream-json events and `SIGTERM`s the spawn after the
  2nd consecutive 401, surfacing "Authentication failed (401) on the
  provider endpoint…" in ~5s instead of ~5 min. See
  `docs/journeys/diary-third-party-provider-debug.md` for the full
  hunt.
- **Auth env conflict between settings.json and per-agent env.** When
  an agent declares its own `ANTHROPIC_BASE_URL`, the runner now
  strips every `ANTHROPIC_*` from `process.env` and
  `~/.claude/settings.json` before merging the agent's env, then
  sets BOTH `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` to the
  same value so any provider's preferred header style works.
- **EventEmitter `'error'` could crash the whole backend.** Diary's
  in-process bus emits `{ type: 'error' }` on run failure; without a
  direct `error` listener Node's EventEmitter throws
  `ERR_UNHANDLED_ERROR` and kills the Hono process. A no-op `error`
  listener is now parked at module init.
- **`${SECRET}` placeholder leaking into HTTP headers.** When a
  user-saved agent referenced a secret that no longer existed,
  `resolveSecrets` returned the literal string and the CLI would
  send `Authorization: Bearer ${MINIMAX_KEY}` to the provider — a
  401 indistinguishable from a wrong key. Runner now refuses to
  spawn when any env value matches `^${...}$` and surfaces a clear
  "Re-paste your API key" error.

### Internal

- **Single-flight guard across all diary spawns.** Module-level
  `MAX_CONCURRENT_RUNS = 1` covers both the manual `Generate now`
  trigger and the per-agent `Test` button — they go through
  different HTTP routes but share the same `runAgent` entry point.
  Throws `ConcurrentRunError` on the second concurrent attempt,
  preventing zombie `claude` processes when the user rapid-clicks.
- **Cancel button on `/diary`.** New `POST /api/diary/abort` kills
  the spawned process when the user wants to stop mid-generation.
- **Force-delete agents.** `DELETE /api/diary/agents/:id?force=1`
  clears any schedule/event references and disables the daily cron
  before deleting (so it doesn't fire into nothing). Frontend offers
  this via a second confirm dialog when it sees a 409.
- **Built-in Anthropic Haiku always in dropdowns.** `listAgents`
  prepends the built-in `diary_observer` (Haiku) unless the user
  has explicitly overridden that slot, so a misconfigured custom
  agent can never brick the diary.
- New module map: `backend/claude/diary/` (store / agentStore /
  runner / orchestrator / scheduler / contextBuilder / eventBus /
  prompts) + `backend/claude/handlers/diary.ts` (~17 endpoints).
  Frontend mirror under `frontend/src/components/diary/` +
  `frontend/src/api/diaryApi.ts` + `frontend/src/store/diaryStore.ts`.
- **Documentation**: full spec at `docs/specs/diary.md`, hunt
  post-mortem at `docs/journeys/diary-third-party-provider-debug.md`,
  practical reference + "how to add a provider" guide at
  `docs/guides/diary-internals.md`.

## v1.1.2 — 2026-04-28

### Fixed

- **Disabling the Whisper extension no longer crashes the backend.**
  Toggling Whisper off was running `on_stop`, dropping the
  `WhisperModel` reference, and letting GC run CT2's CUDA destructor —
  which segfaults on Windows + GPU (`STATUS_STACK_BUFFER_OVERRUN`,
  exit code `0xC0000409`). The supervisor only respawns on exit
  code 42, so the whole backend went down. Same root cause as the
  in-process model swap that's already disabled (§15.7).

### Internal

- New `Extension.release_on_stop: bool = True` opt-out flag.
  Extensions whose native resources are unsafe to free mid-process
  set this to `False`; `WhisperLocalExtension` does.
- `ExtensionManager` keeps a `_retained_instances` dict for those
  opt-outs. `disable()` parks the instance there after `on_stop`;
  `enable()` pops it back, so the already-loaded model survives the
  toggle. Re-enable is essentially instant — `on_start` short-circuits
  the load because `self._model` is still set.

## v1.1.1 — 2026-04-28

### Added

- **Cross-session full-text search.** New `GET /api/sessions/search`
  endpoint runs a case-insensitive substring scan across every
  message in every `.jsonl` under `~/.claude/projects` and returns
  ranked snippets with ±150 chars of context. UI is embedded right in
  the chat sidebar — the search input replaces the project list when
  active, with debounced requests, arrow-key navigation, and Enter
  to open the matching session.
- **Session summary now shows Claude's first reply.** Every session
  in the sidebar gets a second preview line — the user's first
  question on top, Claude's first substantive reply underneath —
  visible without opening the conversation.
- **Markdown rendering for chat messages.** Claude's responses now
  render with proper headings, lists, tables, code fences, **bold**,
  and links via `react-markdown` + `remark-gfm`. Replaces the old
  plaintext `<pre>` fallback that was eating every structural cue.
- **Two-pane resizable layout.** Old paired drawer toggles
  ("Recordings" + "History") are replaced with a single
  horizontally-resizable layout: chat / terminal on the left, history
  + recordings stacked on the right with their own vertical resize
  handle. The right panel collapses entirely via a "Focus mode" header
  button; the choice persists across reloads.
- **Inline audio preview on every recording row.** Native
  `<audio controls preload="none">` element streams from
  `/api/recordings/audio/<filename>` so the user can listen before
  attaching to chat or running transcription. `preload="none"` keeps
  the panel from prefetching every WAV on mount.

### Changed

- **Theme overhaul: warm-charcoal + clay-tan + sage.** Full palette
  rework via a CSS-variable token ladder (surfaces, text, accent,
  status). Dark mode = warm near-black chrome with soft sienna /
  clay-tan accent and sage as the secondary character colour;
  light mode = cream / parchment with the same accent family pulled
  toward muted clay-tan. Sage green replaces electric blue as the
  recording / character indicator. Channel-trace colours (PPG = red,
  IMU = blue, etc.) stay hard-coded — they're semantic brand
  identities for chart legends.
- **Custom scrollbars** matched to the warm palette via WebKit pseudo-
  elements + Firefox `scrollbar-color`. The OS-default light-grey
  track was reading as "white stripe" against the dark chrome.
- **xterm.js terminal palette themed** to the warm-charcoal chrome —
  green pulled toward sage so `ls --color` doesn't spike out of the
  palette; yellow desaturated to mustard; blue / magenta / cyan
  softened. Reapplies live on theme toggle.
- **Unified button colour rules** across the app: idle primary CTAs
  (Connect / Scan / Start / Start Recording) → `bg-accent`;
  destructive / undo (Disconnect / Stop / Stop Recording) →
  `bg-status-danger`. Hover uses `opacity-90` so the rule reads
  identically in light and dark.
- Mass blue→accent migration across chrome components (Toast,
  channels, chat, settings, layout). Channel colours and the
  ThemeToggle icon are the only intentional blue references that
  remain.
- Empty / loading states for the chat region now centre to a
  `min-h-[60vh]` wrapper so they feel like the same kind of UI
  rather than a tiny spinner adrift at the top.

### Fixed

- **Session-summary extractor was silently dropping Claude's
  substantive replies.** A typical Claude turn looks like
  `[text, tool_use, text]` — the old code returned only `blocks[0]`,
  which was usually a one-line "Let me check..." preamble. The new
  extractor concatenates all text blocks, surfaces tool calls as
  `[tool: <name>]` markers, and recurses into `tool_result.content`.
  The same function powers the search-snippet path, so search now
  sees Claude's full reply text instead of just the first fragment.

### Internal

- New shared module `frontend/src/components/chat/MessageMarkdown.tsx`
  hosts the markdown renderer; deliberately does **not** pull in
  syntax highlighting (saves 200 KB+) or `@tailwindcss/typography`
  (would fight the project's own theme tokens with `!important`
  defaults).
- Layout uses `react-resizable-panels` v4 — note the v4 names
  (`Group` / `Panel` / `Separator`), not v3's `PanelGroup` /
  `PanelResizeHandle`.

## v1.0.7 — 2026-04-26

### Added

- **Inline tool-permission prompts in chat.** When the SDK is in `Ask
  before edit` or `Plan` mode, every tool call now surfaces an inline
  bubble with three primary actions: `Allow once`, `Allow always` (when
  the SDK supplies suggestions), and `Deny` — Deny opens a textarea so
  the user's reason is fed back to Claude verbatim. Decisions collapse
  to a one-line audit trail (`✓ Allowed`, `✗ Denied — <reason>`) so
  scrolling the chat shows exactly what was approved.
- **Fifth permission mode `Auto`.** Added to the toolbar pill alongside
  the existing four. Maps to the SDK's built-in `'auto'` mode where a
  model classifier decides per-tool whether to run silently or escalate
  — no more hand-tuning between "ask everything" and "ask nothing".
  Toolbar labels also clarified: `Ask before edit` / `Edit auto` /
  `Bypass` / `Plan` / `Auto`.
- **VS-Code-style picker for `AskUserQuestion`.** When Claude calls the
  built-in question tool, the bubble swaps the Allow/Deny pair for a
  numbered, keyboard-first picker: ↑↓ navigates options (wraps across
  questions at the edges), `1`–`9` jumps directly, `Space` toggles in
  multi-select, `Tab` lands on Submit, `Cmd/Ctrl+Enter` sends. A
  textarea below the options accepts a free-form custom answer that
  overrides the picks.
- **Expandable tool-call bubbles.** Tool bubbles (`Bash`, `Read`, `Edit`,
  `Grep`, `WebFetch`, …) are now collapsed by default but expand to
  show the full input JSON plus the SDK's `tool_use_id`. The collapsed
  preview is per-tool — Bash shows the command, Read/Edit/Write show
  the file path, Grep shows the pattern, etc. — instead of just listing
  argument names.
- **Tool-result bubbles.** Tool results stream back from the SDK as
  collapsed slate-grey bubbles (or auto-expanded red ones when
  `is_error: true`), matched to their originating call by
  `tool_use_id`. Provides post-execution feedback that was previously
  silent.

### Changed

- Permission and AskUserQuestion bubbles use the project's neutral
  card-bg theme tokens with a thin coloured left rule (amber for
  permission, blue for ask-question) instead of full coloured fills.
  Visually consistent with other chat bubbles in both light and dark
  modes.

### Internal

- Backend `executeClaudeCommand` refactored from "directly yield" to a
  manual async-queue model so the SDK loop and the new `canUseTool`
  callback can both push events onto the same NDJSON stream.
- New endpoint `POST /api/chat/permission` accepts the user's decision
  and resolves the pending SDK Promise. Aborts cleanly when the user
  cancels the request mid-prompt.
- New developer tutorial: `WRAPPING_NATIVE_PICKER_GUIDE.md` — step-by-
  step rebuild of the picker pipeline, with the actual failed attempts
  and how each one was diagnosed.

## v1.0.6 — 2026-04-26

### Added

- **BLE device name and UDP audio port are now user-editable.** Both
  used to be hardcoded (BLE always scanned for `ESP32-S3-MultiSensor`,
  audio always listened on UDP 8888) and required a `config.py` edit
  + restart to change. They're now plain inputs in the connection
  panel, persisted to `localStorage` per user. Defaults still match
  the backend constants. The BLE name flows through the existing
  `/api/ble/scan` endpoint (now accepting an optional `device_name`
  in the request body); the audio port was already accepted by
  `/api/audio/start` — only the frontend was hardcoding it.

## v1.0.5 — 2026-04-26

### Changed

- **Attachment ceiling raised to 20 MB end-to-end.** Two layers held
  the previous low caps:
  - Frontend `MAX_TOTAL_ATTACHMENT_BYTES`: 500 KB → 20 MB (this counts
    prompt-bytes, so audio / image attachments still cost ~256 B each
    — the 20 MB is a real text/CSV ceiling, not a binary-file guard).
  - Hono picker default `maxContentBytes`: 50 KB → 1 MB; hard cap
    1 MB → 20 MB. Reasonable text files now inline by default; the
    caller can push up to 20 MB explicitly.

  Past this, Claude's own context window is the binding constraint.

## v1.0.4 — 2026-04-26

### Fixed

- **Audio attachments no longer hit the 500 KB attachment cap.** The
  `MAX_TOTAL_ATTACHMENT_BYTES` guardrail used to count on-disk file
  size, which rejected any audio file larger than 500 KB (a 30 s
  mono WAV is ~960 KB) even though only its URL ever lands in the
  prompt. The cap now measures actual prompt-bytes per attachment
  kind (text inlines content, recording counts CSV preview only,
  image/binary count just the path reference). The displayed pill
  size is unchanged — that's the file size, which is what users
  expect to see.

## v1.0.3 — 2026-04-26

### Fixed

- **"Drag both" from the recordings panel now produces two pills.**
  Previously, dragging both CSV + audio looked like only the CSV had
  been attached: a single recording pill with the CSV filename, and
  the audio info silently buried in metadata. Each file now becomes
  its own visible attachment with its own prompt block, and the
  audio attachment carries the served URL as its path so Claude can
  fetch it from a Bash call.

## v1.0.2 — 2026-04-26

### Added

- **Frontend startup splash.** Vite is ready in ~1 s but the Python
  and Hono backends take longer (especially on first run while
  `pip install` and `npm install` finish). The dashboard now covers
  itself with a loading screen that polls `/api/health` and
  `/api/projects` until both come online, with a per-tier status row
  so the user can see exactly which backend they're waiting on. After
  8 s a "Continue anyway" button appears for the case where one tier
  is intentionally off.

## v1.0.1 — 2026-04-26

Bug-fix release covering issues found in the v1.0.0 first-week test
window. No breaking changes; the wire formats and on-disk recording
layout are unchanged. Drop-in upgrade.

### Fixed

- **Recording timer no longer jumps backward.** The 30 s capture would
  display `27 → 28 → 29 → 28 → 30` and could spontaneously reset to the
  initial duration partway through. Heartbeat re-anchoring (which
  fought a constantly-lagging WS feed) has been removed; the local
  clock is now the sole authority once a session starts. Drift fixes
  are applied only when the tab has clearly fallen behind (≥ 2 s),
  never to nudge the anchor backward.
- **Recording auto-stops at the requested duration.** The frontend now
  self-stops when local elapsed reaches duration, even if the backend's
  heartbeat is delayed; the backend's monitor thread also broadcasts
  the stop event immediately rather than waiting up to 1 s for the
  next periodic tick.
- **Recordings now show up in the chat sidebar.** The recording writer
  was using a CWD-relative path that landed files in
  `backend/recordings/` while the listing API read from
  `<project>/recordings/`. Both ends now read the same path from
  `app.config`.
- **`Recording already in progress` after clicking Start.** Stale
  WebSocket frames from before the user's click could clobber a
  freshly-started session. A 3-second post-action quarantine drops
  any heartbeats whose timing predates the local action.
- **Duration input field no longer collapses to "0".** Backspacing
  the number field used to leave a stuck `0` you couldn't clear; the
  input now stores the raw string and only parses on commit.
- **BLE button label correctly reads "Connecting…" through scan + poll.**
  Previously, when the backend WS pushed `ble.connected = true`
  mid-scan, the button briefly switched to "Disconnecting…". The
  label now follows user intent, not connection state.
- **Serial / BLE / Audio buttons no longer disable each other.** The
  three transports now have independent loading flags.
- **Disconnect stops data immediately.** Bridges previously kept
  emitting frames for ~1-2 s while their teardown finished; an
  explicit running-guard inside the read callbacks drops in-flight
  data the moment the user clicks Disconnect.
- **Embedded terminal mascot stops wrapping.** xterm `lineHeight` was
  fighting cell metrics, mis-positioning the Claude Code spinner
  redraw. Set to 1.0.
- **Chat recordings panel no longer greys out chat.** Removed the
  modal backdrop so drag-to-attach actually reaches the textarea.
- **Sensor card shading is consistent.** Channels with negative-only
  data used to fill *above* the line (Recharts default `baseValue=0`).
  Now anchored to the visible chart bottom for a uniform "area
  under the curve" look across all channels.

### Improved

- **Navigation no longer stutters during recording.** The WebSocket
  subscription and 100 ms recording timer were promoted out of
  `<Dashboard/>` into a top-level `<AppBridge/>` component, so route
  changes no longer tear them down. High-rate sensor / audio frames
  are coalesced into one update per `requestAnimationFrame`, freeing
  the main thread for input. Header navigation is wrapped in
  React 18 `startTransition` so route changes can interrupt pending
  re-renders.
- **Chat recordings sidebar lets you attach individual files.** Each
  session card now exposes three drag handles — *drag CSV*,
  *drag audio*, *drag both* — so you can attach just the readings,
  just the audio, or the full bundle.
- **Custom recording duration.** The duration field accepts any
  value from 1 s to 24 h. Five preset chips (30 s / 1 m / 2 m /
  5 m / 10 m) remain available for one-tap selection.

## v1.0.0 — 2026-04-25

Initial public release.
