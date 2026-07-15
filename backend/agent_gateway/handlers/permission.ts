/**
 * POST /api/chat/permission — pure passthrough to the Python agent
 * service's permission bridge. Body shape ({id, decision}) is exactly
 * what the frontend already sends; the service resolves the pending
 * tool-permission request on its side.
 */

import { Context } from "hono";
import { agentServiceUrl } from "../utils/agentService.ts";

export async function handlePermissionResponse(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${agentServiceUrl()}/api/compat/chat/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return c.json(
      {
        error: `Agent service unreachable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      502,
    );
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") || "application/json",
    },
  });
}
