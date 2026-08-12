/**
 * Chat handler — pure passthrough to the Python agent service.
 *
 * POST /api/chat forwards {message, requestId, sessionId} to
 * `${AGENT_SERVICE_URL}/api/compat/chat` and pipes the NDJSON response
 * bytes through unchanged. The Python service already emits lines in
 * the exact StreamResponse wire format the frontend expects
 * ({type:"claude_json"} / {type:"permission_request"} / {type:"done"} /
 * {type:"error"} / {type:"aborted"}), so nothing is transformed here.
 *
 * Legacy SDK fields the frontend may still send (effort, thinking,
 * permissionMode, allowedTools, workingDirectory, additionalDirectories,
 * additionalSystemPrompt) are dropped silently.
 */

import { Context } from "hono";
import { logger } from "../utils/logger.ts";
import { getHomeDir } from "../utils/os.ts";
import { readTextFile } from "../utils/fs.ts";
import { agentServiceUrl } from "../utils/agentService.ts";

interface UserSettings {
  env?: Record<string, unknown>;
}

// Mirror the Claude CLI's own env-loading behaviour: read every string value
// from ~/.claude/settings.json's `env` block. Still used by the voice-chat
// direct-API path and the diary main-provider probe (no SDK involved).
export async function getUserEnvFromSettings(): Promise<Record<string, string>> {
  const homeDir = getHomeDir();
  if (!homeDir) return {};

  const settingsPath = `${homeDir}/.claude/settings.json`;
  try {
    const content = await readTextFile(settingsPath);
    const settings: UserSettings = JSON.parse(content);
    const result: Record<string, string> = {};

    if (settings.env && typeof settings.env === "object") {
      for (const [key, value] of Object.entries(settings.env)) {
        if (typeof value === "string" && value.length > 0) {
          result[key] = value;
        }
      }
    }

    return result;
  } catch {
    return {};
  }
}

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/** Single NDJSON error line, still parseable by the frontend stream reader. */
function ndjsonError(message: string): Response {
  const line = JSON.stringify({ type: "error", error: message }) + "\n";
  return new Response(line, { headers: NDJSON_HEADERS });
}

/**
 * Handles POST /api/chat — streams NDJSON from the Python agent service
 * back to the client without buffering.
 */
export async function handleChatRequest(c: Context): Promise<Response> {
  let body: {
    message?: unknown;
    requestId?: unknown;
    sessionId?: unknown;
    agentId?: unknown;
    patientId?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return ndjsonError("Invalid JSON body");
  }

  if (typeof body.message !== "string" || body.message.length === 0) {
    return ndjsonError("Missing 'message' field");
  }

  // Forward ONLY the fields the Python service understands; everything
  // else (effort / thinking / permissionMode / allowedTools /
  // workingDirectory / additionalDirectories / ...) is dropped silently.
  const forwarded: Record<string, string> = { message: body.message };
  if (typeof body.requestId === "string" && body.requestId) {
    forwarded.requestId = body.requestId;
  }
  if (typeof body.sessionId === "string" && body.sessionId) {
    forwarded.sessionId = body.sessionId;
  }
  if (typeof body.agentId === "string" && body.agentId) {
    forwarded.agentId = body.agentId;
  }
  // for-whom patient — tags the session so the sidebar can group chats by patient.
  if (typeof body.patientId === "string" && body.patientId) {
    forwarded.patientId = body.patientId;
  }

  console.log("[chat] proxy →", `${agentServiceUrl()}/api/compat/chat`, {
    requestId: forwarded.requestId,
    sessionId: forwarded.sessionId,
    messageLen: body.message.length,
  });

  let upstream: Response;
  try {
    upstream = await fetch(`${agentServiceUrl()}/api/compat/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forwarded),
      // Client disconnect cancels the upstream request too.
      signal: c.req.raw.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.chat.error("Agent service unreachable: {error}", { error });
    return ndjsonError(
      `Agent service unreachable at ${agentServiceUrl()}: ${message}`,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return ndjsonError(
      `Agent service error: HTTP ${upstream.status}${
        text ? ` — ${text.slice(0, 300)}` : ""
      }`,
    );
  }

  // Pipe the upstream body through untouched. Returning the upstream
  // ReadableStream directly means each NDJSON line is flushed to the
  // client as soon as the Python service emits it — no buffering.
  return new Response(upstream.body, { headers: NDJSON_HEADERS });
}
