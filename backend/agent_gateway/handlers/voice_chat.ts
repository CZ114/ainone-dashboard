/**
 * voice_chat — text-only streaming endpoint for the /call page.
 *
 * DIRECT-API only. If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`
 * is present in env / settings.json, we POST straight to
 * `${ANTHROPIC_BASE_URL}/v1/messages` with `stream: true`. This
 * bypasses any agent runtime; first-byte latency is 200–400 ms.
 * Conversation continuity is via a `history` array on each request —
 * no server-side sessions.
 *
 * The old Agent-SDK fallback (for subscription-auth users without an
 * env-readable key) was removed together with the SDK dependency:
 * when no key is configured we now return a clear error event instead.
 *
 * Wire format:
 *
 *   {"type":"delta","text":"..."}    // incremental text chunk
 *   {"type":"done"}                  // stream finished cleanly
 *   {"type":"error","message":"..."}
 */

import type { Context } from "hono";
import { getUserEnvFromSettings } from "./chat.ts";

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

  // Direct API only. The Agent-SDK fallback was removed along with the
  // SDK dependency — without an env-readable key we return a clear
  // error event (same NDJSON wire format) instead of falling back.
  const auth = await resolveDirectAuth();
  if (auth) {
    return streamFromDirectApi(body, auth);
  }
  const line =
    JSON.stringify({
      type: "error",
      message:
        "No API key configured for voice chat. Set ANTHROPIC_API_KEY or " +
        "ANTHROPIC_AUTH_TOKEN in the environment or in " +
        "~/.claude/settings.json's env block.",
    }) + "\n";
  return new Response(line, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
    },
  });
}
