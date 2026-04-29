/**
 * Agent CRUD + secret resolution.
 *
 * Phase 1: a single hardcoded `diary_observer` agent is returned when
 * agents.json doesn't exist or doesn't define one. Phase 2 will add real
 * CRUD endpoints; the store layout already supports them.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AgentsFile } from "../../shared/types.ts";
import {
  readAgentsFile,
  writeAgentsFile,
} from "./store.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPTS_DIR = path.join(__dirname, "prompts");

const DAILY_OBSERVATION_PROMPT_PATH = path.join(
  PROMPTS_DIR,
  "daily_observation.md",
);

export const DEFAULT_AGENT_ID = "diary_observer";

let cachedDailyPrompt: string | null = null;
async function loadDailyPrompt(): Promise<string> {
  if (cachedDailyPrompt !== null) return cachedDailyPrompt;
  cachedDailyPrompt = await fs.readFile(
    DAILY_OBSERVATION_PROMPT_PATH,
    "utf-8",
  );
  return cachedDailyPrompt;
}

/** Built-in fallback used when the user hasn't created any agents yet. */
async function fallbackAgent(): Promise<AgentConfig> {
  return {
    name: "Daily Observer",
    description: "Brief factual observations on recent recordings.",
    // Haiku is cheap and fast; the user can switch to Sonnet/Opus per agent
    // once the Phase 2 editor lands.
    model: "claude-haiku-4-5",
    env: {}, // empty -> runner falls back to ~/.claude/settings.json
    system_prompt: await loadDailyPrompt(),
    sampling: { max_tokens: 800, temperature: 0.5 },
  };
}

/**
 * Resolve `${SECRET_NAME}` placeholders inside an env block.
 *
 * Lookup order:
 *   1. agents.json `secrets` block (UI-managed, persisted in
 *      backend/data/diary/agents.json) — highest precedence so a key
 *      pasted in the AgentEditor always wins.
 *   2. process.env (populated from `.env` at boot via
 *      `cli/node.ts:loadEnvFiles`) — fallback so users who prefer to
 *      keep keys out of the diary JSON can put `MINIMAX_KEY=sk-...`
 *      in `<repo>/.env` and never paste anything via the UI.
 *   3. Literal placeholder kept on miss — runner pre-flight rejects
 *      this case with a clear error rather than letting `${X}` reach
 *      an HTTP header.
 */
export function resolveSecrets(
  env: Record<string, string>,
  secrets: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name) => {
      const fromJson = secrets[name];
      if (typeof fromJson === "string" && fromJson.length > 0) {
        return fromJson;
      }
      const fromEnv = process.env[name];
      if (typeof fromEnv === "string" && fromEnv.length > 0) {
        return fromEnv;
      }
      return match;
    });
  }
  return out;
}

export async function getAgent(id: string): Promise<AgentConfig> {
  const file = await readAgentsFile();
  const agent = file.agents[id];
  if (agent) return agent;
  // Phase 1 convenience: any unknown id falls back to the daily observer
  // so the manual-trigger path can't 404 on an empty agents.json.
  if (id === DEFAULT_AGENT_ID) return fallbackAgent();
  throw new Error(`Unknown agent: ${id}`);
}

export async function getSecrets(): Promise<Record<string, string>> {
  const file = await readAgentsFile();
  return file.secrets;
}

export async function listAgents(): Promise<Array<{ id: string; agent: AgentConfig }>> {
  const file = await readAgentsFile();
  const explicit = Object.entries(file.agents).map(([id, agent]) => ({ id, agent }));
  // Always surface the built-in Anthropic Haiku as an option so the
  // /diary picker has a known-working choice even when the user's
  // custom agents are misconfigured. If the user explicitly created
  // an agent at the DEFAULT_AGENT_ID slot they win — otherwise we
  // prepend the fallback.
  if (!file.agents[DEFAULT_AGENT_ID]) {
    return [
      { id: DEFAULT_AGENT_ID, agent: await fallbackAgent() },
      ...explicit,
    ];
  }
  return explicit;
}

export async function upsertAgent(
  id: string,
  agent: AgentConfig,
): Promise<void> {
  const file = await readAgentsFile();
  file.agents[id] = agent;
  await writeAgentsFile(file);
}

export async function deleteAgent(id: string): Promise<boolean> {
  const file = await readAgentsFile();
  if (!(id in file.agents)) return false;
  delete file.agents[id];
  await writeAgentsFile(file);
  return true;
}

export async function setSecret(name: string, value: string): Promise<void> {
  const file = await readAgentsFile();
  file.secrets[name] = value;
  await writeAgentsFile(file);
}

export async function deleteSecret(name: string): Promise<boolean> {
  const file = await readAgentsFile();
  if (!(name in file.secrets)) return false;
  delete file.secrets[name];
  await writeAgentsFile(file);
  return true;
}

/** Returns secrets list without leaking values; UI uses this. */
export async function listSecretNames(): Promise<string[]> {
  const file = await readAgentsFile();
  return Object.keys(file.secrets);
}

/** For UI display: which secrets does any agent reference via ${NAME}? */
export async function findSecretReferences(): Promise<Record<string, string[]>> {
  const file = await readAgentsFile();
  const refs: Record<string, string[]> = {};
  for (const [agentId, agent] of Object.entries(file.agents)) {
    for (const v of Object.values(agent.env)) {
      const re = /\$\{([A-Z0-9_]+)\}/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(v)) !== null) {
        if (!refs[m[1]]) refs[m[1]] = [];
        if (!refs[m[1]].includes(agentId)) refs[m[1]].push(agentId);
      }
    }
  }
  return refs;
}
