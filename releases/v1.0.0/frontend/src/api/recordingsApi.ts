// Client for the Python backend's recordings library (/api/recordings/*).
// Distinct from the Node chat backend (`claudeApi`) — these endpoints
// list past ESP32 recording sessions so the user can pull them into
// chat context as attachments.

export interface RecordingCsvInfo {
  filename: string;
  size_bytes: number;
  rows: number | null;
  channels?: string[] | null;
}

export interface RecordingAudioInfo {
  filename: string;
  size_bytes: number;
  duration_seconds: number | null;
}

export interface RecordingSession {
  id: string;                     // "20260424_143022"
  timestamp: string;              // same shape as id; kept for clarity
  started_at_iso: string | null;  // ISO 8601 for `new Date(...)`
  csv: RecordingCsvInfo | null;
  audio: RecordingAudioInfo | null;
}

export interface RecordingListResponse {
  sessions: RecordingSession[];
  count: number;
}

const BASE = '';

export const recordingsApi = {
  list: async (): Promise<{ sessions: RecordingSession[]; error?: string }> => {
    try {
      const r = await fetch(`${BASE}/api/recordings/list`);
      const raw = await r.text();
      if (!r.ok) {
        return {
          sessions: [],
          error: `HTTP ${r.status}: ${raw.slice(0, 160) || '<empty>'}`,
        };
      }
      const data: RecordingListResponse = raw ? JSON.parse(raw) : { sessions: [], count: 0 };
      return { sessions: data.sessions || [] };
    } catch (err) {
      return {
        sessions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  meta: async (id: string): Promise<{ session: RecordingSession | null; error?: string }> => {
    try {
      const r = await fetch(`${BASE}/api/recordings/meta/${encodeURIComponent(id)}`);
      if (!r.ok) {
        const body = await r.text();
        return {
          session: null,
          error: `HTTP ${r.status}: ${body.slice(0, 160)}`,
        };
      }
      const data = (await r.json()) as RecordingSession;
      return { session: data };
    } catch (err) {
      return {
        session: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  // Fetch CSV text. `head` limits the response to header + N data rows
  // so the frontend can pull a preview of a 50MB recording cheaply.
  csvContent: async (
    filename: string,
    opts: { head?: number } = {},
  ): Promise<{ text: string | null; error?: string }> => {
    try {
      const q = opts.head ? `?head=${opts.head}` : '';
      const r = await fetch(
        `${BASE}/api/recordings/csv/${encodeURIComponent(filename)}${q}`,
      );
      if (!r.ok) {
        const body = await r.text();
        return {
          text: null,
          error: `HTTP ${r.status}: ${body.slice(0, 160)}`,
        };
      }
      return { text: await r.text() };
    } catch (err) {
      return {
        text: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  // Build an absolute URL for the audio file (for <audio> playback or
  // Claude's Read tool via a path-style reference in the prompt).
  audioUrl: (filename: string): string =>
    `${BASE}/api/recordings/audio/${encodeURIComponent(filename)}`,
};
