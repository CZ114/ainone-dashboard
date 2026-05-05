/**
 * Main-agent provider detection.
 *
 * The "main agent" is whatever Claude CLI provider the user has
 * configured for their interactive chat work — i.e. whatever
 * `claude` would default to when they run it from a shell. We read
 * `~/.claude/settings.json` (which the chat handler already loads
 * via `getUserEnvFromSettings`) and fall back to `process.env`.
 *
 * Diary uses this for two purposes:
 *
 * 1. **Fallback agent** — when no explicit diary agent is configured,
 *    the runner builds an ephemeral agent that uses the main
 *    provider's BASE_URL + MODEL + AUTH. Avoids the old behaviour of
 *    hard-coding Haiku, which surprised users who had switched their
 *    main env to a non-Anthropic provider.
 *
 * 2. **Provider lock** — when the user creates a diary agent in the
 *    UI, the editor restricts the provider picker to the main
 *    provider's family. Prevents a class of misconfiguration where
 *    e.g. an Anthropic API key from settings.json silently gets
 *    sent to a MiniMax endpoint via a per-agent BASE_URL override.
 */

import { getUserEnvFromSettings } from "../handlers/chat.ts";

export interface MainProviderInfo {
  /**
   * `ANTHROPIC_BASE_URL` value from the user's environment, normalised
   * to a string with no trailing slash. `null` means Anthropic native
   * (no override set).
   */
  base_url: string | null;
  /**
   * `ANTHROPIC_MODEL` value if explicitly set, else `null`. The
   * fallback runner uses this when a caller doesn't pick a model.
   * Most users don't set this — they pick per-invocation via `--model`.
   */
  model: string | null;
  /**
   * Whether SOME credential is reachable at runtime — does NOT include
   * the value itself. UI uses this to show a "main agent configured"
   * vs "main agent missing — paste a key" hint.
   */
  auth_present: boolean;
  /**
   * Where the values came from. Useful in the UI hint and in logs
   * when debugging "why does the diary fallback think I'm on
   * DeepSeek?".
   */
  env_source:
    | "settings_json"     // ~/.claude/settings.json env block
    | "process_env"       // shell env / .env
    | "default";          // nothing found, defaulting to Anthropic native
}

const ANTHROPIC_AUTH_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

function trimTrailingSlash(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export async function getMainProviderInfo(): Promise<MainProviderInfo> {
  const settingsEnv = await getUserEnvFromSettings();

  // Prefer settings.json over process.env so a user who set things up
  // via `claude /login` or by editing settings.json sees that as
  // canonical. Process.env is a fallback for shell/.env-based setups.
  const baseUrl =
    trimTrailingSlash(settingsEnv.ANTHROPIC_BASE_URL) ??
    trimTrailingSlash(process.env.ANTHROPIC_BASE_URL);

  const model =
    settingsEnv.ANTHROPIC_MODEL?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    null;

  const authFromSettings = ANTHROPIC_AUTH_KEYS.some(
    (k) => typeof settingsEnv[k] === "string" && settingsEnv[k].length > 0,
  );
  const authFromProcess = ANTHROPIC_AUTH_KEYS.some(
    (k) => typeof process.env[k] === "string" && (process.env[k] ?? "").length > 0,
  );
  const auth_present = authFromSettings || authFromProcess;

  let env_source: MainProviderInfo["env_source"];
  if (settingsEnv.ANTHROPIC_BASE_URL || authFromSettings || settingsEnv.ANTHROPIC_MODEL) {
    env_source = "settings_json";
  } else if (process.env.ANTHROPIC_BASE_URL || authFromProcess || process.env.ANTHROPIC_MODEL) {
    env_source = "process_env";
  } else {
    env_source = "default";
  }

  return {
    base_url: baseUrl ?? null,
    model: model ?? null,
    auth_present,
    env_source,
  };
}

/**
 * Build the resolved agent env that mirrors the main agent's provider.
 * Used by the fallback agent when no explicit diary agent is in scope.
 *
 * Returns ONLY the BASE_URL when set; auth comes from inheritance at
 * spawn time (the chat handler's normal env-merge path picks up the
 * settings.json keys). Diary's runner does its own auth normalisation
 * (see runner.ts) which handles both API_KEY and AUTH_TOKEN styles.
 */
export async function buildMainProviderEnv(): Promise<Record<string, string>> {
  const info = await getMainProviderInfo();
  const env: Record<string, string> = {};
  if (info.base_url) env.ANTHROPIC_BASE_URL = info.base_url;
  return env;
}
