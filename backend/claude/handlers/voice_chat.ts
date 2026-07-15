/**
 * voice_chat — text-only streaming endpoint for the /call page.
 *
 * Two backends, picked at request time based on what auth the user
 * has configured:
 *
 *   1. DIRECT-API path. If `ANTHROPIC_API_KEY` or
 *      `ANTHROPIC_AUTH_TOKEN` is present in env / settings.json,
 *      we POST straight to `${ANTHROPIC_BASE_URL}/v1/messages` with
 *      `stream: true`. This bypasses the Claude CLI subprocess and
 *      the agent SDK; first-byte latency is 200–400 ms.
 *      Conversation continuity is via a `history` array on each
 *      request — no server-side sessions.
 *
 *   2. AGENT-SDK fallback. Subscription-auth users (those who logged
 *      in via the Claude CLI / desktop app) don't have an API key
 *      readable from env — the OAuth token lives in the OS
 *      credential store and only the CLI knows how to use it. For
 *      them we fall back to `query()` from
 *      `@anthropic-ai/claude-agent-sdk`, which spawns the CLI
 *      internally and uses whatever auth the CLI has. Slower (CLI
 *      spawn 300–1500 ms) but compatible with subscription accounts.
 *      Continuity is via the SDK's session resume — we surface the
 *      assigned session_id back to the frontend on the first turn,
 *      and accept it on subsequent turns.
 *
 * Wire format is the SAME for both paths so the frontend doesn't
 * branch:
 *
 *   {"type":"session","id":"..."}    // SDK path only, first turn
 *   {"type":"delta","text":"..."}    // incremental text chunk
 *   {"type":"done"}                  // stream finished cleanly
 *   {"type":"error","message":"..."}
 */

import type { Context } from "hono";
import { query } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import {
  getUserEnvFromSettings,
  resolveClaudeBinary,
} from "./chat.ts";

interface ApiMessage {
  role: "user" | "assistant";
  content: string;
}

interface VoiceChatRequest {
  message: string;
  history?: ApiMessage[];
  /** Existing SDK session id (subscription-auth path only). */
  sessionId?: string;
  model?: string;
  system?: string;
  requestId?: string;
}

// Voice mode is latency-critical: the user is staring at the orb
// waiting for the reply. We pin Haiku 4.5 here regardless of what
// the request body or env asks for — Sonnet/Opus tokens-per-second
// is too slow to feel snappy on a phone-call-style UX, and Haiku 4.5
// is the smallest current-generation model that still produces
// natural conversational answers.
//
// Extended thinking is also OFF by design:
//   - Direct API: we never include the `thinking` field, so the
//     server takes the default (no thinking).
//   - SDK fallback: Haiku 4.5 doesn't support extended thinking, so
//     even if the CLI tried to enable it the model would silently
//     ignore it.
// Either way, no <thinking> blocks burn time before the first audible
// delta lands. If you ever want to re-enable thinking for a specific
// turn, override at the request level — don't unpin the model here.
const VOICE_MODEL = "claude-haiku-4-5";

// Voice-mode system prompt. Earlier versions hard-clamped responses
// to "one or two sentences" and forbade lists / tables / code, which
// noticeably dumbed down the model — same questions that gave rich
// analysis in the chat page returned thin one-liners here. The new
// prompt asks Claude to MATCH the question's depth: short for chat,
// thorough when the user actually wants analysis. Markdown structure
// (lists, tables, code fences) is permitted when it materially helps
// — useful because the call page renders markdown in the bubble.
const DEFAULT_VOICE_SYSTEM_PROMPT =
  "You are talking with the user over a voice interface. Speak " +
  "naturally — like a person, not a search engine. Match the depth " +
  "of the question: a casual greeting deserves a casual reply; a " +
  "technical or analytical question deserves a thorough answer. " +
  "Use markdown structure (bullet lists, tables, code blocks, " +
  "headings) WHEN it materially helps clarity — don't use it for " +
  "ordinary conversation, but don't avoid it either if a tabular " +
  "summary or numbered list would actually serve the user. If the " +
  "user has dropped data files into the conversation, you have " +
  "tools (Read, Bash, Grep, etc.) and should use them to give " +
  "concrete, data-grounded answers rather than guessing.";

interface DirectAuth {
  baseUrl: string;
  defaultModel: string;
  headers: Record<string, string>;
}

/**
 * Resolve direct-API auth. Returns null when no key is configured —
 * caller falls back to the SDK path.
 */
async function resolveDirectAuth(): Promise<DirectAuth | null> {
  const settingsEnv = await getUserEnvFromSettings();
  const env: Record<string, string> = {
    ...settingsEnv,
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>,
  };

  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) return null;

  const baseUrl = (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(
    /\/+$/,
    "",
  );
  // Ignore env's ANTHROPIC_MODEL on the voice path — see VOICE_MODEL
  // comment above. Field kept for API symmetry with non-voice handlers.
  const defaultModel = VOICE_MODEL;

  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (env.ANTHROPIC_AUTH_TOKEN) {
    headers["authorization"] = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
  }
  if (env.ANTHROPIC_API_KEY) {
    headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  }
  return { baseUrl, defaultModel, headers };
}

/* ─────────────────────── Direct-API path ─────────────────────── */

async function streamFromDirectApi(
  body: VoiceChatRequest,
  auth: DirectAuth,
): Promise<Response> {
  const messages: ApiMessage[] = [];
  for (const m of body.history ?? []) {
    if (
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.length > 0
    ) {
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({ role: "user", content: body.message });

  const upstream = await fetch(`${auth.baseUrl}/v1/messages`, {
    method: "POST",
    headers: auth.headers,
    body: JSON.stringify({
      // Pin to VOICE_MODEL — body.model is intentionally ignored on
      // the voice path so a misconfigured frontend can't accidentally
      // route a phone-call turn through Sonnet/Opus and tank latency.
      model: VOICE_MODEL,
      max_tokens: 1024,
      system: body.system ?? DEFAULT_VOICE_SYSTEM_PROMPT,
      messages,
      stream: true,
      // No `thinking` field → server defaults to extended-thinking
      // off, which is what we want here. See VOICE_MODEL comment.
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(
      JSON.stringify({
        error: `Upstream API error: HTTP ${upstream.status} — ${text.slice(0, 200)}`,
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const writeLine = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trimEnd();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const evt = JSON.parse(raw) as {
                type?: string;
                delta?: { type?: string; text?: string };
              };
              if (
                evt.type === "content_block_delta" &&
                evt.delta?.type === "text_delta" &&
                typeof evt.delta.text === "string"
              ) {
                writeLine({ type: "delta", text: evt.delta.text });
              }
            } catch {
              /* malformed event line — skip */
            }
          }
        }
        writeLine({ type: "done" });
      } catch (e) {
        writeLine({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/* ─────────────────────── SDK fallback path ─────────────────────── */

async function streamFromSdk(body: VoiceChatRequest): Promise<Response> {
  const userEnv = await getUserEnvFromSettings();
  const cliPath = resolveClaudeBinary();
  const abortController = new AbortController();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writeLine = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      try {
        // Build the prompt. SDK's session resume will reattach prior
        // context server-side, so we don't need to inline history when
        // sessionId is known. First turn falls back to a self-contained
        // prompt that includes any history the frontend kept locally.
        let prompt = body.message;
        const hasSession = !!body.sessionId;
        if (!hasSession && body.history && body.history.length > 0) {
          const historyBlock = body.history
            .map((m) =>
              m.role === "user" ? `User: ${m.content}` : `Claude: ${m.content}`,
            )
            .join("\n\n");
          prompt = `Conversation so far:\n\n${historyBlock}\n\nUser: ${body.message}`;
        }

        const queryOptions = {
          prompt,
          options: {
            abortController,
            pathToClaudeCodeExecutable: cliPath,
            tools: { type: "preset" as const, preset: "claude_code" as const },
            // Override the heavy code-agent system prompt with our
            // voice-mode one. Stays a string (not preset) so claude
            // sees ONLY the voice instructions.
            systemPrompt: body.system ?? DEFAULT_VOICE_SYSTEM_PROMPT,
            settingSources: ["project", "user", "local"] as Array<
              "project" | "user" | "local"
            >,
            stderr: (chunk: string) => {
              console.log("[voice-chat sdk stderr]", chunk.trimEnd());
            },
            env: {
              ...process.env,
              ...userEnv,
            },
            // Voice mode = no UI for permission prompts. Bypass mode
            // auto-allows every tool call so Claude can Read attached
            // recordings, run Bash, search the web etc. mid-
            // conversation without freezing on a "Allow this tool?"
            // dialog the user can't see while talking. Tradeoff
            // accepted: this is the same trust level as a CLI session
            // run with --permission-mode bypassPermissions, which is
            // documented behaviour. Allowed tools list is left
            // unconstrained so the preset's full tool palette is
            // available.
            permissionMode: "bypassPermissions" as const,
            cwd: os.homedir(),
            ...(hasSession ? { resume: body.sessionId } : {}),
            // Force VOICE_MODEL — overrides whatever model the CLI is
            // configured for at the user level. Haiku 4.5 doesn't
            // support extended thinking, so this also implicitly
            // disables <thinking> blocks. See VOICE_MODEL comment.
            model: VOICE_MODEL,
          },
        };

        // Track the running text per assistant message so we can emit
        // deltas. The SDK may either (a) emit one assistant message
        // per chunk, growing the content, or (b) emit deltas via
        // `stream_event` items — both are normalised here by
        // computing the diff between successive concatenated texts.
        let lastEmitted = "";

        for await (const sdkMessage of query(queryOptions)) {
          if (
            sdkMessage.type === "system" &&
            (sdkMessage as { subtype?: string }).subtype === "init"
          ) {
            const sid = (sdkMessage as { session_id?: string }).session_id;
            if (sid) writeLine({ type: "session", id: sid });
            continue;
          }
          if (sdkMessage.type === "assistant") {
            const message = (sdkMessage as { message?: { content?: unknown[] } }).message;
            const content = message?.content;
            if (!Array.isArray(content)) continue;
            // Concat all text-typed blocks to a running snapshot, then
            // emit the new tail since the last write.
            let runningText = "";
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                (block as { type?: string }).type === "text" &&
                typeof (block as { text?: string }).text === "string"
              ) {
                runningText += (block as { text: string }).text;
              }
            }
            if (runningText.length > lastEmitted.length) {
              const delta = runningText.slice(lastEmitted.length);
              writeLine({ type: "delta", text: delta });
              lastEmitted = runningText;
            }
          }
        }
        writeLine({ type: "done" });
      } catch (e) {
        writeLine({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/* ─────────────────────── Entry point ─────────────────────── */

export async function handleVoiceChat(c: Context): Promise<Response> {
  let body: VoiceChatRequest;
  try {
    body = (await c.req.json()) as VoiceChatRequest;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "Missing 'message' field" }, 400);
  }

  // Pick path based on what auth is available. Direct API is much
  // faster but needs an explicit key/token; SDK path uses the CLI's
  // own auth (subscription / OAuth), which most "logged-in via Claude
  // app" users will have but no env-readable key for.
  const auth = await resolveDirectAuth();
  if (auth) {
    return streamFromDirectApi(body, auth);
  }
  return streamFromSdk(body);
}
