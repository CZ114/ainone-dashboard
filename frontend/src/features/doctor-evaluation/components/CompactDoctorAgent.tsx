import { useCallback, useEffect, useRef, useState } from 'react';
import {
  askDoctorChat,
  buildDoctorChatRequest,
  DoctorChatApiError,
  getDoctorChatHealth,
} from '../api/doctorChatApi';
import {
  DOCTOR_CHAT_DISCLAIMER,
  chatHistoryForRequest,
  loadDoctorChatMessages,
  makeDoctorChatMessageId,
  persistDoctorChatMessages,
  type DoctorChatConnectionState,
  type DoctorChatMessage,
  type DoctorChatMessagesByCase,
} from '../domain/doctorChat';
import type { DoctorEvaluationCase } from '../types';

interface CompactDoctorAgentProps {
  studyCase: DoctorEvaluationCase;
  onQuestionAsked: (promptId: string) => void;
  onResponseSettled: () => void;
}

interface PendingRetry {
  question: string;
  promptId: string;
  userMessageId: string;
  assistantMessageId: string;
}

const QUICK_PROMPTS = [
  { id: 'basis', label: '这份报告最主要的依据是什么？' },
  { id: 'uncertainty', label: '哪些结论目前最不确定？' },
  { id: 'next_step', label: '下一步应补充哪些评估？' },
  { id: 'counter_evidence', label: '有没有支持相反判断的证据？' },
];

function localDemoAnswer(question: string, studyCase: DoctorEvaluationCase) {
  const output = studyCase.methodOutputs.find((item) => item.conditionId === 'ours');
  const report = output?.report;
  const nonReferenceStates = output?.evidence?.states
    .filter((state) => state.severity !== 'reference_range')
    .map((state) => `${state.label}（${state.severityLabel}）`)
    .join('、');
  const stateText = nonReferenceStates || '状态卡未显示超出当前参考范围的项目';

  if (/不确定|局限|限制|影响|可靠/.test(question)) {
    return `${report?.limitations || '需要结合任务、听力、语言、教育背景和完整临床资料解释。'}\n\n[依据：采集限制与需复核因素]`;
  }
  if (/下一步|补充|检查|评估|怎么做/.test(question)) {
    return `${report?.recommendation || '建议结合标准化认知量表、日常功能和完整病史进一步评估。'}\n\n[依据：建议的下一步]`;
  }
  if (/相反|反向|保留|正常|排除/.test(question)) {
    return `${report?.counterEvidence || '当前报告没有提供足以排除认知障碍的独立证据。'}\n\n[依据：保留表现与反向证据]`;
  }
  if (/依据|证据|为什么|主要/.test(question)) {
    return `报告的主要结论是：${report?.impression || '未提供筛查结论'}\n\n主要支持信息包括：${report?.summary || stateText}。当前需要重点核查的状态为：${stateText}。\n\n[依据：筛查结论、主要临床表现、状态卡]`;
  }
  return `根据当前条件 C 报告：${report?.impression || '没有可用的筛查结论'} 当前状态提示：${stateText}。对于“${question}”，现有报告没有提供更多独立资料，不能据此补充病史、量表、影像或生物标志物结论。\n\n[依据：当前病例条件 C 报告与状态卡]`;
}

function errorLabel(error: unknown): string {
  if (!(error instanceof DoctorChatApiError)) {
    return error instanceof Error ? error.message : '报告 Agent 请求失败。';
  }
  if (error.status === 400) return `问题格式不正确：${error.message}`;
  if (error.status === 404) return `当前病例或 Chat 接口不可用：${error.message}`;
  if (error.status === 502) return `上游模型暂时不可用：${error.message}`;
  return `无法连接报告 Agent：${error.message}`;
}

const CONNECTION_COPY: Record<
  DoctorChatConnectionState,
  { label: string; className: string }
> = {
  checking: {
    label: '检查 API 状态…',
    className: 'border-card-border bg-card-hover text-text-muted',
  },
  llm: {
    label: '真实模型已连接',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
  },
  demo: {
    label: '服务端演示模式',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  },
  offline: {
    label: '离线 · 本地演示',
    className: 'border-rose-500/30 bg-rose-500/10 text-rose-600',
  },
};

export function CompactDoctorAgent({
  studyCase,
  onQuestionAsked,
  onResponseSettled,
}: CompactDoctorAgentProps) {
  const [messagesByCase, setMessagesByCase] = useState<DoctorChatMessagesByCase>(
    loadDoctorChatMessages,
  );
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [connection, setConnection] = useState<DoctorChatConnectionState>('checking');
  const [model, setModel] = useState<string>();
  const [error, setError] = useState<string>();
  const [pendingRetry, setPendingRetry] = useState<PendingRetry>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const healthAbortRef = useRef<AbortController>();
  const requestAbortRef = useRef<AbortController>();
  const messages = messagesByCase[studyCase.caseId] ?? [];
  const connectionCopy = CONNECTION_COPY[connection];

  const updateMessages = useCallback(
    (updater: (current: DoctorChatMessage[]) => DoctorChatMessage[]) => {
      setMessagesByCase((current) => ({
        ...current,
        [studyCase.caseId]: updater(current[studyCase.caseId] ?? []),
      }));
    },
    [studyCase.caseId],
  );

  useEffect(() => {
    persistDoctorChatMessages(messagesByCase);
  }, [messagesByCase]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const checkConnection = useCallback(async () => {
    healthAbortRef.current?.abort();
    const controller = new AbortController();
    healthAbortRef.current = controller;
    setConnection('checking');
    setError(undefined);
    try {
      const health = await getDoctorChatHealth(controller.signal);
      setConnection(health.llm_enabled ? 'llm' : 'demo');
      setModel(health.model);
    } catch (healthError) {
      if (controller.signal.aborted) return;
      setConnection('offline');
      setModel('local-static-fallback');
      setError(`${errorLabel(healthError)} 已启用明确标记的本地演示回答。`);
    }
  }, []);

  useEffect(() => {
    void checkConnection();
    return () => {
      healthAbortRef.current?.abort();
      requestAbortRef.current?.abort();
    };
  }, [checkConnection]);

  const send = async (
    text: string,
    promptId = 'free_text',
    retry?: PendingRetry,
  ) => {
    const question = text.trim();
    if (!question || loading) return;

    const currentMessages = messagesByCase[studyCase.caseId] ?? [];
    const historySource = retry
      ? currentMessages.filter(
          (message) =>
            message.id !== retry.userMessageId && message.id !== retry.assistantMessageId,
        )
      : currentMessages;
    let request;
    try {
      request = buildDoctorChatRequest(
        studyCase.caseId,
        question,
        chatHistoryForRequest(historySource),
      );
    } catch (requestError) {
      setError(errorLabel(requestError));
      return;
    }

    const userMessageId = retry?.userMessageId ?? makeDoctorChatMessageId('user');
    const assistantMessageId = retry?.assistantMessageId ?? makeDoctorChatMessageId('assistant');
    if (!retry) {
      updateMessages((current) => [
        ...current,
        {
          id: userMessageId,
          role: 'user',
          content: question,
          createdAt: new Date().toISOString(),
        },
      ]);
      onQuestionAsked(promptId);
    }

    setDraft('');
    setLoading(true);
    setError(undefined);
    const controller = new AbortController();
    requestAbortRef.current = controller;

    try {
      const response = await askDoctorChat(request, controller.signal);
      const answer: DoctorChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: response.answer,
        mode: response.mode,
        model: response.model,
        disclaimer: response.disclaimer,
        fallback: false,
        createdAt: new Date().toISOString(),
      };
      updateMessages((current) =>
        retry
          ? current.map((message) => (message.id === assistantMessageId ? answer : message))
          : [...current, answer],
      );
      setConnection(response.mode);
      setModel(response.model);
      setPendingRetry(undefined);
      onResponseSettled();
    } catch (requestError) {
      if (controller.signal.aborted) return;
      const fallback: DoctorChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: localDemoAnswer(question, studyCase),
        mode: 'demo',
        model: 'local-static-fallback',
        disclaimer: DOCTOR_CHAT_DISCLAIMER,
        fallback: true,
        createdAt: new Date().toISOString(),
      };
      updateMessages((current) =>
        retry
          ? current.map((message) => (message.id === assistantMessageId ? fallback : message))
          : [...current, fallback],
      );
      if (!(requestError instanceof DoctorChatApiError) || requestError.status === undefined) {
        setConnection('offline');
        setModel('local-static-fallback');
      }
      setError(`${errorLabel(requestError)} 下方回答来自本地冻结报告，不是真实模型输出。`);
      setDraft(question);
      setPendingRetry({ question, promptId, userMessageId, assistantMessageId });
      onResponseSettled();
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = undefined;
      setLoading(false);
    }
  };

  return (
    <section
      className="flex min-h-[430px] flex-col overflow-hidden rounded-xl border border-card-border bg-card-bg shadow-sm"
      aria-labelledby={`doctor-agent-title-${studyCase.caseId}`}
    >
      <header className="border-b border-card-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-lg" aria-hidden="true">✳</div>
            <div>
              <h2 id={`doctor-agent-title-${studyCase.caseId}`} className="text-sm font-semibold text-text-primary">
                向报告 Agent 询问
              </h2>
              <p className="text-[11px] text-text-muted">仅依据当前病例条件 C 的公开报告证据回答</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${connectionCopy.className}`}>
              {connection === 'checking' && <span className="mr-1 inline-block animate-spin" aria-hidden="true">◌</span>}
              {connectionCopy.label}
            </span>
            <span className="rounded bg-accent/15 px-2 py-1 text-[10px] font-semibold text-accent">条件 C</span>
          </div>
        </div>
        {model && <p className="mt-2 text-[10px] text-text-muted">模型/模式：{model}</p>}
      </header>

      {error && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800" role="alert">
          <p className="leading-5">{error}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {pendingRetry && (
              <button
                type="button"
                disabled={loading}
                onClick={() => void send(pendingRetry.question, pendingRetry.promptId, pendingRetry)}
                className="rounded border border-amber-600/30 bg-card-bg px-2.5 py-1 font-semibold disabled:opacity-50"
              >
                重试真实 Agent
              </button>
            )}
            <button
              type="button"
              disabled={connection === 'checking'}
              onClick={() => void checkConnection()}
              className="rounded border border-amber-600/30 bg-card-bg px-2.5 py-1 font-semibold disabled:opacity-50"
            >
              重新检查连接
            </button>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-window-bg/40 p-3" aria-live="polite">
        {messages.length === 0 && !loading && (
          <div className="rounded-xl border border-dashed border-card-border bg-card-bg/70 p-4 text-center">
            <p className="text-sm font-semibold text-text-primary">尚未询问当前病例</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">可询问主要依据、不确定性、反向证据或下一步评估。</p>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <article
              className={`max-w-[92%] rounded-xl px-3 py-2.5 text-[13px] leading-6 ${
                message.role === 'user'
                  ? 'rounded-br-sm bg-accent text-white'
                  : 'rounded-bl-sm border border-card-border bg-card-bg text-text-primary'
              }`}
            >
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] font-semibold opacity-75">
                <span>{message.role === 'user' ? '医生' : '报告 Agent'}</span>
                {message.role === 'assistant' && message.mode && (
                  <span className="rounded bg-window-bg px-1.5 py-0.5">
                    {message.fallback ? '本地演示' : message.mode === 'llm' ? '真实模型' : '服务端演示'}
                  </span>
                )}
              </div>
              <div className="whitespace-pre-wrap break-words">{message.content}</div>
            </article>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-xl rounded-bl-sm border border-card-border bg-card-bg px-3 py-2.5 text-[13px] text-text-muted" role="status">
              <span className="mr-2 inline-block animate-spin" aria-hidden="true">✳</span>
              正在分析当前病例报告…
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-card-border bg-card-bg p-3">
        <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1" aria-label="快捷问题">
          {QUICK_PROMPTS.map((prompt) => (
            <button
              key={prompt.id}
              type="button"
              onClick={() => void send(prompt.label, prompt.id)}
              disabled={loading}
              className="whitespace-nowrap rounded-full border border-card-border bg-card-hover px-2.5 py-1.5 text-[11px] text-text-secondary transition hover:border-accent/50 disabled:opacity-50"
            >
              {prompt.label}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2 rounded-xl border border-card-border bg-window-bg p-2 focus-within:border-accent/60">
          <label className="sr-only" htmlFor={`doctor-agent-input-${studyCase.caseId}`}>向报告 Agent 提问</label>
          <textarea
            id={`doctor-agent-input-${studyCase.caseId}`}
            value={draft}
            rows={2}
            maxLength={2000}
            placeholder="例如：为什么把停顿判断为异常？这个结论受录音质量影响吗？"
            className="min-h-10 flex-1 resize-none bg-transparent px-1 text-sm text-text-primary outline-none placeholder:text-text-muted"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <button
            type="button"
            onClick={() => void send(draft)}
            disabled={loading || !draft.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {loading ? '分析中…' : '发送'}
          </button>
        </div>
        <div className="mt-1 flex justify-between gap-3 text-[10px] text-text-muted">
          <span>Ctrl/Cmd + Enter 发送；Enter 换行</span>
          <span>{draft.length}/2000</span>
        </div>
        <div className="mt-2 rounded-lg border border-card-border bg-window-bg/70 px-3 py-2 text-[10px] leading-4 text-text-muted">
          <strong className="text-text-secondary">安全提示：</strong>
          本功能仅用于筛查决策支持，不构成诊断。回答不得替代病史、认知量表、日常功能及必要的临床检查。
          <span className="sr-only">{DOCTOR_CHAT_DISCLAIMER}</span>
        </div>
      </div>
    </section>
  );
}