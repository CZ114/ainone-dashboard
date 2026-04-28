// Diary HTTP client. Mirrors claudeApi.ts conventions: relative paths,
// JSON in/out, throw on non-2xx so the store surfaces a single error.
//
// /api/diary/stream is consumed via fetch().body.getReader() (NDJSON),
// not EventSource — this matches /api/chat's wire format.

// ---------- Wire types -------------------------------------------------------

export interface DiaryEntry {
  id: string;
  type: 'observation' | 'question' | 'reminder';
  title: string;
  body: string;
  created_at: string;
  trigger: 'manual' | 'cron' | 'event';
  agent_id: string;
  model: string;
  context_refs: { recordings: string[] };
  read: boolean;
  reply_session_id?: string;
  duration_ms?: number;
  /** Captured for telemetry but intentionally not displayed in the UI. */
  cost_usd?: number;
  tokens?: { input: number; output: number };
  delayed?: boolean;
}

export interface ListEntriesResponse {
  entries: DiaryEntry[];
  total: number;
  unread: number;
}

export interface DiaryDailySchedule {
  time: string;
  agent_id: string;
}

export interface DiaryWeeklySchedule {
  weekday: number;
  time: string;
  agent_id: string;
}

export interface DiaryConfig {
  enabled: boolean;
  schedule: {
    daily?: DiaryDailySchedule;
    weekly?: DiaryWeeklySchedule;
  };
  triggers: {
    on_recording_complete: { enabled: boolean; agent_id?: string };
  };
  notification: {
    browser: boolean;
    quiet_hours?: [string, string];
  };
  daily_quota: number;
  last_run?: {
    daily?: { date: string; entry_id: string };
    weekly?: { date: string; entry_id: string };
  };
}

export interface AgentConfig {
  name: string;
  description?: string;
  model: string;
  env: Record<string, string>;
  system_prompt: string;
  sampling?: {
    temperature?: number;
    max_tokens?: number;
  };
}

export interface AgentSummary {
  id: string;
  agent: AgentConfig;
}

export interface ListAgentsResponse {
  agents: AgentSummary[];
  secret_references: Record<string, string[]>;
}

export interface SecretSummary {
  name: string;
  referenced_by: string[];
}

export interface ListSecretsResponse {
  secrets: SecretSummary[];
}

export interface TestAgentResponse {
  ok: boolean;
  latency_ms: number;
  sample?: string;
  cost_usd?: number;
  error?: string;
}

export interface ReplyResponse {
  /** Real persistent cwd that diary follow-up chats group under. */
  cwd: string;
  /** Echoed for the frontend to render the pinned context card. */
  entry_id: string;
  /**
   * DEAD CODE — see docs/specs/diary.md "Dead code / debt".
   * Built server-side, stashed in the handoff, but not consumed
   * anywhere live. ChatPage now inlines the entry body itself.
   */
  additional_system_prompt: string;
}

// ---------- Stream events ----------------------------------------------------

export type DiaryStreamEvent =
  | { type: 'hello'; t: number }
  | { type: 'heartbeat'; t: number }
  | {
      type: 'started';
      request_id: string;
      agent_id: string;
      trigger: 'manual' | 'cron' | 'event';
      started_at: string;
    }
  | { type: 'chunk'; request_id: string; delta: string }
  | { type: 'new'; request_id: string; entry: DiaryEntry }
  | {
      type: 'error';
      request_id: string;
      error: string;
      stderr_excerpt?: string;
    }
  | { type: 'read'; entry_id: string }
  | { type: 'deleted'; entry_id: string };

// ---------- Client -----------------------------------------------------------

const API_BASE = '';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: string;
        stderr_excerpt?: string;
      };
      if (body?.error) detail = body.error;
      // Tail of claude-cli stderr is a goldmine when the runner
      // times out or claude exits non-zero on a third-party endpoint.
      // Append it so the toast/error banner shows the actual reason.
      if (body?.stderr_excerpt) {
        detail += `\n— stderr —\n${body.stderr_excerpt.slice(-500)}`;
      }
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const diaryApi = {
  // entries
  async listEntries(limit = 50): Promise<ListEntriesResponse> {
    return asJson(await fetch(`${API_BASE}/api/diary/entries?limit=${limit}`));
  },
  async markRead(id: string): Promise<{ entry: DiaryEntry }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/entries/${id}/read`, { method: 'POST' }),
    );
  },
  async deleteEntry(id: string): Promise<{ ok: true; id: string }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/entries/${id}`, { method: 'DELETE' }),
    );
  },
  async reply(id: string): Promise<ReplyResponse> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/entries/${id}/reply`, { method: 'POST' }),
    );
  },

  // trigger
  async trigger(agentId?: string): Promise<{ entry: DiaryEntry }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentId ? { agent_id: agentId } : {}),
      }),
    );
  },
  async abort(): Promise<{ ok: true; was_running: boolean; request_id?: string }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/abort`, { method: 'POST' }),
    );
  },

  // config
  async getConfig(): Promise<{ config: DiaryConfig }> {
    return asJson(await fetch(`${API_BASE}/api/diary/config`));
  },
  async patchConfig(patch: Partial<DiaryConfig>): Promise<{ config: DiaryConfig }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    );
  },

  // agents
  async listAgents(): Promise<ListAgentsResponse> {
    return asJson(await fetch(`${API_BASE}/api/diary/agents`));
  },
  async upsertAgent(id: string, agent: AgentConfig): Promise<{ ok: true }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/agents/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agent),
      }),
    );
  },
  async deleteAgent(
    id: string,
    opts?: { force?: boolean },
  ): Promise<{ ok: true; force_applied?: boolean }> {
    const url = opts?.force
      ? `${API_BASE}/api/diary/agents/${id}?force=1`
      : `${API_BASE}/api/diary/agents/${id}`;
    return asJson(await fetch(url, { method: 'DELETE' }));
  },
  async testAgent(id: string): Promise<TestAgentResponse> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/agents/${id}/test`, { method: 'POST' }),
    );
  },

  // secrets
  async listSecrets(): Promise<ListSecretsResponse> {
    return asJson(await fetch(`${API_BASE}/api/diary/secrets`));
  },
  async putSecret(name: string, value: string): Promise<{ ok: true }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/secrets/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      }),
    );
  },
  async deleteSecret(name: string): Promise<{ ok: true }> {
    return asJson(
      await fetch(`${API_BASE}/api/diary/secrets/${name}`, { method: 'DELETE' }),
    );
  },

  /**
   * Open the NDJSON stream. Returns an unsubscribe fn that closes the
   * underlying reader. Caller pushes events into the store.
   *
   * Errors during the stream are surfaced via the `onError` callback;
   * the connection is not auto-retried — the caller decides.
   */
  connectStream(opts: {
    onEvent: (e: DiaryStreamEvent) => void;
    onError?: (err: Error) => void;
  }): () => void {
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/diary/stream`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`Stream HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              opts.onEvent(JSON.parse(line) as DiaryStreamEvent);
            } catch {
              /* skip bad lines */
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  },
};
