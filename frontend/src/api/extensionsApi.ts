// Client for the Python backend's extension system (/api/extensions/*).
// Used by Settings → Extensions UI.

export interface ExtensionStatus {
  id: string;
  name: string;
  description: string;
  version: string;
  installed: boolean;
  enabled: boolean;
  installing: boolean;
  installed_at: string | null;
  config: Record<string, unknown>;
  last_error: string | null;
  runtime?: Record<string, unknown>;
}

export interface ExtensionListResponse {
  extensions: ExtensionStatus[];
}

// Each event emitted by the SSE install-progress stream.
export type InstallProgressEvent =
  | { kind: 'log'; line: string }
  | { kind: 'progress'; pct: number }
  | { kind: 'done'; success: boolean; error: string | null };

const BASE = '';

export const extensionsApi = {
  list: async (): Promise<{ extensions: ExtensionStatus[]; error?: string }> => {
    try {
      const r = await fetch(`${BASE}/api/extensions`);
      const raw = await r.text();
      if (!r.ok) {
        return {
          extensions: [],
          error: `HTTP ${r.status}: ${raw.slice(0, 200)}`,
        };
      }
      const data: ExtensionListResponse = raw
        ? JSON.parse(raw)
        : { extensions: [] };
      return { extensions: data.extensions || [] };
    } catch (err) {
      return {
        extensions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  get: async (id: string): Promise<{ ext: ExtensionStatus | null; error?: string }> => {
    try {
      const r = await fetch(`${BASE}/api/extensions/${encodeURIComponent(id)}`);
      if (!r.ok) return { ext: null, error: `HTTP ${r.status}` };
      return { ext: (await r.json()) as ExtensionStatus };
    } catch (err) {
      return { ext: null, error: err instanceof Error ? err.message : String(err) };
    }
  },

  install: async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch(
        `${BASE}/api/extensions/${encodeURIComponent(id)}/install`,
        { method: 'POST' },
      );
      if (!r.ok) {
        const txt = await r.text();
        return { ok: false, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  // Open an EventSource for live progress. Returns the EventSource so
  // caller can `.close()` on unmount. The `onEvent` callback is invoked
  // on every parsed JSON message.
  openProgressStream: (
    id: string,
    onEvent: (evt: InstallProgressEvent) => void,
    onError?: (err: Event) => void,
  ): EventSource => {
    const src = new EventSource(
      `${BASE}/api/extensions/${encodeURIComponent(id)}/install-progress`,
    );
    src.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as InstallProgressEvent;
        onEvent(data);
      } catch {
        /* ignore malformed */
      }
    };
    if (onError) src.onerror = onError;
    return src;
  },

  enable: async (id: string) => _simplePost(`${BASE}/api/extensions/${id}/enable`),
  disable: async (id: string) => _simplePost(`${BASE}/api/extensions/${id}/disable`),
  uninstall: async (id: string) => _simplePost(`${BASE}/api/extensions/${id}/uninstall`),
};

async function _simplePost(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(url, { method: 'POST' });
    if (!r.ok) {
      const txt = await r.text();
      return { ok: false, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
