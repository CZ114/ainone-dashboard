import {
  parseDoctorChatHealth,
  parseDoctorChatResponse,
  type DoctorChatHealth,
  type DoctorChatHistoryMessage,
  type DoctorChatRequest,
  type DoctorChatResponse,
} from '../domain/doctorChat';

const REQUEST_LIMIT_BYTES = 64 * 1024;
const MESSAGE_LIMIT_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;

function apiBase(): string {
  return (import.meta.env.VITE_DOCTOR_CHAT_API_BASE ?? '').trim().replace(/\/$/, '');
}

function endpoint(path: string): string {
  return `${apiBase()}${path}`;
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }
  if (typeof payload === 'string' && payload.trim() && !payload.trim().startsWith('<!')) {
    return payload.trim().slice(0, 300);
  }
  return `HTTP ${status}`;
}

export class DoctorChatApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DoctorChatApiError';
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DoctorChatApiError(
        init.signal?.aborted ? '请求已取消。（Request cancelled.）' : '报告 Agent 请求超时。（Report Agent request timed out.）',
      );
    }
    throw new DoctorChatApiError(
      error instanceof Error ? error.message : '无法连接报告 Agent。（Cannot reach the Report Agent.）',
    );
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}

export async function getDoctorChatHealth(signal?: AbortSignal): Promise<DoctorChatHealth> {
  const response = await fetchWithTimeout(
    endpoint('/api/health'),
    { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' }, signal },
    4_000,
  );
  const payload = await responsePayload(response);
  if (!response.ok) throw new DoctorChatApiError(errorMessage(payload, response.status), response.status);
  try {
    return parseDoctorChatHealth(payload);
  } catch (error) {
    throw new DoctorChatApiError(error instanceof Error ? error.message : '健康接口响应无效。（Invalid health endpoint response.）');
  }
}

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function buildDoctorChatRequest(
  caseId: string,
  message: string,
  history: DoctorChatHistoryMessage[],
): DoctorChatRequest {
  const cleanedCaseId = caseId.trim();
  const cleanedMessage = message.trim();
  if (!cleanedCaseId) throw new DoctorChatApiError('当前病例 ID 无效。（Invalid case ID.）', 400);
  if (!cleanedMessage) throw new DoctorChatApiError('请输入问题。（Please enter a question.）', 400);
  if (cleanedMessage.length > MESSAGE_LIMIT_CHARS) {
    throw new DoctorChatApiError('问题不能超过 2000 个字符。（Questions must not exceed 2000 characters.）', 400);
  }

  const safeHistory = history
    .filter(
      (item) =>
        (item.role === 'user' || item.role === 'assistant') && Boolean(item.content.trim()),
    )
    .slice(-10)
    .map((item) => ({ role: item.role, content: item.content.slice(0, MESSAGE_LIMIT_CHARS) }));
  const request: DoctorChatRequest = {
    case_id: cleanedCaseId,
    message: cleanedMessage,
    history: safeHistory,
  };
  while (request.history?.length && encodedSize(request) > REQUEST_LIMIT_BYTES) {
    request.history.shift();
  }
  if (encodedSize(request) > REQUEST_LIMIT_BYTES) {
    throw new DoctorChatApiError('请求内容超过 64 KiB，无法发送。（Request exceeds 64 KiB and cannot be sent.）', 400);
  }
  return request;
}

export async function askDoctorChat(
  request: DoctorChatRequest,
  signal?: AbortSignal,
): Promise<DoctorChatResponse> {
  const response = await fetchWithTimeout(endpoint('/api/v1/doctor-chat'), {
    method: 'POST',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  const payload = await responsePayload(response);
  if (!response.ok) throw new DoctorChatApiError(errorMessage(payload, response.status), response.status);
  let parsed: DoctorChatResponse;
  try {
    parsed = parseDoctorChatResponse(payload);
  } catch (error) {
    throw new DoctorChatApiError(error instanceof Error ? error.message : 'Chat 响应无效。（Invalid chat response.）');
  }
  if (parsed.case_id !== request.case_id) {
    throw new DoctorChatApiError('报告 Agent 返回了其他病例的上下文，已拒绝显示。（The Report Agent returned context from a different case; display refused.）');
  }
  return parsed;
}