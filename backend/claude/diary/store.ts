/**
 * Diary persistence — atomic JSON IO for entries, config, and the agents file.
 *
 * Mirrors the Python pattern in backend/app/extensions/state.py: write to a
 * temp neighbour then `rename` over the target so a kill mid-save never leaves
 * a half-written file.
 *
 * Files live under backend/data/diary/ by default. Override with the
 * DIARY_DATA_DIR env var when running from a non-default cwd.
 */

import { promises as fs } from "node:fs";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentsFile,
  DiaryConfig,
  DiaryEntriesFile,
  DiaryEntry,
} from "../../shared/types.ts";

// Resolve <repo>/backend/data/diary/ from this file's location:
//   backend/claude/diary/store.ts  ->  backend/data/diary/
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DIR = path.resolve(__dirname, "..", "..", "data", "diary");

export const DATA_DIR = process.env.DIARY_DATA_DIR
  ? path.resolve(process.env.DIARY_DATA_DIR)
  : DEFAULT_DIR;

// Where Reply-button chats live as a "project" in ~/.claude/projects.
// Using a real directory at <repo>/diary-replies makes the chat sidebar
// group every diary follow-up under one project label automatically (it
// groups sessions by cwd). The directory is gitignored.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const DIARY_REPLIES_DIR = process.env.DIARY_REPLIES_DIR
  ? path.resolve(process.env.DIARY_REPLIES_DIR)
  : path.join(REPO_ROOT, "diary-replies");

export function ensureDiaryRepliesDir(): string {
  mkdirSync(DIARY_REPLIES_DIR, { recursive: true });
  return DIARY_REPLIES_DIR;
}

const ENTRIES_FILE = path.join(DATA_DIR, "diary_entries.json");
const CONFIG_FILE = path.join(DATA_DIR, "diary_config.json");
const AGENTS_FILE = path.join(DATA_DIR, "agents.json");

function ensureDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Atomic write: write neighbour ".tmp" then rename. Synchronous because
// rename ordering is what matters; the actual byte count is small.
function atomicWriteJson(target: string, value: unknown): void {
  ensureDir();
  const tmp = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, target);
}

async function readJson<T>(target: string): Promise<T | null> {
  try {
    const text = await fs.readFile(target, "utf-8");
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

// ---------- Entries ----------------------------------------------------------

const EMPTY_ENTRIES: DiaryEntriesFile = { version: 1, entries: [] };

export async function readEntries(): Promise<DiaryEntriesFile> {
  const data = await readJson<DiaryEntriesFile>(ENTRIES_FILE);
  if (!data) return { ...EMPTY_ENTRIES };
  if (!Array.isArray(data.entries)) return { ...EMPTY_ENTRIES };
  return data;
}

export async function appendEntry(entry: DiaryEntry): Promise<void> {
  const file = await readEntries();
  // Newest-first invariant.
  file.entries.unshift(entry);
  atomicWriteJson(ENTRIES_FILE, file);
}

export async function getEntry(id: string): Promise<DiaryEntry | null> {
  const file = await readEntries();
  return file.entries.find((e) => e.id === id) ?? null;
}

export async function updateEntry(
  id: string,
  patch: Partial<DiaryEntry>,
): Promise<DiaryEntry | null> {
  const file = await readEntries();
  const idx = file.entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const merged = { ...file.entries[idx], ...patch };
  file.entries[idx] = merged;
  atomicWriteJson(ENTRIES_FILE, file);
  return merged;
}

export async function markRead(id: string): Promise<DiaryEntry | null> {
  return updateEntry(id, { read: true });
}

/**
 * Permanently drop an entry from the diary file. The /diary UI gates
 * this behind a "must be marked read first" rule so an unread cron
 * entry can't be silently lost without the user seeing it.
 */
export async function deleteEntry(id: string): Promise<DiaryEntry | null> {
  const file = await readEntries();
  const idx = file.entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const [removed] = file.entries.splice(idx, 1);
  atomicWriteJson(ENTRIES_FILE, file);
  return removed ?? null;
}

// ---------- Config -----------------------------------------------------------

const DEFAULT_CONFIG: DiaryConfig = {
  enabled: false,
  schedule: {},
  triggers: { on_recording_complete: { enabled: false } },
  notification: { browser: false },
  daily_quota: 3,
};

export async function readConfig(): Promise<DiaryConfig> {
  const data = await readJson<DiaryConfig>(CONFIG_FILE);
  if (!data) {
    atomicWriteJson(CONFIG_FILE, DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  return { ...DEFAULT_CONFIG, ...data };
}

export async function writeConfig(config: DiaryConfig): Promise<void> {
  atomicWriteJson(CONFIG_FILE, config);
}

export async function patchConfig(
  patch: Partial<DiaryConfig>,
): Promise<DiaryConfig> {
  const current = await readConfig();
  const merged: DiaryConfig = { ...current, ...patch };
  atomicWriteJson(CONFIG_FILE, merged);
  return merged;
}

// ---------- Agents -----------------------------------------------------------

const EMPTY_AGENTS: AgentsFile = { version: 1, secrets: {}, agents: {} };

export async function readAgentsFile(): Promise<AgentsFile> {
  const data = await readJson<AgentsFile>(AGENTS_FILE);
  if (!data) return { ...EMPTY_AGENTS };
  return {
    version: 1,
    secrets: data.secrets ?? {},
    agents: data.agents ?? {},
  };
}

export async function writeAgentsFile(file: AgentsFile): Promise<void> {
  atomicWriteJson(AGENTS_FILE, file);
}
