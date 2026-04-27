// Client for the Python backend's extension system (/api/extensions/*).
// Used by Settings → Extensions UI.

// Declarative description of one configurable field, returned by the
// backend so the frontend can render the right widget without bespoke
// per-extension code. Mirrors the schema defined in
// backend/app/extensions/base.py::Extension.get_config_schema.
export interface ExtensionConfigField {
  key: string;
  type: 'select' | 'slider';
  label: string;
  default?: unknown;
  // For type === 'select': at least one of these is set. If both,
  // option_groups wins (renders as <optgroup>); options is fallback
  // for older frontends.
  options?: string[];
  option_groups?: { label: string; options: string[] }[];
  // For type === 'slider':
  min?: number;
  max?: number;
  step?: number;
  requires_reload?: boolean;
  help?: string;
}

// Mirrors backend WhisperLocalExtension._enumerate_cached_models
// (and the generic shape any extension can expose under
// runtime.cached_models). The Settings UI uses this to render a
// per-entry delete button so users can reclaim disk without leaving
// the app.
export interface ExtensionCacheEntry {
  name: string;
  size_bytes: number;
  size_human: string;
  is_active: boolean;
}

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
  // Empty array (or absent for older backends) means the extension
  // exposes no config UI — the panel should be hidden.
  config_schema?: ExtensionConfigField[];
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

  // Delete one cache entry the extension owns (e.g. a downloaded
  // Whisper model). Backend rejects deletion of the currently-active
  // entry — caller should switch first. On success, returns bytes
  // freed; on failure, returns a human-readable message that callers
  // typically surface in a toast.
  deleteCache: async (
    id: string,
    key: string,
  ): Promise<{ freed_human?: string; error?: string }> => {
    try {
      const r = await fetch(
        `${BASE}/api/extensions/${encodeURIComponent(id)}/cache/delete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        },
      );
      if (!r.ok) {
        const txt = await r.text();
        // Try to extract the "detail" field FastAPI produces; fall
        // back to raw text so unexpected errors aren't lost.
        let detail = txt;
        try {
          const obj = JSON.parse(txt);
          if (typeof obj?.detail === 'string') detail = obj.detail;
        } catch { /* leave as raw */ }
        return { error: `${r.status}: ${detail.slice(0, 200)}` };
      }
      const data = (await r.json()) as { freed_human: string };
      return { freed_human: data.freed_human };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  // Send a partial config patch — only the keys present are updated;
  // existing keys not in `patch` are preserved. Backend merges and
  // notifies the running instance. Returns the FULL merged config so
  // callers can drop their pending UI state.
  updateConfig: async (
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ config: Record<string, unknown> | null; error?: string }> => {
    try {
      const r = await fetch(
        `${BASE}/api/extensions/${encodeURIComponent(id)}/config`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      if (!r.ok) {
        const txt = await r.text();
        return {
          config: null,
          error: `HTTP ${r.status}: ${txt.slice(0, 200)}`,
        };
      }
      const data = (await r.json()) as {
        ext_id: string;
        config: Record<string, unknown>;
      };
      return { config: data.config };
    } catch (err) {
      return {
        config: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// Trigger a backend restart (POST /api/system/restart). The backend
// returns 200 immediately and exits ~1 s later, so the caller should:
//   1. Await this call (it will resolve quickly)
//   2. Show a "restarting" overlay / loading state
//   3. Poll some endpoint (e.g. extensionsApi.list) every 1-2 s
//   4. Hide the overlay when a poll succeeds
// On failure, returns an error string instead of throwing.
export async function restartBackend(): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api/system/restart`, { method: 'POST' });
    if (!r.ok) {
      const txt = await r.text();
      return { ok: false, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

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
