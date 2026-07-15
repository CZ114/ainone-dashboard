/**
 * POST /api/abort/:requestId — pure passthrough to the Python agent
 * service, which owns the in-flight chat requests now.
 */

import { Context } from "hono";
import { logger } from "../utils/logger.ts";
import { agentServiceUrl } from "../utils/agentService.ts";

export async function handleAbortRequest(c: Context) {
  const requestId = c.req.param("requestId");

  if (!requestId) {
    return c.json({ error: "Request ID is required" }, 400);
  }

  logger.api.debug(`Abort proxy for request: ${requestId}`);

  let upstream: Response;
  try {
    upstream = await fetch(
      `${agentServiceUrl()}/api/compat/abort/${encodeURIComponent(requestId)}`,
      { method: "POST" },
    );
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
