/**
 * voice_chat — text-only streaming endpoint for the /call page.
 *
 * Pure passthrough to the Python agent service (SOD M4, 2026-07-11).
 * The old direct-Anthropic path (pinned claude-haiku, env-key auth) is
 * gone: the agent service's /api/agent/voice streams the same wire
 * format via AgentDeploy.think() using whatever provider/model the
 * Settings → Model routing page selects. Conversation continuity stays
 * client-side (a `history` array on each request — no server sessions).
 *
 * Wire format (produced by the Python service, piped through as-is):
 *
 *   {"type":"delta","text":"..."}    // incremental text chunk
 *   {"type":"done"}                  // stream finished cleanly
 *   {"type":"error","message":"..."}
 */

import type { Context } from "hono";
import { agentServiceUrl, serviceHeaders } from "../utils/agentService.ts";

interface ApiMessage {
  role: "user" | "assistant";
  content: string;
}

interface VoiceChatRequest {
  message: string;
  history?: ApiMessage[];
  system?: string;
  /** Legacy fields — accepted and ignored (model is routed server-side now). */
  sessionId?: string;
  model?: string;
  requestId?: string;
}

const NDJSON_HEADERS = {
  "content-type": "application/x-ndjson",
  "cache-control": "no-cache",
} as const;

function ndjsonError(message: string): Response {
  return new Response(JSON.stringify({ type: "error", message }) + "\n", {
    headers: NDJSON_HEADERS,
  });
}

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

  const forwarded = {
    message: body.message,
    history: Array.isArray(body.history) ? body.history : [],
    ...(typeof body.system === "string" && body.system
      ? { system: body.system }
      : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${agentServiceUrl()}/api/agent/voice`, {
      method: "POST",
      // X-Service-Key keeps the call page's own `system` persona intact;
      // keyless (= patient-tier) callers get it stripped by authz.
      headers: { "content-type": "application/json", ...serviceHeaders() },
      body: JSON.stringify(forwarded),
      signal: c.req.raw.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return ndjsonError(
      `Agent service unreachable at ${agentServiceUrl()}: ${message}`,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return ndjsonError(
      `Agent service error: HTTP ${upstream.status}${
        text ? ` — ${text.slice(0, 200)}` : ""
      }`,
    );
  }

  return new Response(upstream.body, { headers: NDJSON_HEADERS });
}
