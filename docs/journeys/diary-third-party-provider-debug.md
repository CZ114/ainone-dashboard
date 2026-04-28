# Diary third-party provider debug — chasing a silent 401

A multi-hour debug journey. Symptom: "I tried MiniMax and it always
times out. The API works in curl." Solution: claude CLI was retrying
401s ten times with exponential backoff and our runner was silently
dropping the events.

This entry exists so the next person who plumbs an Anthropic-compat
provider into the diary doesn't burn the same hours. Read it
linearly — each hypothesis is wrong until the last one.

## Setup

- User: ESP32 sensor dashboard with diary feature on `dev` branch
- Diary runner: spawns `claude -p` against any Anthropic-protocol
  endpoint, parses the stream-json output
- Provider under test: **MiniMax** (`api.minimax.io/anthropic` for
  international, `api.minimaxi.com/anthropic` for China)
- User's environment also had `~/.claude/settings.json` configured
  with an Anthropic-native `ANTHROPIC_API_KEY` for their normal chat use

## Symptom

User clicks "Generate now" on `/diary` after creating a MiniMax
agent. The button stays in `Generating…` state for ~3 minutes, then
the request fails. No useful error message. The runner reported
"Timed out after 90000 ms" once we got that far. User repeated the
click ~11 times in frustration; each spawn ran in parallel.

## Hypothesis 1 — auth conflict between settings.json and agent env

**Reasoning**: user has `ANTHROPIC_API_KEY=sk-ant-...` in their
`settings.json` (for direct Claude). When we spawn the runner for
MiniMax, the merged env contains:

```
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic   ← from agent
ANTHROPIC_API_KEY=sk-ant-...                          ← inherited
ANTHROPIC_AUTH_TOKEN=<minimax-key>                    ← from agent
```

claude CLI sees both auth credentials and gets confused, so the
request hangs.

**Fix**: when the agent declares its own `ANTHROPIC_BASE_URL`, strip
ALL `ANTHROPIC_*` from `process.env` and `userEnv` before merging.

**Result**: did not fix the hang. The strip is still in place — it's
a real bug worth fixing — but it wasn't the root cause.

## Hypothesis 2 — claude CLI's OAuth/keychain dance hangs on third-party endpoints

**Reasoning**: claude CLI's default mode does keychain reads, OAuth
refresh, hook discovery, CLAUDE.md auto-discovery. Maybe one of those
calls goes to `api.anthropic.com` and hangs because the user is on a
network where that endpoint is slow/blocked.

**Evidence**: spawned `claude --bare -p ...` (which the help text
says skips all that) with a fake key. Got a clean
`{"type":"result","is_error":true,"result":"Not logged in · Please
run /login"}` in **199 milliseconds**. The "hang" was somehow related
to this preamble.

**Fix**: add `--bare` to the runner args when the agent uses a
custom provider. Also normalise `ANTHROPIC_API_KEY = ANTHROPIC_AUTH_TOKEN`
since `--bare` strictly reads the former.

**Result**: 199ms result was misleading. With a real (correct) key
+ `--bare`, the run still hung. Confirmed by user: still timing out.

## Hypothesis 3 — `--bare` forces the wrong auth header

**Reasoning**: `--bare` reads only `ANTHROPIC_API_KEY` and uses the
Anthropic-native `x-api-key: <key>` header. MiniMax's compat layer
might require `Authorization: Bearer <key>` (the
`ANTHROPIC_AUTH_TOKEN` style).

**Evidence**: testing claude with `--bare -d api` (debug mode for
api requests) against MiniMax with a fake key revealed THIS in the
stream-json output:

```json
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":612,"error_status":401,"error":"authentication_failed"}
{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1081,"error_status":401,"error":"authentication_failed"}
{"type":"system","subtype":"api_retry","attempt":3,"max_retries":10,"retry_delay_ms":2329,...}
{"type":"system","subtype":"api_retry","attempt":4,"max_retries":10,"retry_delay_ms":4278,...}
{"type":"system","subtype":"api_retry","attempt":5,"max_retries":10,"retry_delay_ms":9291,...}
{"type":"system","subtype":"api_retry","attempt":6,"max_retries":10,"retry_delay_ms":19582,...}
```

**That was the smoking gun.** MiniMax was returning 401 immediately,
and claude CLI's bundled SDK was **retrying ten times with
exponential backoff** (612ms → 1.1s → 2.3s → 4.3s → 9.3s → 19.6s →
39.2s → 78.4s → ~157s → ~314s = **5+ minutes total** before giving
up). Our runner's 180s timeout fired around attempt 7-8, killed the
process, and reported "Timed out" — masking the 401.

Our runner only parsed `assistant` and `result` events. **We were
silently dropping every `api_retry` event** so the user saw nothing.

## Root cause

Two bugs compounded:

1. **CLI behaviour we didn't know about**: 10 retries on auth
   failure. The `ANTHROPIC_MAX_RETRIES` env var documented in the
   SDK type defs is **NOT honoured** by the bundled CLI binary.
2. **Runner ignores `api_retry`**: the events were on stdout the
   whole time, just unparsed.

The "MiniMax key didn't work" was likely a header-style mismatch (or
a real bad key) — but we couldn't see the 401 because the runner
swallowed the events.

## Fix (final)

In `backend/claude/diary/runner.ts`:

1. **Parse `api_retry` events** — log to backend, surface in error.
2. **Kill the process after 2 consecutive 401s** — auth doesn't get
   less wrong by waiting. Surface a clear "Authentication failed
   (401) on the provider endpoint. Re-check your API key…" instead
   of a generic timeout.
3. **Drop `--bare`** — empirically not needed once we cap retries.
   Without `--bare`, claude picks `ANTHROPIC_AUTH_TOKEN` for auth and
   sends `Authorization: Bearer <key>` headers, which MiniMax accepts.
4. **Keep env isolation from Hypothesis 1** — even though it wasn't
   the root cause, having two competing auth env vars in the spawned
   process is a real bug.
5. **Set both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`** to
   the same value when `usesCustomProvider`. The CLI's auth resolver
   picks AUTH_TOKEN (Bearer headers, what MiniMax wants) and
   API_KEY is harmless.

After this, MiniMax fails fast (5s) on bad auth or returns a real
entry on good auth.

## Side bugs found during the hunt

The 11 zombie clicks exposed several smaller bugs the user hit on
top of the main one. Worth listing because each was a real issue:

### B1 — `ERR_UNHANDLED_ERROR` crashing the whole backend

Node's `EventEmitter.emit('error', ...)` throws if no `error` listener
is attached. Our `diaryBus` emits failures as `{ type: 'error' }`,
which goes through `bus.emit('error', payload)`. When no /diary
stream client was connected, this killed the entire Hono process
mid-request. Every subsequent request 500'd until the user noticed
and restarted the dev server.

**Fix**: park a no-op `bus.on('error', () => {})` at module init.
Three lines, file `backend/claude/diary/eventBus.ts`.

### B2 — Concurrent test+generate spawned multiple processes

`Generate now` (handleTrigger) had a single-flight guard but the
`Test agent` button (handleTestAgent) didn't. Three rapid clicks =
three live `claude` processes against MiniMax, each retrying 10×.

**Fix**: module-level `activeRunCount` in `runner.ts` (covers BOTH
spawn paths). Throws `ConcurrentRunError` on the second attempt.

### B3 — Unresolved `${SECRET}` getting sent as the API key

When the user creates an agent in simple mode but their first paste
of the API key fails to save (stale secret state), the agent ends up
with `env.ANTHROPIC_AUTH_TOKEN = "${MINIMAX_KEY}"` and no
`MINIMAX_KEY` secret. `resolveSecrets` returns the literal string,
the CLI receives `Authorization: Bearer ${MINIMAX_KEY}`, and the
provider 401s. The user sees "auth failed" and assumes their key is
wrong, when actually our resolution silently failed.

**Fix**: runner pre-flight scan — if any env value matches
`/^\$\{[A-Z0-9_]+\}$/`, refuse to spawn and throw "Env var X
references secret ${Y} but no such secret is saved. Re-paste your
API key…"

### B4 — Built-in Haiku not in the picker dropdown

The `Generate now` agent picker only listed user-defined agents. Once
the user created a custom agent, the built-in `diary_observer` (the
known-working Anthropic Haiku fallback) was no longer reachable from
the UI — they had to delete all custom agents to get it back.

**Fix**: `agentStore.listAgents` always prepends the built-in
fallback unless the user has explicitly overridden the
`diary_observer` slot.

### B5 — Can't delete an agent that's wired into the schedule

User set MiniMax as their daily cron agent, then tried to delete the
agent. `handleDeleteAgent` returned 409 because of the schedule
reference. No way to clear without manual JSON editing.

**Fix**: `DELETE /api/diary/agents/:id?force=1` — clears
daily/weekly/event references AND disables the master cron switch
before deleting. Frontend offers this via a second confirm dialog
when it sees the 409.

### B6 — User confused which agent will fire

`Generate now` button just said "Generate now" with no indication of
which agent it'd hit. Easy to misread the dropdown selection.

**Partially mitigated**: dropdown shows `name · model` so the user
can see at a glance. Could go further (show the agent name on the
button itself) but that hasn't been needed yet.

## Lessons

1. **When a CLI spawn hangs, log every event type, not just the ones
   you currently use.** `api_retry` was the answer the whole time.
2. **`ANTHROPIC_MAX_RETRIES` is documented but unimplemented** in the
   bundled CLI binary as of `claude_code_version: 2.1.121`.
   Verify-don't-trust env vars in third-party tools.
3. **Single-flight guards must cover every spawn path**, not just
   the obvious one. A test button is also a spawn.
4. **A secret-resolution placeholder leaking into an HTTP header is
   indistinguishable from a wrong key** at the provider end. Refuse
   to spawn instead of best-effort substituting.
5. **Event-emitter `'error'` semantics are dangerous**. A single
   unhandled error event takes down the process. Always park a no-op
   listener even if you "always" have a real one elsewhere.

## Verification

User confirmed working state Apr 2026 with both Anthropic native
(via built-in Haiku) and MiniMax-M2.7-Highspeed. Round-trip ~7s for
Haiku, ~12s for MiniMax. Fast-fail on bad auth ~5s.

## Touched files

- `backend/claude/diary/runner.ts` — env isolation, retry cap,
  api_retry parsing, concurrent guard
- `backend/claude/diary/eventBus.ts` — no-op error listener
- `backend/claude/diary/agentStore.ts` — always-include built-in
- `backend/claude/handlers/diary.ts` — force-delete + concurrent guard
- `frontend/src/components/diary/AgentEditor.tsx` — provider/model
  picker UX
- `frontend/src/components/diary/DiaryPage.tsx` — agent picker on
  Generate now + Cancel button
- `frontend/src/components/diary/providers.ts` — provider registry
- `frontend/src/store/diaryStore.ts` — abort + delete + force-delete
- `frontend/src/api/diaryApi.ts` — abort + force query param
