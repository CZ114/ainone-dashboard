/**
 * One-shot agent runner — spawns `claude -p`, parses stream-json, returns
 * the body. No SDK, no session reuse, no tools.
 *
 * The chat path (handlers/chat.ts) deliberately uses the agent SDK because
 * it needs interactive sessions, tool permissions, and abort plumbing.
 * Diary is the opposite: one prompt in, one markdown blob out, throw the
 * session away. Raw spawn is shorter and decouples diary from chat's
 * state machine.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

// Concrete shape for `spawn` with stdio: ["ignore", "pipe", "pipe"].
// Declared at the top so the helper signature stays readable.
type DiaryChild = ChildProcessByStdio<null, Readable, Readable>;
import {
  resolveClaudeBinary,
  getUserEnvFromSettings,
} from "../handlers/chat.ts";
import {
  getAgent,
  getSecrets,
  resolveSecrets,
} from "./agentStore.ts";
import { logger } from "../utils/logger.ts";

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
  /** Hard ceiling so a hung model can't pin a process forever. */
  timeoutMs?: number;
  /** Optional abort signal so callers can cancel a run. */
  signal?: AbortSignal;
}

// 180s is generous — most providers (Anthropic / DeepSeek / MiniMax)
// answer in 5–15s for a one-shot diary turn. The longer ceiling is
// for cold-start scenarios on third-party endpoints and for thinking
// models that may take a while before emitting tokens.
const DEFAULT_TIMEOUT_MS = 180_000;

// Module-wide guard. Without this, the user's "Test" button in the
// agent editor and the "Generate now" button on /diary spawn through
// different code paths and can stack up multiple zombie claude
// processes. Cap at one at a time across both paths.
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
 * Read newline-delimited JSON from a child stream. We tolerate unknown
 * `type` values so a future Claude release adding new event kinds doesn't
 * break parsing.
 */
/**
 * Defence-in-depth: strip anything that looks like an API key from
 * captured CLI output before logging it or returning it to the
 * frontend. Empirically the bundled claude CLI doesn't print
 * Authorization headers to stderr today, but the runner has no
 * control over future CLI versions, and `stderr_excerpt` rides on
 * the diary error event back to every connected /diary tab. Belt
 * and suspenders — keep the auth values from ever reaching a log
 * or the wire.
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

async function* readJsonLines(
  child: DiaryChild,
): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      logger.chat.warn(
        "[diary] dropped non-JSON stdout line: " + trimmed.slice(0, 200),
      );
    }
  }
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
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
  const agent = await getAgent(agentId);
  const secrets = await getSecrets();
  const userEnv = await getUserEnvFromSettings();
  const agentEnv = resolveSecrets(agent.env, secrets);

  // Provider isolation. When this agent declares its own
  // ANTHROPIC_BASE_URL it's pointing claude CLI at a non-Anthropic
  // endpoint (DeepSeek / MiniMax / Zhipu / etc.). In that case, ANY
  // inherited ANTHROPIC_* — from process.env or settings.json — is at
  // best irrelevant and at worst actively breaks auth (e.g. a
  // sk-ant-... API key from the user's normal claude setup leaks in
  // alongside the agent's third-party auth token, claude CLI sends
  // confused headers, the request hangs, runner kills it at the
  // timeout). So we strip every ANTHROPIC_ var from the inherited env
  // and let the agent's env be the sole source of truth.
  const usesCustomProvider = !!agentEnv.ANTHROPIC_BASE_URL;
  const filterAnthropic = (src: Record<string, unknown>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) {
      if (typeof v !== "string") continue;
      if (usesCustomProvider && k.startsWith("ANTHROPIC_")) continue;
      out[k] = v;
    }
    return out;
  };

  // Precedence: agent's explicit env > user's settings.json env > process.env.
  // Empty agent env on an Anthropic-native agent -> we still inherit
  // settings.json so a default-config user gets a working model out
  // of the box.
  const env: Record<string, string> = {
    ...filterAnthropic(process.env as Record<string, unknown>),
    ...filterAnthropic(userEnv),
    ...agentEnv,
  };

  // Auth normalization for --bare. The CLI's bare mode reads
  // STRICTLY `ANTHROPIC_API_KEY` (no OAuth, no keychain, no
  // ANTHROPIC_AUTH_TOKEN fallback). Most third-party Anthropic-compat
  // endpoints (DeepSeek, MiniMax, Z.ai, Moonshot, Qwen) accept either
  // `Authorization: Bearer <key>` or `x-api-key`, so setting both
  // env vars to the same value works on both ends.
  if (usesCustomProvider) {
    const authValue =
      env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
    if (authValue) {
      env.ANTHROPIC_API_KEY = authValue;
      env.ANTHROPIC_AUTH_TOKEN = authValue;
    }
    // (ANTHROPIC_MAX_RETRIES env is documented in the SDK but the
    // bundled CLI binary does NOT honour it — we observed attempt=1/10
    // with the env set. We rely on api_retry-watching below to kill
    // the process after a small number of 401s instead.)
    env.ANTHROPIC_MAX_RETRIES = "2";
    logger.chat.info(
      `[diary] agent ${agentId} uses custom ANTHROPIC_BASE_URL=${agentEnv.ANTHROPIC_BASE_URL}; stripped inherited ANTHROPIC_* env; normalised API_KEY=AUTH_TOKEN`,
    );
  }

  // Refuse to spawn if any env value still contains a literal
  // ${SECRET_NAME} placeholder — resolveSecrets returns the literal
  // when the secret is missing, and shipping that as an HTTP header
  // produces a confusing 401 from the provider. Surface the real
  // problem instead.
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && /^\$\{[A-Z0-9_]+\}$/i.test(v)) {
      const missingSecretName = v.slice(2, -1);
      throw new AgentError(
        `Env var ${k} references secret \${${missingSecretName}} but no such secret is saved. ` +
          `Three ways to fix: ` +
          `(1) re-paste the API key in the agent editor, ` +
          `(2) add it under Settings → Diary → Secrets, or ` +
          `(3) put \`${missingSecretName}=your_key\` in <repo>/.env and restart the backend.`,
      );
    }
  }

  // Spawn diagnostics — what env keys are reaching the CLI? We log
  // KEYS ONLY (no values) so API keys aren't accidentally leaked into
  // logs. If the user sees ANTHROPIC_API_KEY listed when they expected
  // only ANTHROPIC_AUTH_TOKEN, something's wrong with the env merge.
  const anthropicKeys = Object.keys(env).filter((k) =>
    k.startsWith("ANTHROPIC_"),
  );
  logger.chat.info(
    `[diary] spawn diag: model=${agent.model} ` +
      `anthropic_env=[${anthropicKeys.join(", ")}] ` +
      `auth_resolved=${
        agentEnv.ANTHROPIC_AUTH_TOKEN
          ? "ANTHROPIC_AUTH_TOKEN(" +
            (agentEnv.ANTHROPIC_AUTH_TOKEN.length > 0 &&
            !agentEnv.ANTHROPIC_AUTH_TOKEN.startsWith("${")
              ? "filled"
              : "UNRESOLVED")
            + ")"
          : agentEnv.ANTHROPIC_API_KEY
            ? "ANTHROPIC_API_KEY(" +
              (agentEnv.ANTHROPIC_API_KEY.length > 0 &&
              !agentEnv.ANTHROPIC_API_KEY.startsWith("${")
                ? "filled"
                : "UNRESOLVED")
              + ")"
            : "NONE"
      }`,
  );

  const claudeBin = resolveClaudeBinary();

  const args: string[] = [
    "-p",
    userPrompt,
    "--output-format",
    "stream-json",
    // stream-json output requires --verbose per the CLI's own validation.
    "--verbose",
    "--model",
    agent.model,
    "--append-system-prompt",
    agent.system_prompt,
    // Diary runs are one-shot batches — no tools needed, no permission
    // prompts can fire, and the run can never escalate into a multi-turn
    // tool conversation.
    "--tools",
    "",
    // Don't pollute the user's chat history / resume list with diary runs.
    "--no-session-persistence",
  ];

  // For non-Anthropic endpoints add `-d api` so the CLI prints each
  // outbound HTTP request to stderr; diary's live stderr passthrough
  // surfaces it in the backend log immediately.
  //
  // NOTE on --bare: tried it, removed it. --bare strictly uses
  // ANTHROPIC_API_KEY which sends `x-api-key: <key>` headers — but
  // most third-party Anthropic-compat endpoints (MiniMax confirmed)
  // only accept `Authorization: Bearer <key>` (which the CLI uses
  // when ANTHROPIC_AUTH_TOKEN wins auth resolution). The earlier
  // "hang" everyone thought was an OAuth dance was actually claude's
  // default 10-attempt exponential-backoff retry on 401. With
  // ANTHROPIC_MAX_RETRIES=2 (set above) the CLI fails in ~5s and
  // surfaces the real api_retry event, so we no longer need --bare.
  if (usesCustomProvider) {
    args.push("-d", "api");
  }

  const t0 = Date.now();
  const child = spawn(claudeBin, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // shell:false is the default for spawn-with-array-args; explicit for clarity.
    shell: false,
  });

  // stderr handling: keep a rolling buffer (for surfacing on error)
  // AND passthrough each line live to the backend log. Live logs are
  // critical when claude CLI hangs on a third-party endpoint — without
  // them you only see "Timed out" 180s later with no clue what
  // happened. Hot-path is fine; stderr is low volume.
  let stderrBuf = "";
  let stderrLineBuf = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
    if (stderrBuf.length > 8000) {
      stderrBuf = stderrBuf.slice(-8000);
    }
    stderrLineBuf += chunk;
    let nl = stderrLineBuf.indexOf("\n");
    while (nl >= 0) {
      const line = stderrLineBuf.slice(0, nl).replace(/\r$/, "");
      stderrLineBuf = stderrLineBuf.slice(nl + 1);
      if (line.trim().length > 0) {
        logger.chat.info(`[diary cli stderr] ${redactSecrets(line)}`);
      }
      nl = stderrLineBuf.indexOf("\n");
    }
  });
  child.on("exit", (code, signal) => {
    if (stderrLineBuf.trim().length > 0) {
      logger.chat.info(
        `[diary cli stderr] ${redactSecrets(stderrLineBuf.trim())}`,
      );
      stderrLineBuf = "";
    }
    logger.chat.info(
      `[diary cli exit] code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
  });

  // Timeout + abort wiring.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, timeoutMs);

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let body = "";
  let resultText: string | undefined;
  let costUsd: number | undefined;
  let durationFromCli: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let isError = false;
  let errorMessage: string | undefined;
  // Auth-failure tracking. The CLI's bundled SDK retries 401s up to 10
  // times with exponential backoff (~5+ min total) regardless of the
  // ANTHROPIC_MAX_RETRIES env var, which would push us past every
  // reasonable timeout. After 2 consecutive 401s we kill the process
  // — auth doesn't get less wrong by waiting.
  let auth401Count = 0;
  let killedByAuthRetry = false;

  try {
    for await (const evt of readJsonLines(child)) {
      const type = evt.type;
      if (type === "assistant") {
        const text = extractAssistantText(
          (evt as { message?: unknown }).message,
        );
        if (text) {
          body += text;
          opts.onChunk?.(text);
        }
      } else if (type === "system") {
        if ((evt as { subtype?: string }).subtype === "api_retry") {
          const retryEvt = evt as {
            attempt?: number;
            max_retries?: number;
            error_status?: number;
            error?: string;
            retry_delay_ms?: number;
          };
          logger.chat.warn(
            `[diary cli api_retry] attempt=${retryEvt.attempt}/${retryEvt.max_retries} ` +
              `status=${retryEvt.error_status} error=${retryEvt.error} ` +
              `next_in=${Math.round(retryEvt.retry_delay_ms ?? 0)}ms`,
          );
          // Auth failures don't get better with backoff. Kill after
          // the second 401 — auth is either right or it isn't.
          if (retryEvt.error_status === 401) {
            auth401Count++;
            if (auth401Count >= 2 && !killedByAuthRetry) {
              killedByAuthRetry = true;
              errorMessage =
                "Authentication failed (401) on the provider endpoint. " +
                "Re-check your API key under Settings → Diary → Secrets, " +
                "or verify the model id matches what the provider accepts.";
              logger.chat.error(
                `[diary] killing claude process after ${auth401Count} consecutive 401s`,
              );
              child.kill("SIGTERM");
              setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
            }
          }
        }
      } else if (type === "result") {
        resultText = (evt as { result?: string }).result;
        costUsd = (evt as { total_cost_usd?: number }).total_cost_usd;
        durationFromCli = (evt as { duration_ms?: number }).duration_ms;
        const usage = (evt as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        if (usage) {
          inputTokens = Number(usage.input_tokens) || 0;
          outputTokens = Number(usage.output_tokens) || 0;
        }
        isError = Boolean((evt as { is_error?: boolean }).is_error);
        if (isError) {
          // The CLI sometimes returns a friendlier message in the
          // result field when is_error is true.
          errorMessage =
            typeof resultText === "string" && resultText.length > 0
              ? resultText
              : "claude reported an error";
        }
      }
      // ignore "system", "rate_limit_event", "user", and any future types
    }
  } finally {
    clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }

  const exitCode: number = await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("exit", (code) => resolve(code ?? -1));
  });

  if (killedByAuthRetry) {
    // The most informative error message; wins over the generic
    // exit-code path below.
    throw new AgentError(
      errorMessage ?? "Authentication failed",
      redactSecrets(stderrBuf.slice(-500)),
    );
  }
  if (aborted) {
    throw new AgentError("Run aborted", redactSecrets(stderrBuf.slice(-500)));
  }
  if (timedOut) {
    throw new AgentError(
      `Timed out after ${timeoutMs} ms`,
      redactSecrets(stderrBuf.slice(-500)),
    );
  }
  if (exitCode !== 0) {
    throw new AgentError(
      `claude exited ${exitCode}: ${redactSecrets(stderrBuf.slice(-500)) || "(no stderr)"}`,
      redactSecrets(stderrBuf.slice(-500)),
    );
  }
  if (isError) {
    throw new AgentError(
      errorMessage || "claude reported an error",
      redactSecrets(stderrBuf.slice(-500)),
    );
  }

  // Prefer the streamed body since it's what the user sees during chunks;
  // fall back to the result.result field if for some reason no assistant
  // events came through.
  const finalBody = (body || resultText || "").trim();
  if (!finalBody) {
    throw new AgentError("Empty response from claude", redactSecrets(stderrBuf.slice(-500)));
  }

  return {
    body: finalBody,
    model: agent.model,
    duration_ms: durationFromCli ?? Date.now() - t0,
    cost_usd: costUsd,
    tokens:
      inputTokens > 0 || outputTokens > 0
        ? { input: inputTokens, output: outputTokens }
        : undefined,
    stderr_excerpt:
      stderrBuf.length > 0 ? redactSecrets(stderrBuf.slice(-500)) : undefined,
  };
}

// Exported for use in tests / handlers that build their own error
// payloads from runner-adjacent strings.
export { redactSecrets };
