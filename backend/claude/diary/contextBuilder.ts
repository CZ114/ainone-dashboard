/**
 * Build the user-prompt string the runner sends to claude. We pull a small
 * window of recent recordings from FastAPI, format them as a markdown
 * table, and wrap with a plain instruction.
 *
 * Failure mode: FastAPI down -> we still produce a degraded prompt that
 * tells the model "no recent recordings". The UI will surface an entry
 * either way; the user sees "no data" instead of the request hanging.
 */

interface RecordingSession {
  id: string;
  timestamp: string;
  started_at_iso: string | null;
  csv: {
    filename: string;
    size_bytes: number;
    rows: number | null;
  } | null;
  audio: {
    filename: string;
    size_bytes: number;
    duration_seconds: number | null;
  } | null;
}

interface RecordingsListResponse {
  sessions: RecordingSession[];
  count: number;
}

const FASTAPI_BASE = process.env.FASTAPI_BASE_URL || "http://localhost:8080";
const RECORDINGS_LIMIT = 3;
const FETCH_TIMEOUT_MS = 4000;

async function fetchRecordings(): Promise<RecordingSession[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${FASTAPI_BASE}/api/recordings/list`, {
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as RecordingsListResponse;
    return (data.sessions ?? []).slice(0, RECORDINGS_LIMIT);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function formatRecordingsTable(sessions: RecordingSession[]): string {
  if (sessions.length === 0) {
    return "_(No recordings on disk yet.)_";
  }
  const rows = sessions.map((s) => {
    const dur = s.audio?.duration_seconds
      ? `${s.audio.duration_seconds.toFixed(1)} s`
      : "—";
    const samples = s.csv?.rows != null ? `${s.csv.rows}` : "—";
    const start = s.started_at_iso ?? s.timestamp;
    return `| ${start} | ${dur} | ${samples} |`;
  });
  return [
    "| started_at | audio | csv rows |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export interface BuiltContext {
  recordings: RecordingSession[];
  recordingIds: string[];
  prompt: string;
}

export async function build(): Promise<BuiltContext> {
  const recordings = await fetchRecordings();
  const recordingIds = recordings.map((s) => s.id);
  const now = new Date();
  const localTime = now.toLocaleString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const prompt = [
    `It is now ${localTime} (local time).`,
    "",
    "Here are the most recent sensor recording sessions on disk:",
    "",
    formatRecordingsTable(recordings),
    "",
    recordings.length === 0
      ? "Write a single short sentence noting there are no recordings yet, and one concrete idea for what to record next. Do not pad."
      : "Write a brief observation note. Reference specific values when you can; otherwise say so plainly.",
  ].join("\n");

  return { recordings, recordingIds, prompt };
}
