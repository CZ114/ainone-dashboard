/**
 * useCallChat — text-only chat round-trip for the /call page,
 * streaming via the direct-API `/api/voice-chat` endpoint.
 *
 * What changed vs. the original (which proxied through /api/chat):
 *
 *   - Hits a new Hono endpoint that bypasses the Claude CLI
 *     subprocess and the agent SDK, talking to the Anthropic
 *     Messages API directly with `stream: true`. Drops first-byte
 *     latency from ~800–2000 ms to ~200–400 ms.
 *
 *   - Conversation continuity is now done via a `history` array
 *     passed in on every send (no more sticky session-id). The
 *     CallPage owns the `turns` state and forwards it as history.
 *     Resume-from-past-session via the History drawer was the only
 *     consumer of session-id and is paused while we figure out
 *     direct-API session resumption (Anthropic-native sessions
 *     don't exist; we'd need to fetch + replay messages).
 *
 *   - `reply` updates INCREMENTALLY as deltas land. Frontend renders
 *     it live so the user sees Claude type the response. We coalesce
 *     state writes via rAF so we never re-render faster than the
 *     screen refreshes — sub-rAF deltas are batched into one update.
 */

import { useCallback, useRef, useState } from 'react';
import type { PendingAttachment } from '../lib/attachments';
import { buildPromptWithAttachments } from '../lib/attachments';

export type CallChatStatus = 'idle' | 'thinking' | 'replied' | 'error';

/** Message in the format the new endpoint expects. */
export interface CallChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface UseCallChatResult {
  status: CallChatStatus;
  reply: string;
  error: string | null;
  send: (
    text: string,
    attachments?: PendingAttachment[],
    history?: CallChatTurn[],
  ) => Promise<void>;
  reset: () => void;
  /**
   * Compat shim for the History drawer. The direct-API path doesn't
   * have a server-side session to resume — proper resume needs
   * fetching past messages and prepending them to history. For now
   * this is a no-op so the existing UI doesn't break; wiring proper
   * resume is queued.
   */
  setSessionId: (id: string | null) => void;
}

interface DeltaEvent {
  type: 'delta';
  text: string;
}
interface DoneEvent {
  type: 'done';
}
interface ErrorEvent {
  type: 'error';
  message: string;
}
interface SessionEvent {
  type: 'session';
  id: string;
}
type WireEvent = DeltaEvent | DoneEvent | ErrorEvent | SessionEvent;

export function useCallChat(): UseCallChatResult {
  const [status, setStatus] = useState<CallChatStatus>('idle');
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Session id is set when the backend uses the agent SDK fallback
  // path (subscription auth — no API key). Direct-API path doesn't
  // emit one. Either way we just stash it and pass it back on the
  // next send so the SDK can resume the same Claude session and
  // keep prior context server-side.
  const sessionIdRef = useRef<string | undefined>(undefined);

  // rAF-batched setReply: many deltas land per frame; coalesce them
  // into a single state write per animation frame so React doesn't
  // try to render at 100 Hz.
  const pendingTextRef = useRef<string>('');
  const rafIdRef = useRef<number>(0);
  const flushPending = useCallback(() => {
    rafIdRef.current = 0;
    setReply(pendingTextRef.current);
  }, []);
  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current !== 0) return;
    rafIdRef.current = requestAnimationFrame(flushPending);
  }, [flushPending]);

  const send = useCallback(
    async (
      text: string,
      attachments?: PendingAttachment[],
      history?: CallChatTurn[],
    ) => {
      if (!text.trim()) return;
      setStatus('thinking');
      pendingTextRef.current = '';
      setReply('');
      setError(null);

      const finalMessage = buildPromptWithAttachments(text, attachments ?? []);
      // eslint-disable-next-line no-console
      console.log(
        `[useCallChat] send: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}" ` +
          `(+${attachments?.length ?? 0} attachments, history=${history?.length ?? 0})`,
      );

      let res: Response;
      try {
        res = await fetch('/api/voice-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: finalMessage,
            history: history ?? [],
            sessionId: sessionIdRef.current,
            requestId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          }),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
        return;
      }
      if (!res.ok || !res.body) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (typeof j.error === 'string') detail = j.error;
        } catch {
          /* ignore */
        }
        setError(detail);
        setStatus('error');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let evt: WireEvent;
            try {
              evt = JSON.parse(line) as WireEvent;
            } catch {
              continue;
            }
            if (evt.type === 'delta') {
              acc += evt.text;
              pendingTextRef.current = acc;
              scheduleFlush();
            } else if (evt.type === 'session') {
              sessionIdRef.current = evt.id;
            } else if (evt.type === 'error') {
              throw new Error(evt.message);
            } else if (evt.type === 'done') {
              break;
            }
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[useCallChat] stream error:', e);
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
        return;
      }

      // Final flush so the very last delta (if it landed in the same
      // microtask as the close) is committed before we mark replied.
      if (rafIdRef.current !== 0) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      const finalText = acc.trim();
      if (!finalText) {
        setError('Empty reply from Claude');
        setStatus('error');
        return;
      }
      setReply(finalText);
      setStatus('replied');
      // eslint-disable-next-line no-console
      console.log(
        `[useCallChat] final reply: "${finalText.slice(0, 120)}${finalText.length > 120 ? '…' : ''}" (${finalText.length} chars)`,
      );
    },
    [scheduleFlush],
  );

  const reset = useCallback(() => {
    if (rafIdRef.current !== 0) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
    pendingTextRef.current = '';
    setStatus('idle');
    setReply('');
    setError(null);
  }, []);

  const setSessionId = useCallback((id: string | null) => {
    sessionIdRef.current = id ?? undefined;
  }, []);

  return { status, reply, error, send, reset, setSessionId };
}
