/**
 * Main-agent provider detection — agent_service edition.
 *
 * The "main agent" is whatever the Python agent service (:8100) is
 * currently routed to — provider + model live in its runtime config
 * (Settings → Model routing in the UI, persisted server-side). This
 * replaces the old behaviour of reading ~/.claude/settings.json, which
 * described the Claude CLI's provider and is irrelevant now that chat
 * and diary both run through the agent service.
 *
 * Diary uses this for two purposes:
 *
 * 1. **Fallback agent** — when no explicit diary agent is configured,
 *    the runner posts to the agent service's oneshot endpoint with the
 *    built-in `diary_observer` id, which mirrors this main config.
 *
 * 2. **Provider hint** — the UI badge showing which provider/model a
 *    "Generate now" run will use, and whether auth is available.
 */

import { agentServiceUrl, serviceHeaders } from "../utils/agentService.ts";

export interface MainProviderInfo {
  /** The current provider's API base URL (informational, for the UI badge). */
  base_url: string | null;
  /** Current default model of the agent service. */
  model: string | null;
  /**
   * Whether the agent service has a usable credential for the current
   * provider — does NOT include the value itself.
   */
  auth_present: boolean;
  /** Where the values came from. */
  env_source:
    | "agent_service"     // live runtime config from :8100
    | "default";          // agent service unreachable
}

interface AgentServiceConfig {
  config?: { provider?: string; model?: string };
  providers?: Array<{
    name?: string;
    keyPresent?: boolean;
    baseUrl?: string | null;
  }>;
}

export async function getMainProviderInfo(): Promise<MainProviderInfo> {
  try {
    const r = await fetch(`${agentServiceUrl()}/api/agent/config`, {
      // config GET is staff-tier under authz — present machine identity.
      headers: serviceHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as AgentServiceConfig;
    const provider = data.config?.provider ?? null;
    const entry = (data.providers ?? []).find((p) => p.name === provider);
    return {
      base_url: entry?.baseUrl ?? null,
      model: data.config?.model ?? null,
      auth_present: Boolean(entry?.keyPresent),
      env_source: "agent_service",
    };
  } catch {
    // Agent service down — diary runs would fail anyway; report honestly.
    return { base_url: null, model: null, auth_present: false, env_source: "default" };
  }
}
