/**
 * One run of a diary agent, end-to-end:
 *   build context -> spawn claude -> persist DiaryEntry -> emit bus events.
 *
 * Lives outside the HTTP handler so the scheduler can call it directly
 * without faking a Hono Context.
 */

import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.ts";
import type {
  DiaryEntry,
  DiaryEntryType,
  DiaryTrigger,
} from "../../shared/types.ts";
import { build as buildContext } from "./contextBuilder.ts";
import { runAgent, AgentError } from "./runner.ts";
import { appendEntry } from "./store.ts";
import { diaryBus } from "./eventBus.ts";

export interface OrchestrateOptions {
  trigger: DiaryTrigger;
  agentId: string;
  /** Override the user prompt; default is contextBuilder output. */
  prompt?: string;
  /** Used by scheduler to flag boot-time delayed runs. */
  delayed?: boolean;
  signal?: AbortSignal;
  /** Distinct id for matching events on the bus to the calling stream. */
  requestId?: string;
}

export interface OrchestrateResult {
  ok: boolean;
  entry?: DiaryEntry;
  error?: string;
  stderr_excerpt?: string;
  request_id: string;
}

function deriveTitle(body: string): string {
  const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const cleaned = firstLine.replace(/^[#>*\-\s]+/, "").trim();
  return cleaned.length > 60 ? cleaned.slice(0, 57) + "..." : cleaned;
}

export async function runAndPersist(
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const requestId = opts.requestId ?? `diary-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();

  diaryBus.emit({
    type: "started",
    request_id: requestId,
    agent_id: opts.agentId,
    trigger: opts.trigger,
    started_at: startedAt,
  });

  try {
    const ctx = opts.prompt
      ? { prompt: opts.prompt, recordingIds: [] as string[] }
      : await buildContext();

    const run = await runAgent(opts.agentId, ctx.prompt, {
      signal: opts.signal,
      onChunk: (delta) =>
        diaryBus.emit({ type: "chunk", request_id: requestId, delta }),
    });

    const type: DiaryEntryType = "observation";
    const entry: DiaryEntry = {
      id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
      type,
      title: deriveTitle(run.body),
      body: run.body,
      created_at: new Date().toISOString(),
      trigger: opts.trigger,
      agent_id: opts.agentId,
      model: run.model,
      context_refs: { recordings: ctx.recordingIds },
      read: false,
      duration_ms: run.duration_ms,
      cost_usd: run.cost_usd,
      tokens: run.tokens,
      delayed: opts.delayed || undefined,
    };

    await appendEntry(entry);
    const tokSum = run.tokens ? run.tokens.input + run.tokens.output : 0;
    logger.chat.info(
      `[diary] entry ${entry.id} saved (${run.duration_ms}ms, ~${tokSum} tok)`,
    );

    diaryBus.emit({ type: "new", request_id: requestId, entry });
    return { ok: true, entry, request_id: requestId };
  } catch (err) {
    const isAgentErr = err instanceof AgentError;
    const message = err instanceof Error ? err.message : String(err);
    const stderrExcerpt = isAgentErr ? err.stderr_excerpt : undefined;
    logger.chat.error(`[diary] run failed: ${message}`);
    diaryBus.emit({
      type: "error",
      request_id: requestId,
      error: message,
      stderr_excerpt: stderrExcerpt,
    });
    return {
      ok: false,
      error: message,
      stderr_excerpt: stderrExcerpt,
      request_id: requestId,
    };
  }
}
