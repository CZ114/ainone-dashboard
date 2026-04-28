// Chat Messages component - displays all message types with agent states

import { useState, useEffect, useRef } from 'react';
import type {
  AllMessage,
  ChatMessage,
  SystemMessage,
  ToolMessage,
  ToolResultMessage,
  ThinkingMessage,
  TodoMessage,
  TodoItem,
  PermissionRequestMessage,
} from '../../store/chatStore';
import { useChatStore } from '../../store/chatStore';
import { claudeApi } from '../../api/claudeApi';
import { MessageMarkdown } from './MessageMarkdown';

interface ChatMessagesProps {
  messages: AllMessage[];
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// Collapsible details component for expandable content
function CollapsibleDetails({
  label,
  details,
  defaultExpanded = false,
  children,
}: {
  label: string;
  details?: string;
  defaultExpanded?: boolean;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="border border-card-border rounded-lg overflow-hidden mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 bg-card-bg hover:bg-card-border/30 text-left flex items-center justify-between text-sm transition-colors"
      >
        <span className="font-medium text-text-secondary">{label}</span>
        <span className="text-text-muted">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 bg-window-bg">
          {details && (
            <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono overflow-x-auto">
              {details}
            </pre>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

// Chat message (user/assistant text)
function ChatMessageComponent({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? 'bg-accent text-white'
            : 'bg-card-bg border border-card-border'
        }`}
      >
        <div className={`text-xs font-semibold mb-1 ${isUser ? 'text-white' : 'text-text-muted'}`}>
          {isUser ? 'You' : 'Claude'}
        </div>
        {/* Markdown body — renders headings / lists / tables / code
            fences / **bold** / links the way Claude actually writes
            them. Replaces the old plaintext <pre> that ate every
            structural cue. variant tunes colours for the user's blue
            bubble vs the assistant's neutral one. */}
        <MessageMarkdown
          content={message.content}
          variant={isUser ? 'user' : 'assistant'}
        />
        <div className={`text-xs mt-1 ${isUser ? 'text-white' : 'text-text-muted'}`}>
          {formatTimestamp(message.timestamp)}
        </div>
      </div>
    </div>
  );
}

// System message (init, result, error)
function SystemMessageComponent({ message }: { message: SystemMessage }) {
  if (message.subtype === 'init') {
    return (
      <div className="mb-3">
        <CollapsibleDetails label="Session Info" details={
          `Model: ${message.model || 'Unknown'}\nSession: ${message.session_id?.slice(0, 8) || 'Unknown'}...\nTools: ${message.tools?.length || 0} available\nCWD: ${message.cwd || 'Unknown'}\nMode: ${message.permissionMode || 'default'}`
        } />
      </div>
    );
  }

  if (message.subtype === 'result') {
    return (
      <div className="mb-3">
        <CollapsibleDetails
          label="Result"
          details={`Duration: ${message.duration_ms}ms | Cost: $${message.total_cost_usd?.toFixed(4) || '0'}`}
          defaultExpanded={false}
        >
          {message.content && (
            <div className="mt-2 text-sm text-text-secondary">
              {message.content}
            </div>
          )}
        </CollapsibleDetails>
      </div>
    );
  }

  if (message.subtype === 'error') {
    return (
      <div className="mb-3 p-3 bg-red-500/20 border border-red-500/50 rounded-lg">
        <div className="text-red-400 text-sm font-medium">Error</div>
        <div className="text-red-300 text-xs mt-1">{message.content}</div>
      </div>
    );
  }

  return null;
}

// Pull the most informative single field out of a tool's input so the
// collapsed bubble shows the *what* (the command, file, query) rather
// than just a list of key names. Falls back to a key-name preview.
function summarizeToolInput(
  toolName: string,
  input?: Record<string, unknown>,
): string {
  if (!input) return '';
  const pick = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === 'string' ? v : undefined;
  };
  const truncate = (s: string, n = 80) =>
    s.length > n ? s.slice(0, n - 1) + '…' : s;
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

  switch (toolName) {
    case 'Bash':
    case 'BashOutput': {
      const v = pick('command') ?? pick('description');
      if (v) return truncate(oneLine(v));
      break;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const v = pick('file_path') ?? pick('notebook_path');
      if (v) return truncate(v, 100);
      break;
    }
    case 'Grep': {
      const p = pick('pattern');
      const path = pick('path');
      if (p) return truncate(path ? `${p}  in ${path}` : p);
      break;
    }
    case 'Glob': {
      const v = pick('pattern');
      if (v) return truncate(v);
      break;
    }
    case 'WebFetch': {
      const v = pick('url');
      if (v) return truncate(v, 100);
      break;
    }
    case 'WebSearch': {
      const v = pick('query');
      if (v) return truncate(v);
      break;
    }
    case 'Task': {
      const v = pick('description') ?? pick('prompt');
      if (v) return truncate(oneLine(v));
      break;
    }
  }
  // Fallback: first 3 keys with short stringified values.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input).slice(0, 3)) {
    let s: string;
    if (typeof v === 'string') s = v;
    else if (v == null) s = String(v);
    else s = JSON.stringify(v);
    parts.push(`${k}=${truncate(oneLine(s), 40)}`);
  }
  return parts.join(', ');
}

// Tool message (Claude is using a tool) — collapsed by default; expand
// to inspect the full input JSON that was sent to the tool.
function ToolMessageComponent({ message }: { message: ToolMessage }) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeToolInput(message.toolName, message.input);
  const fullJson = message.input
    ? JSON.stringify(message.input, null, 2)
    : '(no input)';

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%] w-full rounded-lg bg-emerald-500/10 border border-emerald-500/30 overflow-hidden">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full px-4 py-3 text-left flex items-start gap-2 hover:bg-emerald-500/15 transition-colors"
        >
          <span className="text-lg leading-tight">🔧</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold text-emerald-400">{message.toolName}</span>
              <span className="text-text-muted text-xs ml-auto">{expanded ? '▼' : '▶'}</span>
            </div>
            {summary && (
              <div className="text-xs text-emerald-300/80 mt-1 font-mono break-all">
                {summary}
              </div>
            )}
          </div>
        </button>
        {expanded && (
          <div className="px-4 py-2 bg-window-bg border-t border-emerald-500/20">
            <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono overflow-x-auto">
              {fullJson}
            </pre>
            {message.toolUseId && (
              <div className="text-[10px] text-text-muted mt-2 font-mono">
                id: {message.toolUseId}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Tool result (output / error returned by a tool). Collapsed by default
// for non-errors so the conversation stays scannable; auto-expanded
// when is_error so failures stand out.
function ToolResultMessageComponent({ message }: { message: ToolResultMessage }) {
  const isError = message.isError === true;
  const [expanded, setExpanded] = useState(isError);
  const text = message.content || '(empty result)';
  // First non-empty line is usually the meaningful summary; truncate.
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const preview =
    firstLine.length > 100 ? firstLine.slice(0, 99) + '…' : firstLine;

  const accent = isError
    ? 'bg-red-500/10 border-red-500/40'
    : 'bg-slate-500/10 border-slate-500/30';
  const label = isError
    ? 'text-red-400'
    : 'text-slate-300';

  return (
    <div className="flex justify-start mb-3">
      <div className={`max-w-[80%] w-full rounded-lg border overflow-hidden ${accent}`}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full px-4 py-2 text-left flex items-start gap-2 hover:bg-white/5 transition-colors"
        >
          <span className="text-base leading-tight">{isError ? '⚠️' : '↩️'}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-xs">
              <span className={`font-semibold ${label}`}>
                {isError ? 'Tool error' : 'Tool result'}
                {message.toolName ? ` · ${message.toolName}` : ''}
              </span>
              <span className="text-text-muted ml-auto">{expanded ? '▼' : '▶'}</span>
            </div>
            {!expanded && preview && (
              <div className="text-xs text-text-secondary mt-1 font-mono truncate">
                {preview}
              </div>
            )}
          </div>
        </button>
        {expanded && (
          <div className="px-4 py-2 bg-window-bg border-t border-white/5">
            <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono overflow-x-auto max-h-96">
              {text}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// AskUserQuestion — Claude's built-in "ask the human a multi-choice
// question" tool. Native Claude clients render this as a real picker
// rather than a JSON dump, so we do the same: each question becomes a
// labeled card with radio (single-select) or checkbox (multi-select)
// option cards. Keyboard support comes free via semantic <input>:
//   - Tab/Shift-Tab moves focus between options
//   - Space toggles a checkbox; arrow keys navigate radios
//   - Cmd/Ctrl+Enter submits
//
// Wire-wise we route the answer back through the canUseTool deny
// channel (SDK has no first-class "the user answered" return shape).
// Claude reads the deny `message` as the user's input.

interface AskOption {
  label: string;
  description?: string;
}
interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

function parseAskInput(input: Record<string, unknown> | undefined): AskQuestion[] | null {
  if (!input || !Array.isArray((input as { questions?: unknown }).questions)) {
    return null;
  }
  const raw = (input as { questions: unknown[] }).questions;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') return null;
    const qo = q as Record<string, unknown>;
    if (typeof qo.question !== 'string' || !Array.isArray(qo.options)) return null;
    const opts: AskOption[] = [];
    for (const o of qo.options) {
      if (!o || typeof o !== 'object') return null;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== 'string') return null;
      opts.push({
        label: oo.label,
        description: typeof oo.description === 'string' ? oo.description : undefined,
      });
    }
    if (opts.length === 0) return null;
    out.push({
      question: qo.question,
      header: typeof qo.header === 'string' ? qo.header : undefined,
      options: opts,
      multiSelect: qo.multiSelect === true,
    });
  }
  // Empty `questions` array — treat as malformed; fall through to the
  // generic Allow/Deny UI so the user isn't stuck with a no-op picker.
  if (out.length === 0) return null;
  return out;
}

function formatAskAnswer(questions: AskQuestion[], selections: Set<number>[]): string {
  const lines: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const sel = selections[i];
    const picked = q.options
      .filter((_, idx) => sel.has(idx))
      .map((o) => o.label);
    const label = q.header || q.question;
    lines.push(`${label}: ${picked.length > 0 ? picked.join(', ') : '(no selection)'}`);
  }
  return lines.join('\n');
}

// VS Code-style compact picker: numbered rows, keyboard-first.
//
// Layout — every option is a single line so the whole list is scannable:
//   ▸ 1  VS Code      — Lightweight editor
//     2  JetBrains    — WebStorm / IntelliJ
//     3  Vim
//
// Keys (with focus inside the picker, not in the textarea):
//   ↑/↓        move the cursor inside the active question
//   1-9        pick option N in the active question (toggle for multi)
//   Space      toggle option at cursor (multi only)
//   Enter      single-select: pick + advance; multi-select: submit if ready
//   Tab/⇧+Tab  jump to the next/previous question
//   Esc        if textarea is focused, blur it back to the list
//   Cmd/Ctrl+Enter  submit from anywhere
//
// The textarea below the list is a fallback: typing anything there
// overrides the selections and is sent verbatim as the user's answer.

function AskUserQuestionPicker({
  questions,
  disabled,
  onSubmit,
}: {
  questions: AskQuestion[];
  disabled: boolean;
  onSubmit: (formatted: string, summary: string) => void;
}) {
  const [selections, setSelections] = useState<Set<number>[]>(() =>
    questions.map(() => new Set<number>()),
  );
  const [activeQ, setActiveQ] = useState(0);
  const [cursors, setCursors] = useState<number[]>(() => questions.map(() => 0));
  const [custom, setCustom] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus the picker root on mount so keyboard works immediately
  // without the user having to click into the bubble first.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const setCursor = (qi: number, oi: number) => {
    setCursors((prev) => {
      const next = prev.slice();
      next[qi] = oi;
      return next;
    });
  };

  const pick = (qi: number, oi: number) => {
    if (disabled) return;
    setSelections((prev) => {
      const next = prev.map((s) => new Set(s));
      const cur = next[qi];
      if (questions[qi].multiSelect) {
        if (cur.has(oi)) cur.delete(oi);
        else cur.add(oi);
      } else {
        cur.clear();
        cur.add(oi);
      }
      return next;
    });
    setCursor(qi, oi);
  };

  const allAnswered = selections.every((s) => s.size > 0);
  const hasCustom = custom.trim().length > 0;

  const submit = () => {
    if (disabled) return;
    if (hasCustom) {
      // Free-form override: send the typed answer as-is, no per-question
      // formatting. Mirrors how a CLI prompt accepts a typed reply.
      const text = custom.trim();
      onSubmit(text, text);
      return;
    }
    if (!allAnswered) return;
    const formatted = formatAskAnswer(questions, selections);
    const summary = formatted.replace(/\n/g, '; ');
    onSubmit(formatted, summary);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl+Enter always submits, no matter where focus is.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    // Esc in the textarea bails focus back to the option list.
    if (e.target === textareaRef.current && e.key === 'Escape') {
      e.preventDefault();
      textareaRef.current?.blur();
      rootRef.current?.focus();
      return;
    }
    // Option-list shortcuts only fire when the picker root has focus.
    // Tab moves to textarea then to Submit natively; once focus leaves
    // the root, we hand keyboard control over so Enter on the Submit
    // button submits and typing in the textarea types.
    if (e.target !== rootRef.current) return;

    const q = questions[activeQ];
    if (!q) return;
    const cursor = cursors[activeQ];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Wrap across questions so ↓ at the last option of Q1 jumps into
      // Q2's first option, mirroring how a single combined list would
      // behave. Stops at the very last option (no wrap to top) so the
      // user gets a natural "I'm done" cue.
      if (cursor < q.options.length - 1) {
        setCursor(activeQ, cursor + 1);
      } else if (activeQ < questions.length - 1) {
        const nextQ = activeQ + 1;
        setActiveQ(nextQ);
        setCursor(nextQ, 0);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cursor > 0) {
        setCursor(activeQ, cursor - 1);
      } else if (activeQ > 0) {
        const prevQ = activeQ - 1;
        setActiveQ(prevQ);
        setCursor(prevQ, questions[prevQ].options.length - 1);
      }
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      pick(activeQ, cursor);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(activeQ, cursor);
      // Single-select advances; multi stays so the user can keep
      // toggling. Final submit goes through Cmd/Ctrl+Enter, Tab to
      // Submit + Enter, or the button — this avoids stale-state
      // races that would bite if we tried to auto-submit on the last
      // question's first Enter.
      if (!q.multiSelect && activeQ < questions.length - 1) {
        setActiveQ(activeQ + 1);
      }
    } else if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      if (idx < q.options.length) {
        e.preventDefault();
        pick(activeQ, idx);
      }
    }
    // Tab is intentionally NOT handled here — let the browser move
    // focus naturally: root → textarea → Submit button.
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="px-4 py-3 space-y-3 outline-none focus:ring-1 focus:ring-accent/40 dark:focus:ring-accent-soft/40"
    >
      {questions.map((q, qi) => {
        const isActive = qi === activeQ;
        const cursor = cursors[qi];
        const sel = selections[qi];
        return (
          <div
            key={qi}
            onMouseDown={() => setActiveQ(qi)}
            className={[
              'pl-2 border-l-2',
              isActive
                ? 'border-accent dark:border-accent-soft'
                : 'border-transparent',
            ].join(' ')}
          >
            <div className="mb-1 flex items-baseline gap-2 text-xs">
              {q.header && (
                <span className="uppercase tracking-wide text-text-muted">
                  {q.header}
                </span>
              )}
              <span className="text-text-primary">{q.question}</span>
              <span className="text-[10px] text-text-muted ml-auto">
                {q.multiSelect ? 'multi · space toggles' : 'pick one'}
              </span>
            </div>
            <ul className="space-y-0.5">
              {q.options.map((opt, oi) => {
                const isSelected = sel.has(oi);
                const isCursor = isActive && cursor === oi;
                return (
                  <li
                    key={oi}
                    onMouseDown={(e) => {
                      // mousedown (not click) so the picker's keyboard
                      // focus isn't stolen by the row taking focus.
                      e.preventDefault();
                      setActiveQ(qi);
                      pick(qi, oi);
                      rootRef.current?.focus();
                    }}
                    className={[
                      'flex items-center gap-2 px-2 py-1 rounded text-sm cursor-pointer select-none',
                      isCursor
                        ? 'bg-card-hover'
                        : 'hover:bg-card-hover/60',
                      disabled ? 'opacity-50 cursor-not-allowed' : '',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'inline-flex items-center justify-center w-5 h-5 text-[10px] font-mono rounded',
                        isSelected
                          ? 'bg-emerald-600 text-white'
                          : 'bg-window-bg border border-card-border text-text-muted',
                      ].join(' ')}
                    >
                      {isSelected ? '✓' : oi + 1}
                    </span>
                    <span className="text-text-primary">{opt.label}</span>
                    {opt.description && (
                      <span className="text-xs text-text-muted truncate">
                        — {opt.description}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      <div className="pt-1">
        <textarea
          ref={textareaRef}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          rows={2}
          disabled={disabled}
          placeholder="Or type a custom reply… (overrides picks; Enter to submit)"
          className="w-full text-xs font-mono bg-window-bg border border-card-border rounded p-2 text-text-primary focus:outline-none focus:border-accent"
        />
      </div>

      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <button
          type="button"
          disabled={disabled || (!allAnswered && !hasCustom)}
          onClick={submit}
          className="px-3 py-1.5 text-xs rounded bg-accent hover:bg-accent text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-accent-soft"
        >
          {hasCustom ? 'Send reply' : 'Submit'}
        </button>
        <span className="hidden sm:inline">
          ↑↓ move · 1–9 pick · Tab to Submit · Cmd/Ctrl+Enter sends
        </span>
        <span className="ml-auto">
          Q {activeQ + 1}/{questions.length}
        </span>
      </div>
    </div>
  );
}

// Permission request — Claude is paused mid-turn waiting for the user
// to allow or deny a specific tool call. Bubble stays in place after
// the decision is sent (collapses to a status line) so the chat history
// keeps a record of what the user approved or rejected.
function PermissionRequestComponent({
  message,
}: {
  message: PermissionRequestMessage;
}) {
  const setPermissionDecision = useChatStore((s) => s.setPermissionDecision);
  const [showInput, setShowInput] = useState(false);
  const [denying, setDenying] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const decided = message.decided;
  const isPending = decided.status === 'pending';
  const summary = summarizeToolInput(message.toolName, message.input);
  const fullJson = message.input
    ? JSON.stringify(message.input, null, 2)
    : '(no input)';
  const hasSuggestions =
    Array.isArray(message.suggestions) && message.suggestions.length > 0;

  const send = async (
    nextDecided: Exclude<PermissionRequestMessage['decided'], { status: 'pending' }>,
    body: Parameters<typeof claudeApi.respondPermission>[1],
  ) => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    // Wait for the backend to confirm — the SDK is paused and a failed
    // response means it's still paused, so flipping the bubble's status
    // optimistically would be a lie. Only commit after success.
    const ok = await claudeApi.respondPermission(message.permissionId, body);
    setSubmitting(false);
    if (ok) {
      setPermissionDecision(message.permissionId, nextDecided);
    } else {
      setSubmitError(
        'Backend did not accept the decision (request may have already been resolved).',
      );
    }
  };

  const onAllowOnce = () =>
    send({ status: 'allowed', always: false }, { behavior: 'allow' });

  const onAllowAlways = () =>
    send(
      { status: 'allowed', always: true },
      {
        behavior: 'allow',
        acceptedSuggestions: message.suggestions,
      },
    );

  const onDenySubmit = () => {
    const msg = denyReason.trim() || 'Denied by user.';
    void send(
      { status: 'denied', message: msg },
      { behavior: 'deny', message: msg },
    );
  };

  // Special-case AskUserQuestion: render an interactive picker rather
  // than the generic Allow/Deny pair. Claude expects this tool's
  // "result" to be the user's selection, so we pipe the chosen labels
  // back via the deny-message channel (which the SDK feeds to Claude
  // verbatim). Falls back to the generic UI if the input shape is
  // unexpected.
  const askQuestions =
    message.toolName === 'AskUserQuestion'
      ? parseAskInput(message.input)
      : null;
  const onAskSubmit = (formatted: string, summary: string) => {
    void send(
      { status: 'answered', summary },
      { behavior: 'deny', message: formatted },
    );
  };

  // Header copy — prefer the SDK's pre-rendered title when present.
  const isAsk = askQuestions !== null;
  const headerTitle = isAsk
    ? 'Claude is asking you a question'
    : message.title ||
      `Claude wants to run ${message.displayName || message.toolName}`;

  // Visual: neutral card with a thin colored left rule — the amber/blue
  // accent is just a hint of intent (warning for permission, info for
  // ask-user-question), not the dominant fill. Keeps these bubbles
  // visually consistent with the rest of the chat (which uses card-bg).
  const accentRule = isAsk
    ? 'border-l-2 border-l-accent dark:border-l-accent-soft'
    : 'border-l-2 border-l-amber-500 dark:border-l-amber-400';
  const cardCls = `bg-card-bg border border-card-border ${accentRule}`;
  const headerBorder = 'border-card-border';
  const titleCls = 'text-text-primary';
  const bodyCls = 'text-text-secondary';
  const mutedBodyCls = 'text-text-muted';
  const codeCls = 'text-text-secondary';
  const stripCls = '';

  return (
    <div className="flex justify-start mb-3">
      <div className={`max-w-[80%] w-full rounded-lg overflow-hidden ${cardCls}`}>
        <div className={`px-4 py-3 border-b ${headerBorder}`}>
          <div className="flex items-start gap-2">
            <span className="text-lg leading-tight">{isAsk ? '🙋' : '🔐'}</span>
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-semibold ${titleCls}`}>
                {headerTitle}
              </div>
              {!isAsk && message.description && (
                <div className={`text-xs mt-1 ${bodyCls}`}>
                  {message.description}
                </div>
              )}
              {!isAsk && message.decisionReason && (
                <div className={`text-xs mt-1 italic ${mutedBodyCls}`}>
                  {message.decisionReason}
                </div>
              )}
              {!isAsk && summary && (
                <div className={`text-xs mt-2 font-mono break-all ${codeCls}`}>
                  {summary}
                </div>
              )}
              {!isAsk && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowInput((v) => !v)}
                    className={`text-[11px] mt-2 hover:underline ${mutedBodyCls}`}
                  >
                    {showInput ? '▼ Hide full input' : '▶ Show full input'}
                  </button>
                  {showInput && (
                    <pre className="mt-2 text-xs text-text-secondary whitespace-pre-wrap font-mono overflow-x-auto bg-window-bg p-2 rounded border border-card-border max-h-64">
                      {fullJson}
                    </pre>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {isPending && isAsk && askQuestions && (
          <>
            <AskUserQuestionPicker
              questions={askQuestions}
              disabled={submitting}
              onSubmit={onAskSubmit}
            />
            {submitError && (
              <div className="px-4 py-2 text-xs text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-500/10 border-t border-red-400 dark:border-red-500/30">
                {submitError}
              </div>
            )}
          </>
        )}

        {isPending && !isAsk && !denying && (
          <>
            <div className={`px-4 py-2 flex flex-wrap items-center gap-2 ${stripCls}`}>
              <button
                type="button"
                disabled={submitting}
                onClick={onAllowOnce}
                className="px-3 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50"
              >
                Allow once
              </button>
              {hasSuggestions && (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={onAllowAlways}
                  className="px-3 py-1.5 text-xs rounded bg-emerald-800 hover:bg-emerald-700 text-white font-medium disabled:opacity-50"
                  title="Apply the SDK's suggested rule so this won't be asked again."
                >
                  Allow always
                </button>
              )}
              <button
                type="button"
                disabled={submitting}
                onClick={() => setDenying(true)}
                className="px-3 py-1.5 text-xs rounded bg-red-600 hover:bg-red-500 text-white font-medium disabled:opacity-50"
              >
                Deny
              </button>
              <span className={`text-[11px] ml-auto ${mutedBodyCls}`}>
                {submitting ? 'Sending…' : 'Claude is waiting…'}
              </span>
            </div>
            {submitError && (
              <div className="px-4 py-2 text-xs text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-500/10 border-t border-red-400 dark:border-red-500/30">
                {submitError}
              </div>
            )}
          </>
        )}

        {isPending && !isAsk && denying && (
          <div className={`px-4 py-3 space-y-2 ${stripCls}`}>
            <label className={`text-xs block ${bodyCls}`}>
              Reply to Claude (sent back as the deny reason — leave blank for the default):
            </label>
            <textarea
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              rows={3}
              className="w-full text-xs font-mono bg-window-bg border border-card-border rounded p-2 text-text-primary focus:outline-none focus:border-accent"
              placeholder="e.g. Don't run rm here — clean up via git instead."
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={onDenySubmit}
                className="px-3 py-1.5 text-xs rounded bg-red-600 hover:bg-red-500 text-white font-medium disabled:opacity-50"
              >
                Send rejection
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  setDenying(false);
                  setDenyReason('');
                }}
                className="px-3 py-1.5 text-xs rounded bg-window-bg border border-card-border hover:border-text-secondary text-text-secondary"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {!isPending && (
          <div className={`px-4 py-2 text-xs flex items-center gap-2 ${stripCls}`}>
            {decided.status === 'allowed' && (
              <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                ✓ Allowed{decided.always ? ' (always)' : ''}
              </span>
            )}
            {decided.status === 'answered' && (
              <span className="text-emerald-700 dark:text-emerald-400 font-medium truncate">
                ✓ Answered — {decided.summary}
              </span>
            )}
            {decided.status === 'denied' && (
              <span className="text-red-700 dark:text-red-400 truncate font-medium">
                ✗ Denied — {decided.message}
              </span>
            )}
            {decided.status === 'aborted' && (
              <span className="text-text-muted italic">
                Request was no longer pending; click had no effect.
              </span>
            )}
            <span className="text-text-muted ml-auto">
              {formatTimestamp(message.timestamp)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Thinking message (Claude's reasoning)
function ThinkingMessageComponent({ message }: { message: ThinkingMessage }) {
  return (
    <div className="mb-3">
      <CollapsibleDetails
        label="💭 Reasoning"
        details={message.content}
        defaultExpanded={true}
      />
    </div>
  );
}

// Todo message (TodoWrite tool)
function TodoMessageComponent({ message }: { message: TodoMessage }) {
  const getStatusIcon = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed': return '✅';
      case 'in_progress': return '🔄';
      case 'pending': return '⏳';
    }
  };

  const getStatusColor = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed': return 'text-green-400';
      case 'in_progress': return 'text-accent-soft';
      case 'pending': return 'text-gray-400';
    }
  };

  const completed = message.todos.filter(t => t.status === 'completed').length;

  return (
    <div className="mb-3">
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
        <div className="text-sm font-semibold text-amber-400 mb-2">
          📋 Todo List ({completed}/{message.todos.length})
        </div>
        <div className="space-y-1">
          {message.todos.map((todo, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span>{getStatusIcon(todo.status)}</span>
              <span className={getStatusColor(todo.status)}>{todo.content}</span>
              {todo.status === 'in_progress' && todo.activeForm && (
                <span className="text-xs text-amber-300/70 italic">({todo.activeForm})</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Loading indicator
export function LoadingIndicator() {
  return (
    <div className="flex justify-start mb-3">
      <div className="rounded-lg px-4 py-3 bg-card-bg border border-card-border">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span className="animate-pulse">Claude is thinking...</span>
        </div>
      </div>
    </div>
  );
}

// Main ChatMessages component
export function ChatMessages({ messages }: ChatMessagesProps) {
  if (messages.length === 0) {
    return (
      // Self-contained vertical centering — min-h-[60vh] gives the
      // empty state a definite height regardless of parent layout
      // (the actual ChatPage parent is a block-level wrapper without
      // h-full, so we can't rely on h-full cascading down).
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <div className="text-6xl mb-4">💬</div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">
          Start a conversation
        </h2>
        <p className="text-text-muted max-w-md">
          Send a message to Claude Code. You can ask questions, request code reviews,
          or get help with your ESP32 sensor project.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {messages.map((msg) => {
        switch (msg.type) {
          case 'chat':
            return <ChatMessageComponent key={msg.id} message={msg} />;
          case 'system':
            return <SystemMessageComponent key={msg.id} message={msg} />;
          case 'tool':
            return <ToolMessageComponent key={msg.id} message={msg} />;
          case 'tool_result':
            return <ToolResultMessageComponent key={msg.id} message={msg} />;
          case 'permission_request':
            return <PermissionRequestComponent key={msg.id} message={msg} />;
          case 'thinking':
            return <ThinkingMessageComponent key={msg.id} message={msg} />;
          case 'todo':
            return <TodoMessageComponent key={msg.id} message={msg} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
