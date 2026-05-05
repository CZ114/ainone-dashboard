/**
 * Diary HTTP handlers — full Phase 2 surface.
 *
 * Routes wired in app.ts:
 *   GET    /api/diary/entries
 *   GET    /api/diary/entries/:id
 *   POST   /api/diary/entries/:id/read
 *   POST   /api/diary/entries/:id/reply
 *   POST   /api/diary/trigger
 *   GET    /api/diary/stream         (NDJSON)
 *   GET    /api/diary/config
 *   PATCH  /api/diary/config
 *   GET    /api/diary/agents
 *   POST   /api/diary/agents/:id
 *   DELETE /api/diary/agents/:id
 *   POST   /api/diary/agents/:id/test
 *   GET    /api/diary/secrets
 *   PUT    /api/diary/secrets/:name
 *   DELETE /api/diary/secrets/:name
 */

import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.ts";
import {
  appendEntry,
  deleteEntry,
  ensureDiaryRepliesDir,
  getEntry,
  patchConfig,
  readConfig,
  readEntries,
  updateEntry,
  writeConfig,
} from "../diary/store.ts";
import { runAndPersist } from "../diary/orchestrator.ts";
import { runAgent, AgentError } from "../diary/runner.ts";
import { getMainProviderInfo } from "../diary/mainProvider.ts";
import {
  DEFAULT_AGENT_ID,
  deleteAgent as agentDelete,
  deleteSecret as secretDelete,
  findSecretReferences,
  getAgent,
  listAgents,
  listSecretNames,
  setSecret,
  upsertAgent,
} from "../diary/agentStore.ts";
import { diaryBus } from "../diary/eventBus.ts";
import type {
  AgentConfig,
  DiaryConfig,
} from "../../shared/types.ts";

// Use unused import to silence TS — appendEntry is exported for tests.
void appendEntry;

interface TriggerBody {
  agent_id?: string;
}

// One in-flight manual trigger at a time. Prevents the user from
// rapid-clicking "Generate now" and ending up with N zombie claude
// processes when the endpoint hangs.
let manualTriggerRequestId: string | null = null;
let manualTriggerAbort: AbortController | null = null;

// Hono types route params as `string | undefined`; under strict TS we
// either narrow at every call site or use this helper. Routes are
// declared with `:id` in app.ts so the value is always present at
// runtime — a missing param means our route table is broken, which
// should be a 500.
function requireParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing route param: ${name}`);
  }
  return value;
}

// ---------- Entries ----------------------------------------------------------

export async function handleListEntries(c: Context) {
  const file = await readEntries();
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  return c.json({
    entries: file.entries.slice(0, limit),
    total: file.entries.length,
    unread: file.entries.filter((e) => !e.read).length,
  });
}

export async function handleGetEntry(c: Context) {
  const id = requireParam(c, "id");
  const entry = await getEntry(id);
  if (!entry) return c.json({ error: "Entry not found" }, 404);
  return c.json({ entry });
}

export async function handleMarkRead(c: Context) {
  const id = requireParam(c, "id");
  const entry = await updateEntry(id, { read: true });
  if (!entry) return c.json({ error: "Entry not found" }, 404);
  diaryBus.emit({ type: "read", entry_id: id });
  return c.json({ entry });
}

export async function handleDeleteEntry(c: Context) {
  const id = requireParam(c, "id");
  // Require the entry be marked read first. Prevents silently dropping
  // a fresh cron entry the user hasn't seen yet.
  const existing = await getEntry(id);
  if (!existing) return c.json({ error: "Entry not found" }, 404);
  if (!existing.read) {
    return c.json(
      { error: "Mark the entry as read before deleting." },
      409,
    );
  }
  const removed = await deleteEntry(id);
  if (!removed) return c.json({ error: "Entry not found" }, 404);
  diaryBus.emit({ type: "deleted", entry_id: id });
  return c.json({ ok: true, id });
}

// ---------- Trigger + stream -------------------------------------------------

export async function handleTrigger(
  c: Context,
  requestAbortControllers: Map<string, AbortController>,
) {
  // Single-flight guard. If another manual trigger is already running,
  // refuse — without this the user can rapid-click and stack up N
  // zombie claude processes.
  if (manualTriggerRequestId) {
    return c.json(
      {
        error:
          "Another manual trigger is already running. " +
          "Click 'Cancel' or wait for it to finish.",
        in_flight_request_id: manualTriggerRequestId,
      },
      409,
    );
  }

  let body: TriggerBody = {};
  try {
    body = (await c.req.json()) as TriggerBody;
  } catch {
    /* empty body is fine */
  }
  const agentId = body.agent_id ?? DEFAULT_AGENT_ID;
  const requestId = `diary-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const abortController = new AbortController();
  requestAbortControllers.set(requestId, abortController);
  manualTriggerRequestId = requestId;
  manualTriggerAbort = abortController;

  try {
    const res = await runAndPersist({
      trigger: "manual",
      agentId,
      requestId,
      signal: abortController.signal,
    });
    if (!res.ok) {
      return c.json(
        { error: res.error, stderr_excerpt: res.stderr_excerpt },
        500,
      );
    }
    return c.json({ entry: res.entry });
  } finally {
    requestAbortControllers.delete(requestId);
    if (manualTriggerRequestId === requestId) {
      manualTriggerRequestId = null;
      manualTriggerAbort = null;
    }
  }
}

/**
 * Abort the currently-running manual trigger. Used by the /diary UI
 * when the user clicks "Cancel" while stuck on Generating. Idempotent.
 */
export function handleAbort(c: Context) {
  if (!manualTriggerRequestId || !manualTriggerAbort) {
    return c.json({ ok: true, was_running: false });
  }
  const requestId = manualTriggerRequestId;
  manualTriggerAbort.abort();
  manualTriggerRequestId = null;
  manualTriggerAbort = null;
  logger.chat.info(`[diary] manual trigger aborted by user: ${requestId}`);
  return c.json({ ok: true, was_running: true, request_id: requestId });
}

/**
 * NDJSON stream of bus events. Mirrors handlers/chat.ts pattern:
 *   - application/x-ndjson
 *   - one JSON object per line
 *   - controller closes when the client disconnects
 */
export function handleStream(c: Context) {
  // Snapshot lastEventId for replay support — not implemented yet, but we
  // expose the header so future Phase 3 work can resume across reconnects.
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const safeEnqueue = (line: string) => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(line));
        } catch {
          closed = true;
        }
      };

      const unsubscribe = diaryBus.subscribe((event) => {
        safeEnqueue(JSON.stringify(event) + "\n");
      });

      // Initial hello — useful so the client knows the connection is up
      // before any actual event fires.
      safeEnqueue(JSON.stringify({ type: "hello", t: Date.now() }) + "\n");

      // Heartbeat every 25s — keeps proxies from killing idle connections.
      const heartbeat = setInterval(() => {
        safeEnqueue(JSON.stringify({ type: "heartbeat", t: Date.now() }) + "\n");
      }, 25_000);
      heartbeat.unref?.();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Hono surfaces client aborts via the request signal.
      const signal = c.req.raw.signal;
      if (signal) {
        if (signal.aborted) {
          cleanup();
        } else {
          signal.addEventListener("abort", cleanup, { once: true });
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------- Reply ------------------------------------------------------------

interface ReplyResponse {
  /** Real persistent cwd that chat sessions group under in the sidebar. */
  cwd: string;
  /** Echoed for the frontend to fetch + render the pinned context card. */
  entry_id: string;
  /**
   * DEAD CODE — see docs/specs/diary.md "Dead code / debt".
   *
   * Originally consumed by ChatPage on first-send to set
   * `ChatRequest.additionalSystemPrompt`. Frontend now inlines the
   * entry body into the user message instead, so this string is
   * built but ignored. Removing requires touching all 7 files in the
   * "Files marked" table.
   */
  additional_system_prompt: string;
}

export async function handleReply(c: Context) {
  const id = requireParam(c, "id");
  const entry = await getEntry(id);
  if (!entry) return c.json({ error: "Entry not found" }, 404);

  // Make sure <repo>/diary-replies/ exists so the chat handler's cwd
  // sanity check (statSync) passes when the user sends their first
  // follow-up message.
  const cwd = ensureDiaryRepliesDir();

  // DEAD CODE — see docs/specs/diary.md "Dead code / debt".
  // System-prompt context. Built and returned for wire compatibility
  // but no longer consumed by the frontend.
  const additionalSystemPrompt = [
    `The user is following up on a diary observation you wrote earlier.`,
    `That observation was written at ${entry.created_at}.`,
    ``,
    `--- BEGIN DIARY ENTRY ---`,
    entry.body,
    `--- END DIARY ENTRY ---`,
    ``,
    `Treat this as background context. Do not re-summarise it unless asked.`,
    `Answer the user's follow-up questions concisely and ground your`,
    `responses in the entry above when relevant.`,
  ].join("\n");

  // Note: we do NOT pre-allocate a session id. The first /api/chat call
  // generates a temp `new-session-*` id, and the SDK assigns the real
  // session_id on its first system/init message. We backfill
  // entry.reply_session_id via a separate /api/diary/entries/:id/link
  // call from the frontend once it knows the real id (Phase 3).
  return c.json({
    cwd,
    entry_id: id,
    additional_system_prompt: additionalSystemPrompt,
  } satisfies ReplyResponse);
}

// ---------- Main provider (read-only diagnostic) -----------------------------

export async function handleGetMainProvider(c: Context) {
  const info = await getMainProviderInfo();
  return c.json(info);
}

// ---------- Config -----------------------------------------------------------

export async function handleGetConfig(c: Context) {
  const config = await readConfig();
  return c.json({ config });
}

export async function handlePatchConfig(c: Context) {
  let body: Partial<DiaryConfig>;
  try {
    body = (await c.req.json()) as Partial<DiaryConfig>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // Reject obviously malformed schedule blocks early so the scheduler
  // doesn't crash on a tick.
  if (body.schedule?.daily) {
    const t = body.schedule.daily.time;
    if (typeof t !== "string" || !/^\d{2}:\d{2}$/.test(t)) {
      return c.json({ error: "schedule.daily.time must be HH:MM" }, 400);
    }
  }
  const config = await patchConfig(body);
  return c.json({ config });
}

// ---------- Agents -----------------------------------------------------------

function maskAgent(agent: AgentConfig): AgentConfig {
  // Env values may include literal API keys (rare, but supported when the
  // user opts out of the secret-ref pattern). Mask values that look like
  // long opaque tokens; leave plain config like BASE_URL alone.
  const maskedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(agent.env)) {
    if (/\$\{[A-Z0-9_]+\}/i.test(v)) {
      maskedEnv[k] = v; // ${REF} is fine to show
    } else if (/^sk-|^Bearer |\b[A-Za-z0-9]{32,}\b/.test(v)) {
      maskedEnv[k] = v.slice(0, 4) + "•".repeat(Math.max(4, v.length - 8)) + v.slice(-4);
    } else {
      maskedEnv[k] = v;
    }
  }
  return { ...agent, env: maskedEnv };
}

export async function handleListAgents(c: Context) {
  const agents = await listAgents();
  const refs = await findSecretReferences();
  return c.json({
    agents: agents.map(({ id, agent }) => ({
      id,
      agent: maskAgent(agent),
    })),
    secret_references: refs,
  });
}

export async function handleUpsertAgent(c: Context) {
  const id = requireParam(c, "id");
  if (!/^[a-z0-9_-]+$/i.test(id)) {
    return c.json({ error: "agent id must be alphanumeric / underscore / dash" }, 400);
  }
  let body: AgentConfig;
  try {
    body = (await c.req.json()) as AgentConfig;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.name || !body.model || typeof body.system_prompt !== "string") {
    return c.json(
      { error: "agent must include name, model, system_prompt" },
      400,
    );
  }

  // Provider-family lock. The diary feature deliberately restricts new
  // agents to the SAME Anthropic-protocol provider as the user's main
  // chat (read from ~/.claude/settings.json). Without this, a user
  // could save an agent with a per-agent ANTHROPIC_BASE_URL that
  // conflicts with the API key already inherited from their settings,
  // which we've seen produce silent auth-mixing hangs.
  //
  // Comparison is on the literal string after trailing-slash trim;
  // null/empty on either side means "Anthropic native".
  function normaliseUrl(u: string | undefined | null): string | null {
    if (!u) return null;
    const t = u.trim();
    if (!t) return null;
    return t.endsWith("/") ? t.slice(0, -1) : t;
  }
  const main = await getMainProviderInfo();
  const agentBaseUrl = normaliseUrl(body.env?.ANTHROPIC_BASE_URL);
  if (agentBaseUrl !== (main.base_url ?? null)) {
    return c.json(
      {
        error:
          `Provider mismatch: this agent's ANTHROPIC_BASE_URL (${
            agentBaseUrl ?? "Anthropic native"
          }) does not match your main chat's provider (${
            main.base_url ?? "Anthropic native"
          }). Diary agents are locked to your main chat's provider family. ` +
          `Change ~/.claude/settings.json's ANTHROPIC_BASE_URL first if you want to switch the diary's provider too.`,
        main_provider_base_url: main.base_url,
        agent_provider_base_url: agentBaseUrl,
      },
      409,
    );
  }

  await upsertAgent(id, {
    name: body.name,
    description: body.description,
    model: body.model,
    env: body.env ?? {},
    system_prompt: body.system_prompt,
    sampling: body.sampling,
  });
  return c.json({ ok: true });
}

export async function handleDeleteAgent(c: Context) {
  const id = requireParam(c, "id");
  const force = c.req.query("force") === "1";
  const cfg = await readConfig();
  const usedByDaily = cfg.schedule.daily?.agent_id === id;
  const usedByWeekly = cfg.schedule.weekly?.agent_id === id;
  const usedByEvent = cfg.triggers.on_recording_complete.agent_id === id;
  const inUse = usedByDaily || usedByWeekly || usedByEvent;
  if (inUse && !force) {
    return c.json(
      {
        error:
          "Agent is referenced by current schedule/triggers. " +
          "Repeat with ?force=1 to clear those references and delete.",
        in_use: {
          daily: usedByDaily,
          weekly: usedByWeekly,
          on_recording_complete: usedByEvent,
        },
      },
      409,
    );
  }
  // Force mode: clear references before delete so the JSON file
  // doesn't keep dangling pointers.
  if (force && inUse) {
    const next: typeof cfg = JSON.parse(JSON.stringify(cfg));
    if (usedByDaily) delete next.schedule.daily;
    if (usedByWeekly) delete next.schedule.weekly;
    if (usedByEvent) delete next.triggers.on_recording_complete.agent_id;
    // Disabling the master switch when the daily agent goes away
    // matches user intent: don't keep the cron firing into nothing.
    if (usedByDaily) next.enabled = false;
    await patchConfig(next);
  }
  const ok = await agentDelete(id);
  if (!ok) return c.json({ error: "Agent not found" }, 404);
  return c.json({ ok: true, force_applied: force && inUse });
}

const TEST_TIMEOUT_MS = 30_000;

export async function handleTestAgent(c: Context) {
  const id = requireParam(c, "id");
  const t0 = Date.now();
  try {
    // Force a one-token reply so we charge as little as possible.
    const agent = await getAgent(id);
    void agent; // touch agent so we 404 cleanly before spawning
    const run = await runAgent(id, "Reply with the single word: pong", {
      timeoutMs: TEST_TIMEOUT_MS,
    });
    return c.json({
      ok: true,
      latency_ms: Date.now() - t0,
      sample: run.body.slice(0, 80),
      cost_usd: run.cost_usd,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = err instanceof AgentError ? err.stderr_excerpt : undefined;
    return c.json(
      {
        ok: false,
        latency_ms: Date.now() - t0,
        error: friendlyClaudeError(message, stderr),
      },
      200, // ok:false is the signal; 200 keeps the UI flow simple
    );
  }
}

function friendlyClaudeError(message: string, stderr?: string): string {
  const blob = `${message}\n${stderr ?? ""}`;
  if (/\b401\b|unauthor|invalid api key|invalid_api_key/i.test(blob)) {
    return "Authentication failed (401). Check your API key / base URL.";
  }
  if (/\b404\b|model.*not.*found|invalid model/i.test(blob)) {
    return "Model not found (404). Check the model name.";
  }
  if (/ECONNREFUSED|connect.*refused/i.test(blob)) {
    return "Connection refused. Is your router (claude-code-router / LiteLLM) running on the configured BASE_URL?";
  }
  if (/ENOTFOUND|getaddrinfo/i.test(blob)) {
    return "DNS resolution failed for the base URL.";
  }
  if (/timed out/i.test(message)) {
    return message;
  }
  return message.slice(0, 200);
}

// ---------- Secrets ----------------------------------------------------------

export async function handleListSecrets(c: Context) {
  const names = await listSecretNames();
  const refs = await findSecretReferences();
  return c.json({
    secrets: names.map((name) => ({
      name,
      referenced_by: refs[name] ?? [],
    })),
  });
}

export async function handlePutSecret(c: Context) {
  const name = requireParam(c, "name");
  if (!/^[A-Z0-9_]+$/.test(name)) {
    return c.json(
      { error: "Secret name must be UPPER_SNAKE_CASE alphanumerics" },
      400,
    );
  }
  let body: { value?: string };
  try {
    body = (await c.req.json()) as { value?: string };
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.value !== "string" || body.value.length === 0) {
    return c.json({ error: "value must be a non-empty string" }, 400);
  }
  await setSecret(name, body.value);
  return c.json({ ok: true });
}

export async function handleDeleteSecret(c: Context) {
  const name = requireParam(c, "name");
  const refs = await findSecretReferences();
  if (refs[name] && refs[name].length > 0) {
    return c.json(
      {
        error: `Secret is still referenced by agents: ${refs[name].join(", ")}`,
      },
      409,
    );
  }
  const ok = await secretDelete(name);
  if (!ok) return c.json({ error: "Secret not found" }, 404);
  return c.json({ ok: true });
}

// First-launch helper: ensure config file exists so the GET endpoint
// returns the canonical default rather than 404 the very first time.
export async function ensureConfigOnBoot(): Promise<void> {
  const cfg = await readConfig();
  // readConfig already writes the default on miss; touching it once on
  // boot just makes sure the file is on disk.
  if (!cfg) {
    await writeConfig({
      enabled: false,
      schedule: {},
      triggers: { on_recording_complete: { enabled: false } },
      notification: { browser: false },
      daily_quota: 3,
    });
  }
  void logger;
}
