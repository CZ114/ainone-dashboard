/**
 * Python agent-service configuration.
 *
 * The gateway no longer talks to the Claude Agent SDK; all AI work is
 * proxied to the Python agent service (backend/agent_service). The base
 * URL is configurable via the AGENT_SERVICE_URL env var.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_AGENT_SERVICE_URL = "http://127.0.0.1:8100";

/** Resolve the agent-service base URL (no trailing slash). */
export function agentServiceUrl(): string {
  const raw = process.env.AGENT_SERVICE_URL || DEFAULT_AGENT_SERVICE_URL;
  return raw.replace(/\/+$/, "");
}

// ── M2 service identity ────────────────────────────────────────────
// The agent service's authz middleware treats callers WITHOUT
// credentials as patient tier, which strips systemPrompt on oneshot /
// voice. Gateway-initiated machine calls (diary runner, voice
// passthrough, config reads) are legitimate and must keep full
// fidelity, so they present the shared secret file as X-Service-Key.
// Same file the Python side signs tokens with — whoever can read it
// already owns this machine, so it doubles as machine identity.

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET_PATH = join(HERE, "..", "..", "data", "agent_service", "auth_secret");

let cachedKey: string | null | undefined;

/** Shared secret for gateway→service calls; null when file absent
    (agent service not yet booted — callers then go out keyless and
    land in patient tier, which only costs systemPrompt fidelity). */
export function serviceKey(): string | null {
  if (cachedKey === undefined) {
    try {
      cachedKey = readFileSync(SECRET_PATH, "ascii").trim();
    } catch {
      cachedKey = null;
    }
  }
  return cachedKey;
}

/** Headers to spread into gateway→service fetches. */
export function serviceHeaders(): Record<string, string> {
  const key = serviceKey();
  return key ? { "X-Service-Key": key } : {};
}
