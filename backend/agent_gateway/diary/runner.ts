/**
 * One-shot agent runner — POSTs the prompt to the Python agent
 * service's blocking oneshot endpoint and returns the body. No SDK,
 * no CLI spawn, no session reuse, no tools.
 *
 * Historically this spawned `claude -p` and parsed stream-json. All AI
 * work now lives in the Python agent service; the runner keeps its
 * public surface (RunResult, AgentError, ConcurrentRunError, RunOptions,
 * redactSecrets) so orchestrator.ts and handlers/diary.ts are unchanged.
 */

import { getAgent } from "./agentStore.ts";
import type { DiaryLang } from "../../shared/types.ts";
import { logger } from "../utils/logger.ts";
import { agentServiceUrl, serviceHeaders } from "../utils/agentService.ts";

export interface RunResult {
  body: string;
  model: string;
  duration_ms: number;
  cost_usd?: number;
  tokens?: { input: number; output: number };
  stderr_excerpt?: string;
}

export class AgentError extends Error {
  constructor(message: string, readonly stderr_excerpt?: string) {
    super(message);
    this.name = "AgentError";
  }
}

export interface RunOptions {
  /** Called once per assistant text chunk for typewriter UIs (Phase 2). */
  onChunk?: (text: string) => void;
  /** Hard ceiling so a hung model can't pin a request forever. */
  timeoutMs?: number;
  /** Optional abort signal so callers can cancel a run. */
  signal?: AbortSignal;
  /**
   * UI language — only consumed by the built-in `diary_observer`
   * fallback to pick its system prompt. User-defined agents bring
   * their own prompt and ignore this. Defaults to 'en'.
   */
  lang?: DiaryLang;
}

// 180s is generous — most providers answer in 5–15s for a one-shot
// diary turn. The longer ceiling is for cold-start scenarios on
// third-party endpoints and for thinking models that may take a while
// before emitting tokens.
const DEFAULT_TIMEOUT_MS = 180_000;

// Module-wide guard. Without this, the user's "Test" button in the
// agent editor and the "Generate now" button on /diary can stack up
// multiple concurrent oneshot calls. Cap at one at a time across both
// paths.
let activeRunCount = 0;
const MAX_CONCURRENT_RUNS = 1;

export class ConcurrentRunError extends Error {
  constructor() {
    super(
      "Another diary run is in progress. Wait for it to finish or click Cancel on /diary.",
    );
    this.name = "ConcurrentRunError";
  }
}

/**
 * Defence-in-depth: strip anything that looks like an API key from
 * error text before logging it or returning it to the frontend.
 * Error payloads ride on the diary error event back to every connected
 * /diary tab — keep auth values from ever reaching a log or the wire.
 */
function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    // sk-... style (Anthropic, OpenAI, DeepSeek, MiniMax, Kimi, ...)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, "sk-•••REDACTED•••")
    // Bearer <token>
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer •••REDACTED•••")
    // x-api-key: <token>
    .replace(/(x-api-key:\s*)[A-Za-z0-9._-]{8,}/gi, "$1•••REDACTED•••")
    // Authorization: ... (catch any other auth header style)
    .replace(/(Authorization:\s*)[^\s,]+/gi, "$1•••REDACTED•••");
}

interface OneshotReply {
  text?: string;
  model?: string;
  provider?: string;
  duration_ms?: number;
}

export async function runAgent(
  agentId: string,
  userPrompt: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  if (activeRunCount >= MAX_CONCURRENT_RUNS) {
    throw new ConcurrentRunError();
  }
  activeRunCount++;
  try {
    return await runAgentImpl(agentId, userPrompt, opts);
  } finally {
    activeRunCount--;
  }
}

async function runAgentImpl(
  agentId: string,
  userPrompt: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  // Resolve the agent so unknown ids still 404 cleanly and the built-in
  // diary_observer picks up its language-specific system prompt.
  const agent = await getAgent(agentId, opts.lang ?? "en");

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    controller.abort();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const url = `${agentServiceUrl()}/api/agent/oneshot`;
  logger.chat.info(
    `[diary] oneshot → ${url} agent=${agentId} promptLen=${userPrompt.length}`,
  );

  const t0 = Date.now();
  let reply: OneshotReply;
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        // X-Service-Key: without it the authz middleware treats this
        // machine call as patient tier and strips systemPrompt — which
        // would silently break every diary agent's persona.
        headers: { "content-type": "application/json", ...serviceHeaders() },
        body: JSON.stringify({
          message: userPrompt,
          systemPrompt: agent.system_prompt,
          agentId,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (aborted) {
        throw new AgentError("Run aborted");
      }
      if (timedOut) {
        throw new AgentError(`Timed out after ${timeoutMs} ms`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentError(
        `Agent service unreachable at ${agentServiceUrl()}: ${redactSecrets(message)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentError(
        `Agent service HTTP ${res.status}${
          text ? `: ${redactSecrets(text.slice(0, 500))}` : ""
        }`,
        text ? redactSecrets(text.slice(-500)) : undefined,
      );
    }

    try {
      reply = (await res.json()) as OneshotReply;
    } catch (err) {
      if (aborted) throw new AgentError("Run aborted");
      if (timedOut) throw new AgentError(`Timed out after ${timeoutMs} ms`);
      throw new AgentError(
        `Agent service returned non-JSON response: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }

  const finalBody = (reply.text ?? "").trim();
  if (!finalBody) {
    throw new AgentError("Empty response from agent service");
  }

  // The oneshot endpoint is blocking (no streaming), so the typewriter
  // callback fires once with the whole body.
  opts.onChunk?.(finalBody);

  return {
    body: finalBody,
    model: reply.model || agent.model,
    duration_ms:
      typeof reply.duration_ms === "number"
        ? reply.duration_ms
        : Date.now() - t0,
    // Cost / token accounting lived in the CLI's result event; the
    // Python oneshot endpoint doesn't report them.
    cost_usd: undefined,
    tokens: undefined,
  };
}

// Exported for use in tests / handlers that build their own error
// payloads from runner-adjacent strings.
export { redactSecrets };
