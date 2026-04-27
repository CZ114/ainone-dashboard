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

  // Run a saved WAV through the Whisper extension and return the
  // transcript. Batch mode — request blocks until decoding finishes
  // (typically 0.5-2 s per minute on GPU; longer on CPU). Frontend
  // should show a loading state.
  // 503 errors are surfaced verbatim because they're actionable
  // ("install the extension", "model still loading").
  transcribeAudio: async (
    filename: string,
  ): Promise<{
    text?: string;
    language?: string | null;
    duration_seconds?: number;
    transcribe_ms?: number;
    error?: string;
  }> => {
    try {
      const r = await fetch(
        `${BASE}/api/recordings/transcribe/${encodeURIComponent(filename)}`,
        { method: 'POST' },
      );
      if (!r.ok) {
        const body = await r.text();
        // Try to extract FastAPI's `detail` so the user sees a clean
        // message (e.g. "Whisper extension is not enabled...") rather
        // than the JSON wrapper.
        let detail = body;
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed?.detail === 'string') detail = parsed.detail;
        } catch {
          /* leave raw */
        }
        return { error: `${r.status}: ${detail.slice(0, 240)}` };
      }
      const data = await r.json();
      return {
        text: data.text,
        language: data.language,
        duration_seconds: data.duration_seconds,
        transcribe_ms: data.transcribe_ms,
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
