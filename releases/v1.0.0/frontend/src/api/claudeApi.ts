// Claude API client for chat functionality

// Wire types — keep in sync with backend/shared/types.ts. Duplicated to
// avoid cross-module import paths between frontend and backend source
// trees (no monorepo package layer yet).
export type EffortLevelWire = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingConfigWire =
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }
  | { type: 'adaptive' };

export interface ChatRequest {
  message: string;
  requestId: string;
  sessionId?: string;
  allowedTools?: string[];
  workingDirectory?: string;
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  // Optional SDK knobs driven by the ChatInputTools toolbar. Omit both
  // to let the SDK/model apply native defaults.
  effort?: EffortLevelWire;
  thinking?: ThinkingConfigWire;
}

// Response from POST /api/system/pick-file — matches backend handler.
export type PickedFileKind = 'text' | 'image' | 'other';
export interface PickedFile {
  path: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  kind: PickedFileKind;
  content?: string;
}

// GET /api/slash-commands response — matches backend DiscoveredCommand.
export type DiscoveredCommandSource =
  | 'user-commands'
  | 'user-skills'
  | 'project-commands'
  | 'project-skills'
  | 'plugin-commands'
  | 'plugin-skills';
export interface DiscoveredCommand {
  name: string;                  // "/claude-api"
  description: string;
  source: DiscoveredCommandSource;
  filepath: string;
  argumentHint?: string;
}

export interface StreamResponse {
  type: 'claude_json' | 'error' | 'done' | 'aborted';
  data?: unknown;
  error?: string;
}

export interface ProjectInfo {
  path: string;
  encodedName: string;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  firstMessage: string;
  lastMessage: string;
  messageCount: number;
  updatedAt: string;
  isGrouped?: boolean;
  groupSize?: number;
  groupSessions?: string[];
}

const API_BASE = '';

export const claudeApi = {
  sendMessage: async function* (body: ChatRequest): AsyncGenerator<StreamResponse> {
    const response = await fetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      yield { type: 'error', error: `HTTP error: ${response.status}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line) as StreamResponse;
              yield parsed;
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }

      // Process any remaining buffer content
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer) as StreamResponse;
          yield parsed;
        } catch {
          // Skip malformed JSON
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  abortRequest: async (requestId: string): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/api/abort/${requestId}`, {
        method: 'POST',
      });
      return response.ok;
    } catch {
      return false;
    }
  },

  getProjects: async (): Promise<ProjectInfo[]> => {
    try {
      const response = await fetch(`${API_BASE}/api/projects`);
      if (!response.ok) return [];
      const data = await response.json();
      return data.projects || [];
    } catch {
      return [];
    }
  },

  // Session management (using Claude's session files)
  getSessions: async (projectPath?: string): Promise<SessionSummary[]> => {
    try {
      const url = projectPath
        ? `${API_BASE}/api/sessions?project=${encodeURIComponent(projectPath)}`
        : `${API_BASE}/api/sessions`;
      console.log('[API] getSessions fetching:', url);
      const response = await fetch(url);
      console.log('[API] getSessions response status:', response.status);
      const data = await response.json();
      console.log('[API] getSessions data:', data);
      return data.sessions || [];
    } catch (err) {
      console.error('[API] getSessions error:', err);
      return [];
    }
  },

  deleteSession: async (sessionId: string): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      return response.ok;
    } catch {
      return false;
    }
  },

  createProject: async (path: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await fetch(`${API_BASE}/api/projects/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await response.json();
      if (!response.ok) {
        return { success: false, error: data.error || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  pickFile: async (
    opts: { multiple?: boolean; initialDir?: string; includeContent?: boolean; maxContentBytes?: number } = {},
  ): Promise<{ files: PickedFile[]; error?: string }> => {
    try {
      const response = await fetch(`${API_BASE}/api/system/pick-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          multiple: opts.multiple ?? false,
          initialDir: opts.initialDir || '',
          includeContent: opts.includeContent ?? true,
          maxContentBytes: opts.maxContentBytes ?? 50 * 1024,
        }),
      });
      // Defensive parse — same rationale as pickFolder (old backend
      // without this route returns plaintext 404 and .json() throws a
      // cryptic "Unexpected end of JSON input").
      const raw = await response.text();
      let data: { files?: PickedFile[]; error?: string } = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          return {
            files: [],
            error:
              `Backend returned non-JSON (HTTP ${response.status}): ` +
              (raw.slice(0, 120) || '<empty body>') +
              `. If you just added this feature, restart the backend.`,
          };
        }
      }
      if (!response.ok) {
        return { files: [], error: data.error || `HTTP ${response.status}` };
      }
      return { files: data.files || [], error: data.error };
    } catch (err) {
      return { files: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  pickFolder: async (initialDir?: string): Promise<{ path: string | null; error?: string }> => {
    try {
      const response = await fetch(`${API_BASE}/api/system/pick-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialDir: initialDir || '' }),
      });
      // Guard against non-JSON responses (e.g. old backend without this
      // route returns plaintext "Not Found" via Hono's default 404).
      // Reading as text first lets us surface a clear message instead
      // of the opaque "Unexpected end of JSON input" from .json().
      const raw = await response.text();
      let data: { path?: string | null; error?: string } = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          return {
            path: null,
            error:
              `Backend returned non-JSON (HTTP ${response.status}): ` +
              (raw.slice(0, 120) || '<empty body>') +
              `. If you just added this feature, restart the backend.`,
          };
        }
      }
      if (!response.ok) {
        return { path: null, error: data.error || `HTTP ${response.status}` };
      }
      return { path: data.path ?? null, error: data.error };
    } catch (err) {
      return { path: null, error: err instanceof Error ? err.message : String(err) };
    }
  },

  deleteProject: async (cwd: string): Promise<{ success: boolean; deletedJsonlCount?: number; error?: string }> => {
    try {
      const response = await fetch(`${API_BASE}/api/projects`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      const data = await response.json();
      if (!response.ok) {
        return { success: false, error: data.error || `HTTP ${response.status}` };
      }
      return { success: true, deletedJsonlCount: data.deletedJsonlCount };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  // Discover user + project skills/commands on disk. Returns only the
  // dynamic set — frontend still owns local UI built-ins like /clear
  // and /modes.
  listSlashCommands: async (cwd?: string): Promise<{ commands: DiscoveredCommand[]; error?: string }> => {
    try {
      const url =
        `${API_BASE}/api/slash-commands` +
        (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '');
      const response = await fetch(url);
      const raw = await response.text();
      let data: { commands?: DiscoveredCommand[]; error?: string } = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          return {
            commands: [],
            error:
              `Backend returned non-JSON (HTTP ${response.status}): ` +
              (raw.slice(0, 120) || '<empty body>') +
              `. If you just added this feature, restart the backend.`,
          };
        }
      }
      if (!response.ok) {
        return { commands: [], error: data.error || `HTTP ${response.status}` };
      }
      return { commands: data.commands || [] };
    } catch (err) {
      return { commands: [], error: err instanceof Error ? err.message : String(err) };
    }
  },

  // (Removed: launchTerminal REST call. Terminal is now embedded via
  // WebSocket — see frontend/src/components/shell/EmbeddedTerminal.tsx
  // and backend/claude/handlers/shell.ts. No HTTP shim needed because
  // the browser opens the WS directly.)

  // Expand a discovered command into a prompt the frontend can send
  // via /api/chat. `args` is the substring following the command name
  // in the textarea (e.g. for "/review PR-123" args="PR-123").
  expandSlashCommand: async (
    name: string,
    args: string,
    cwd?: string,
  ): Promise<{ prompt: string | null; error?: string }> => {
    try {
      const response = await fetch(`${API_BASE}/api/slash-commands/expand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args, cwd: cwd || '' }),
      });
      const data = await response.json();
      if (!response.ok) {
        return { prompt: null, error: data.error || `HTTP ${response.status}` };
      }
      return { prompt: data.prompt };
    } catch (err) {
      return { prompt: null, error: err instanceof Error ? err.message : String(err) };
    }
  },

  getSessionMessages: async (sessionId: string): Promise<{ messages: Array<{type: string; role: string; content: string; timestamp: string}>; cwd?: string }> => {
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`);
      if (!response.ok) return { messages: [] };
      const data = await response.json();
      return { messages: data.messages || [], cwd: data.cwd };
    } catch {
      return { messages: [] };
    }
  },
};
