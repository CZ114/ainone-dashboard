/**
 * Python agent-service configuration.
 *
 * The gateway no longer talks to the Claude Agent SDK; all AI work is
 * proxied to the Python agent service (backend/agent_service). The base
 * URL is configurable via the AGENT_SERVICE_URL env var.
 */

const DEFAULT_AGENT_SERVICE_URL = "http://127.0.0.1:8100";

/** Resolve the agent-service base URL (no trailing slash). */
export function agentServiceUrl(): string {
  const raw = process.env.AGENT_SERVICE_URL || DEFAULT_AGENT_SERVICE_URL;
  return raw.replace(/\/+$/, "");
}
