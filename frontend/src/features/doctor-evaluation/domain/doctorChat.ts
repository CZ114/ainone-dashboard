export const DOCTOR_CHAT_STORAGE_KEY = 'advoice-doctor-chat-v1';
export const DOCTOR_CHAT_DISCLAIMER =
  'Screening decision support only; not a diagnosis.';

export type DoctorChatMode = 'demo' | 'llm';
export type DoctorChatConnectionState = 'checking' | 'llm' | 'demo' | 'offline';

export interface DoctorChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DoctorChatMessage extends DoctorChatHistoryMessage {
  id: string;
  mode?: DoctorChatMode;
  model?: string;
  disclaimer?: string;
  fallback?: boolean;
  createdAt: string;
}

export type DoctorChatMessagesByCase = Record<string, DoctorChatMessage[]>;

export interface DoctorChatHealth {
  status: 'ok';
  llm_enabled: boolean;
  model: string;
}

export interface DoctorChatRequest {
  case_id: string;
  message: string;
  history?: DoctorChatHistoryMessage[];
}

export interface DoctorChatResponse {
  answer: string;
  mode: DoctorChatMode;
  model: string;
  case_id: string;
  disclaimer: typeof DOCTOR_CHAT_DISCLAIMER;
}

export function makeDoctorChatMessageId(prefix: 'user' | 'assistant'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDoctorChatHealth(value: unknown): DoctorChatHealth {
  if (
    !isRecord(value) ||
    value.status !== 'ok' ||
    typeof value.llm_enabled !== 'boolean' ||
    typeof value.model !== 'string' ||
    !value.model.trim()
  ) {
    throw new Error('报告 Agent 健康接口返回了不兼容的数据。（Report Agent health endpoint returned incompatible data.）');
  }
  return {
    status: 'ok',
    llm_enabled: value.llm_enabled,
    model: value.model,
  };
}

export function parseDoctorChatResponse(value: unknown): DoctorChatResponse {
  if (
    !isRecord(value) ||
    typeof value.answer !== 'string' ||
    !value.answer.trim() ||
    (value.mode !== 'demo' && value.mode !== 'llm') ||
    typeof value.model !== 'string' ||
    !value.model.trim() ||
    typeof value.case_id !== 'string' ||
    value.disclaimer !== DOCTOR_CHAT_DISCLAIMER
  ) {
    throw new Error('报告 Agent 返回了不符合 Chat Schema 的数据。（Report Agent returned data that does not match the chat schema.）');
  }
  return {
    answer: value.answer,
    mode: value.mode,
    model: value.model,
    case_id: value.case_id,
    disclaimer: value.disclaimer,
  };
}

function isStoredMessage(value: unknown): value is DoctorChatMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.mode === undefined || value.mode === 'demo' || value.mode === 'llm') &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.disclaimer === undefined || typeof value.disclaimer === 'string') &&
    (value.fallback === undefined || typeof value.fallback === 'boolean')
  );
}

export function loadDoctorChatMessages(): DoctorChatMessagesByCase {
  try {
    const raw = window.sessionStorage.getItem(DOCTOR_CHAT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([caseId, messages]) =>
        caseId && Array.isArray(messages) && messages.every(isStoredMessage)
          ? [[caseId, messages]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

export function persistDoctorChatMessages(messages: DoctorChatMessagesByCase): void {
  try {
    window.sessionStorage.setItem(DOCTOR_CHAT_STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Private browsing or a full storage quota must not break evaluation.
  }
}

export function chatHistoryForRequest(
  messages: DoctorChatMessage[],
): DoctorChatHistoryMessage[] {
  return messages
    .filter((message) => message.content.trim())
    .slice(-10)
    .map(({ role, content }) => ({ role, content: content.slice(0, 2000) }));
}