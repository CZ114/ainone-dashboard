// Diary Zustand store — full Phase 2 surface.
//
// Holds entries, config, agents, secrets and the live stream state.
// One global stream connection is opened by AppBridge so the badge and
// toast updates work even when the user is on /dashboard or /chat.

import { create } from 'zustand';
import {
  diaryApi,
  type AgentConfig,
  type AgentSummary,
  type DiaryConfig,
  type DiaryEntry,
  type DiaryStreamEvent,
  type MainProviderInfo,
  type SecretSummary,
  type TestAgentResponse,
} from '../api/diaryApi';

export interface ToastSignal {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

interface DiaryState {
  // entries
  entries: DiaryEntry[];
  unread: number;
  loading: boolean;
  generating: boolean;
  error: string | null;
  // streaming chunks for the most recent in-flight run, keyed by request_id
  inFlight: { requestId: string; agentId: string; partial: string } | null;
  // last toast signal — pages mount Toast and render this when it changes
  toastSignal: ToastSignal | null;

  // config
  config: DiaryConfig | null;
  configLoading: boolean;

  // main-agent provider info — read from settings.json by backend.
  // Drives AgentEditor's provider lock and DiaryPage's "active provider"
  // badge so users always see what family their diary is in.
  mainProvider: MainProviderInfo | null;

  // agents + secrets
  agents: AgentSummary[];
  secretReferences: Record<string, string[]>;
  secrets: SecretSummary[];
  agentsLoading: boolean;

  // stream
  streamConnected: boolean;

  // entry actions
  loadEntries: () => Promise<void>;
  triggerNow: (agentId?: string) => Promise<DiaryEntry | null>;
  abortGenerating: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  // Returns the new chat handoff payload, or null on failure.
  reply: (id: string) => Promise<{
    cwd: string;
    entry_id: string;
    additional_system_prompt: string;
  } | null>;
  clearError: () => void;
  pushToast: (text: string, kind?: ToastSignal['kind']) => void;
  consumeToast: () => void;

  // config actions
  loadConfig: () => Promise<void>;
  patchConfig: (patch: Partial<DiaryConfig>) => Promise<void>;
  loadMainProvider: () => Promise<void>;

  // agents + secrets actions
  loadAgents: () => Promise<void>;
  upsertAgent: (id: string, agent: AgentConfig) => Promise<void>;
  deleteAgent: (id: string, opts?: { force?: boolean }) => Promise<void>;
  testAgent: (id: string) => Promise<TestAgentResponse>;
  loadSecrets: () => Promise<void>;
  putSecret: (name: string, value: string) => Promise<void>;
  deleteSecret: (name: string) => Promise<void>;

  // stream
  connectStream: () => () => void;
  handleStreamEvent: (e: DiaryStreamEvent) => void;
}

let toastCounter = 0;
const nextToastId = () => Date.now() * 100 + (++toastCounter % 100);

function applyEntry(entries: DiaryEntry[], next: DiaryEntry): DiaryEntry[] {
  const without = entries.filter((e) => e.id !== next.id);
  return [next, ...without];
}

export const useDiaryStore = create<DiaryState>((set, get) => ({
  entries: [],
  unread: 0,
  loading: false,
  generating: false,
  error: null,
  inFlight: null,
  toastSignal: null,

  config: null,
  configLoading: false,
  mainProvider: null,

  agents: [],
  secretReferences: {},
  secrets: [],
  agentsLoading: false,

  streamConnected: false,

  loadEntries: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const { entries, unread } = await diaryApi.listEntries();
      set({ entries, unread, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  triggerNow: async (agentId?: string) => {
    if (get().generating) return null;
    set({ generating: true, error: null });
    try {
      const { entry } = await diaryApi.trigger(agentId);
      // Stream's "new" event already added it; this guards the case where
      // the stream isn't connected (eg. backend didn't emit yet).
      const next = applyEntry(get().entries, entry);
      set({
        generating: false,
        entries: next,
        unread: next.filter((e) => !e.read).length,
      });
      return entry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ generating: false, error: msg });
      get().pushToast(`Diary: ${msg}`, 'error');
      return null;
    }
  },

  abortGenerating: async () => {
    try {
      const r = await diaryApi.abort();
      // Server-side claude process is killed → the in-flight runner
      // throws AgentError("Run aborted") → handleTrigger returns 500.
      // The triggerNow promise will reject and clear generating
      // naturally. Still flip generating off here in case the
      // in-flight fetch is so wedged the rejection is delayed.
      set({ generating: false, inFlight: null });
      get().pushToast(
        r.was_running ? 'Generation cancelled' : 'Nothing was running',
        'info',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      get().pushToast(`Abort failed: ${msg}`, 'error');
    }
  },

  markRead: async (id: string) => {
    // Optimistic — server emits a 'read' event we can ignore for ourselves.
    const next = get().entries.map((e) => (e.id === id ? { ...e, read: true } : e));
    set({ entries: next, unread: next.filter((e) => !e.read).length });
    try {
      await diaryApi.markRead(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      // Revert on failure
      void get().loadEntries();
    }
  },

  deleteEntry: async (id: string) => {
    // Backend rejects unread entries with 409 — guard at the UI layer
    // too so we don't even try.
    const target = get().entries.find((e) => e.id === id);
    if (!target) return;
    if (!target.read) {
      get().pushToast('Mark the entry as read before deleting.', 'error');
      return;
    }
    // Optimistic remove. The server emits a 'deleted' event which we
    // tolerate as a noop (entry already gone from state).
    const next = get().entries.filter((e) => e.id !== id);
    set({ entries: next, unread: next.filter((e) => !e.read).length });
    try {
      await diaryApi.deleteEntry(id);
      get().pushToast('Entry deleted', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      get().pushToast(`Delete failed: ${msg}`, 'error');
      // Reload to restore the entry that we optimistically removed.
      void get().loadEntries();
    }
  },

  reply: async (id: string) => {
    try {
      return await diaryApi.reply(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      get().pushToast(`Reply failed: ${msg}`, 'error');
      return null;
    }
  },

  clearError: () => set({ error: null }),

  pushToast: (text, kind = 'info') => {
    set({ toastSignal: { id: nextToastId(), text, kind } });
  },
  consumeToast: () => set({ toastSignal: null }),

  loadConfig: async () => {
    set({ configLoading: true });
    try {
      const { config } = await diaryApi.getConfig();
      set({ config, configLoading: false });
    } catch (err) {
      set({
        configLoading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  patchConfig: async (patch) => {
    try {
      const { config } = await diaryApi.patchConfig(patch);
      set({ config });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      get().pushToast(`Config save failed: ${msg}`, 'error');
    }
  },

  loadMainProvider: async () => {
    try {
      const info = await diaryApi.getMainProvider();
      set({ mainProvider: info });
    } catch (err) {
      // Non-fatal — UI still functions, just without the lock badge.
      // Log for debug; don't toast (this fires on every page load).
      console.warn('[diary] main-provider fetch failed:', err);
    }
  },

  loadAgents: async () => {
    set({ agentsLoading: true });
    try {
      const [{ agents, secret_references }, { secrets }] = await Promise.all([
        diaryApi.listAgents(),
        diaryApi.listSecrets(),
      ]);
      set({
        agents,
        secretReferences: secret_references,
        secrets,
        agentsLoading: false,
      });
    } catch (err) {
      set({
        agentsLoading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  upsertAgent: async (id, agent) => {
    await diaryApi.upsertAgent(id, agent);
    await get().loadAgents();
  },
  deleteAgent: async (id, opts) => {
    await diaryApi.deleteAgent(id, opts);
    await get().loadAgents();
    await get().loadConfig();
  },
  testAgent: async (id) => {
    return diaryApi.testAgent(id);
  },
  loadSecrets: async () => {
    const { secrets } = await diaryApi.listSecrets();
    set({ secrets });
  },
  putSecret: async (name, value) => {
    await diaryApi.putSecret(name, value);
    await get().loadAgents();
  },
  deleteSecret: async (name) => {
    await diaryApi.deleteSecret(name);
    await get().loadAgents();
  },

  connectStream: () => {
    if (get().streamConnected) {
      // Already connected — return a no-op disposer.
      return () => {};
    }
    set({ streamConnected: true });
    const unsubscribe = diaryApi.connectStream({
      onEvent: get().handleStreamEvent,
      onError: () => {
        set({ streamConnected: false });
      },
    });
    return () => {
      set({ streamConnected: false });
      unsubscribe();
    };
  },

  handleStreamEvent: (event) => {
    switch (event.type) {
      case 'hello':
      case 'heartbeat':
        return;
      case 'started':
        set({
          inFlight: {
            requestId: event.request_id,
            agentId: event.agent_id,
            partial: '',
          },
          generating: event.trigger === 'manual' ? get().generating : true,
        });
        return;
      case 'chunk': {
        const cur = get().inFlight;
        if (cur && cur.requestId === event.request_id) {
          set({ inFlight: { ...cur, partial: cur.partial + event.delta } });
        }
        return;
      }
      case 'new': {
        const next = applyEntry(get().entries, event.entry);
        set({
          entries: next,
          unread: next.filter((e) => !e.read).length,
          inFlight: null,
        });
        const t = event.entry.trigger;
        const label = t === 'cron' ? 'Diary: new daily entry' : 'Diary: new entry';
        get().pushToast(label, 'success');
        // Browser notification — only when:
        //   1. user enabled the toggle in settings
        //   2. permission is granted
        //   3. the user is NOT already on /diary (don't pile redundant
        //      notifications on top of an open timeline)
        try {
          const cfg = get().config;
          if (
            cfg?.notification.browser &&
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted' &&
            (typeof window === 'undefined' ||
              window.location.pathname !== '/diary')
          ) {
            const n = new Notification('📓 Diary', {
              body: event.entry.title || event.entry.body.slice(0, 120),
              tag: 'diary-' + event.entry.id,
            });
            n.onclick = () => {
              window.focus();
              window.location.href = '/diary';
            };
          }
        } catch {
          /* notifications can throw on stricter browsers; non-fatal */
        }
        return;
      }
      case 'error': {
        set({ inFlight: null });
        get().pushToast(`Diary error: ${event.error}`, 'error');
        return;
      }
      case 'read': {
        const next = get().entries.map((e) =>
          e.id === event.entry_id ? { ...e, read: true } : e,
        );
        set({ entries: next, unread: next.filter((e) => !e.read).length });
        return;
      }
      case 'deleted': {
        const next = get().entries.filter((e) => e.id !== event.entry_id);
        set({ entries: next, unread: next.filter((e) => !e.read).length });
        return;
      }
    }
  },
}));
