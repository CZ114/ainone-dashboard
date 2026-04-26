// Zustand store for Claude chat state - with proper session continuity

import { create } from 'zustand';
import type { PendingAttachment } from '../lib/attachments';
export type { PendingAttachment } from '../lib/attachments';

// Message types
export interface ChatMessage {
  id: string;
  type: 'chat';
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface SystemMessage {
  id: string;
  type: 'system';
  subtype: 'init' | 'result' | 'error' | 'abort';
  content?: string;
  model?: string;
  session_id?: string;
  tools?: string[];
  cwd?: string;
  permissionMode?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  timestamp: number;
}

export interface ToolMessage {
  id: string;
  type: 'tool';
  toolName: string;
  input?: Record<string, unknown>;
  timestamp: number;
}

export interface ToolResultMessage {
  id: string;
  type: 'tool_result';
  toolName: string;
  content: string;
  summary?: string;
  timestamp: number;
}

export interface ThinkingMessage {
  id: string;
  type: 'thinking';
  content: string;
  timestamp: number;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface TodoMessage {
  id: string;
  type: 'todo';
  todos: TodoItem[];
  timestamp: number;
}

export interface PlanMessage {
  id: string;
  type: 'plan';
  plan: string;
  toolUseId: string;
  timestamp: number;
}

export type AllMessage =
  | ChatMessage
  | SystemMessage
  | ToolMessage
  | ToolResultMessage
  | ThinkingMessage
  | TodoMessage
  | PlanMessage;

// Message input types (without id and timestamp)
export type ChatMessageInput = Omit<ChatMessage, 'id' | 'timestamp'>;
export type SystemMessageInput = Omit<SystemMessage, 'id' | 'timestamp'>;
export type ToolMessageInput = Omit<ToolMessage, 'id' | 'timestamp'>;
export type ThinkingMessageInput = Omit<ThinkingMessage, 'id' | 'timestamp'>;
export type TodoMessageInput = Omit<TodoMessage, 'id' | 'timestamp'>;

export type MessageInput =
  | ChatMessageInput
  | SystemMessageInput
  | ToolMessageInput
  | ThinkingMessageInput
  | TodoMessageInput;

// Session summary from backend
export interface SessionSummary {
  sessionId: string;
  cwd: string;
  firstMessage: string;
  lastMessage: string;
  messageCount: number;
  updatedAt: string;
  // Fork-group metadata: when SDK --resume forks each turn, multiple .jsonl
  // files belong to the same logical conversation (same firstUserMsgId).
  // Backend collapses them into one entry; these fields describe the group.
  isGrouped?: boolean;
  groupSize?: number;
  groupSessions?: string[];
}

// Toolbar selection values. "default" on thinking/effort means "don't
// send the field over the wire" — let the SDK pick the model-native
// default (adaptive thinking on Opus 4.6+, sensible effort per model).
export type PermissionModeValue =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions';
export type ThinkingModeValue = 'default' | 'enabled' | 'disabled';
export type EffortModeValue =
  | 'default'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

// localStorage keys for toolbar persistence
const LS_PERMISSION = 'chat-permission-mode';
const LS_THINKING = 'chat-thinking-mode';
const LS_EFFORT = 'chat-effort-level';
const LS_VOICE_LANG = 'chat-voice-lang';
export const THINKING_BUDGET_TOKENS = 10_000;

// Supported BCP-47 codes for browser SpeechRecognition + backend
// Whisper transcription. Keep this list short and focused on languages
// Claude's users are likely to mix — adding more is cheap later.
export interface VoiceLangOption {
  code: string;          // BCP-47 tag fed to recognition.lang
  label: string;         // "English (UK)" — shown in the picker
  short: string;         // "EN" — shown in the compact button
}
export const VOICE_LANGS: VoiceLangOption[] = [
  { code: 'en-US', label: 'English (US)', short: 'EN' },
  { code: 'en-GB', label: 'English (UK)', short: 'EN' },
  { code: 'zh-CN', label: '中文 (简体)', short: '中' },
  { code: 'zh-TW', label: '中文 (繁體)', short: '中' },
  { code: 'ja-JP', label: '日本語', short: '日' },
  { code: 'ko-KR', label: '한국어', short: '한' },
  { code: 'es-ES', label: 'Español', short: 'ES' },
  { code: 'fr-FR', label: 'Français', short: 'FR' },
  { code: 'de-DE', label: 'Deutsch', short: 'DE' },
];

function loadPermissionMode(): PermissionModeValue {
  try {
    const v = localStorage.getItem(LS_PERMISSION);
    if (v === 'default' || v === 'plan' || v === 'acceptEdits' || v === 'bypassPermissions') {
      return v;
    }
  } catch {
    /* ignore */
  }
  // Preserve historical default: handleSend used to hardcode 'bypassPermissions'.
  return 'bypassPermissions';
}
function loadThinkingMode(): ThinkingModeValue {
  try {
    const v = localStorage.getItem(LS_THINKING);
    if (v === 'default' || v === 'enabled' || v === 'disabled') return v;
  } catch {
    /* ignore */
  }
  return 'default';
}
function loadEffortMode(): EffortModeValue {
  try {
    const v = localStorage.getItem(LS_EFFORT);
    if (v === 'default' || v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max') {
      return v;
    }
  } catch {
    /* ignore */
  }
  return 'default';
}
function loadVoiceLang(): string {
  try {
    const v = localStorage.getItem(LS_VOICE_LANG);
    if (v && VOICE_LANGS.some((l) => l.code === v)) return v;
  } catch {
    /* ignore */
  }
  // Default to the browser's preferred language if it's one of our
  // supported codes; else en-US (broadest Chrome SR coverage).
  const browser = typeof navigator !== 'undefined' ? navigator.language : '';
  const match = VOICE_LANGS.find(
    (l) =>
      l.code === browser ||
      l.code.split('-')[0] === browser.split('-')[0],
  );
  return match?.code || 'en-US';
}
function savePersist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / private mode */
  }
}

interface ChatState {
  messages: AllMessage[];
  input: string;
  isLoading: boolean;
  isThinking: boolean;
  // Session IDs:
  // - sessionId: live session ID from CLI. Changes every turn because
  //   --resume forks on each call; we always adopt the server's latest so
  //   the next turn resumes from the right fork (preserves full context).
  // - displaySessionId: stable label for the current conversation shown in
  //   the UI. Set once when the user enters a session (either sidebar
  //   click or first system/init of a new chat), then never changes until
  //   the user switches conversations. Decouples UI identity from the
  //   churning real session id.
  // - temporarySessionId: frontend-generated temp ID for tracking until CLI responds
  sessionId: string | null;
  displaySessionId: string | null;
  temporarySessionId: string | null;
  // Tracks which requestId last updated the session (for preventing cross-request overwrites)
  lastSessionUpdateRequestId: string | null;
  currentRequestId: string | null;
  error: string | null;
  projects: Array<{ name: string; path: string; encodedName: string }>;
  selectedProject: string | null;
  sessions: SessionSummary[];

  // Chat toolbar state — persisted to localStorage on change.
  permissionMode: PermissionModeValue;
  thinkingMode: ThinkingModeValue;
  effortMode: EffortModeValue;
  // BCP-47 code driving both browser SpeechRecognition and the optional
  // Whisper-local lang hint (passed via /ws/transcribe?lang=...).
  voiceLang: string;

  // File attachments pending the next send. Cleared on send, on
  // session switch, and on /clear. See lib/attachments.ts for shape.
  pendingAttachments: PendingAttachment[];

  // Actions
  addMessage: (msg: MessageInput) => string;
  updateLastMessage: (id: string, content: string) => void;
  setInput: (input: string) => void;
  setIsLoading: (loading: boolean) => void;
  setIsThinking: (thinking: boolean) => void;
  setSessionId: (id: string | null) => void;
  setDisplaySessionId: (id: string | null) => void;
  setTemporarySessionId: (id: string | null) => void;
  /**
   * Replace temporary session ID with real one from backend
   * CRITICAL: Only updates if:
   * 1. There's a temporary session to replace (state.temporarySessionId exists)
   * 2. AND the requestId matches lastSessionUpdateRequestId (prevents concurrent request overwrites)
   */
  replaceTemporarySession: (realSessionId: string, requestId?: string) => void;
  setCurrentRequestId: (id: string | null) => void;
  setError: (error: string | null) => void;
  clearMessages: () => void;
  setProjects: (projects: Array<{ name: string; path: string; encodedName: string }>) => void;
  setSelectedProject: (path: string | null) => void;
  setPermissionMode: (mode: PermissionModeValue) => void;
  setThinkingMode: (mode: ThinkingModeValue) => void;
  setEffortMode: (mode: EffortModeValue) => void;
  setVoiceLang: (code: string) => void;
  addPendingAttachments: (attachments: PendingAttachment[]) => void;
  removePendingAttachment: (id: string) => void;
  clearPendingAttachments: () => void;
  setSessions: (sessions: SessionSummary[]) => void;
  setMessages: (messages: AllMessage[]) => void;
}

let messageCounter = 0;
const generateId = () => `msg_${Date.now()}_${++messageCounter}`;

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  input: '',
  isLoading: false,
  isThinking: false,
  sessionId: null,
  displaySessionId: null,
  temporarySessionId: null,
  lastSessionUpdateRequestId: null,
  currentRequestId: null,
  error: null,
  projects: [],
  selectedProject: null,
  sessions: [],
  permissionMode: loadPermissionMode(),
  thinkingMode: loadThinkingMode(),
  effortMode: loadEffortMode(),
  voiceLang: loadVoiceLang(),
  pendingAttachments: [],

  addMessage: (msg) => {
    const id = generateId();
    const timestamp = Date.now();
    set((state) => ({
      messages: [...state.messages, { ...msg, id, timestamp } as AllMessage],
    }));
    return id;
  },

  updateLastMessage: (id, content) =>
    set((state) => {
      const messages = [...state.messages];
      const index = messages.findIndex((m) => m.id === id);
      if (index !== -1 && messages[index].type === 'chat') {
        messages[index] = { ...messages[index], content } as AllMessage;
      }
      return { messages };
    }),

  setInput: (input) => set({ input }),

  setIsLoading: (isLoading) => set({ isLoading }),

  setIsThinking: (isThinking) => set({ isThinking }),

  setSessionId: (sessionId) => set({ sessionId }),

  setDisplaySessionId: (displaySessionId) => set({ displaySessionId }),

  setTemporarySessionId: (temporarySessionId) => set({ temporarySessionId }),

  /**
   * Adopt the server-reported session_id as the canonical one.
   *
   * Covers three cases:
   * 1. New chat: replaces the frontend-generated temporarySessionId.
   * 2. Continued chat where the SDK forks (resume creates a new session file):
   *    the server returns a new session_id, which must overwrite the old sessionId
   *    so the next send resumes from the fork, not the stale original.
   * 3. Same-id echo: harmless overwrite with the same value.
   *
   * Guard: if requestId is provided and doesn't match the in-flight currentRequestId,
   * drop the update (prevents out-of-order stream chunks from a stale request).
   */
  replaceTemporarySession: (realSessionId, requestId) => {
    const state = get();

    if (requestId && state.currentRequestId && state.currentRequestId !== requestId) {
      console.log('[DEBUG] replaceTemporarySession: skipped (stale request)', {
        current: state.currentRequestId,
        got: requestId,
      });
      return;
    }

    // Pin displaySessionId on the first real id we see for this conversation.
    // Thereafter the live sessionId may fork away, but the UI label stays put.
    const nextDisplay = state.displaySessionId || realSessionId;

    set({
      sessionId: realSessionId,
      displaySessionId: nextDisplay,
      temporarySessionId: null,
      lastSessionUpdateRequestId: requestId || null,
    });
  },

  setCurrentRequestId: (currentRequestId) => set({ currentRequestId }),

  setError: (error) => set({ error }),

  // Clear messages but keep sessionId (so user can continue in same session).
  // Also drops any pending attachments — if the user was about to send
  // them, they probably don't want them applied to the freshly-cleared
  // conversation either.
  clearMessages: () =>
    set({ messages: [], temporarySessionId: null, pendingAttachments: [] }),

  setProjects: (projects) => set({ projects }),

  setSelectedProject: (selectedProject) => set({ selectedProject }),

  setPermissionMode: (permissionMode) => {
    savePersist(LS_PERMISSION, permissionMode);
    set({ permissionMode });
  },

  setThinkingMode: (thinkingMode) => {
    savePersist(LS_THINKING, thinkingMode);
    set({ thinkingMode });
  },

  setEffortMode: (effortMode) => {
    savePersist(LS_EFFORT, effortMode);
    set({ effortMode });
  },

  setVoiceLang: (voiceLang) => {
    savePersist(LS_VOICE_LANG, voiceLang);
    set({ voiceLang });
  },

  addPendingAttachments: (attachments) =>
    set((state) => ({
      pendingAttachments: [...state.pendingAttachments, ...attachments],
    })),

  removePendingAttachment: (id) =>
    set((state) => ({
      pendingAttachments: state.pendingAttachments.filter((a) => a.id !== id),
    })),

  clearPendingAttachments: () => set({ pendingAttachments: [] }),

  setSessions: (sessions) => set({ sessions }),

  setMessages: (messages) => set({ messages }),
}));
