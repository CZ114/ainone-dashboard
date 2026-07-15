/**
 * useDemoConversation — drives the /call page through a scripted
 * conversation without touching mic / Whisper / Claude.
 *
 * What it does, per turn:
 *
 *   1. Phase override → 'recording'  (orb turns 'listening')
 *   2. wait recordMs
 *   3. Phase override → 'transcribing'  (orb turns 'thinking')
 *   4. wait transcribeMs
 *   5. Append user turn  (CallPage's `turns.length > 0` morph fires;
 *                          the user bubble lands inside the card)
 *   6. Phase override → 'thinking'  (ThinkingLoader visible)
 *   7. wait thinkMs
 *   8. Append assistant turn  (AssistantBubble + convergeWords kicks
 *                              in via the existing render path)
 *   9. Phase override → 'replying'  (orb turns 'speaking')
 *   10. wait readMs (≈ reply length × per-char ms) + postReplyPauseMs
 *   11. next turn, or finish → reset phase override to null + idle
 *
 * The host (CallPage) supplies setters for `turns` and the phase
 * override. The hook owns the timeline + cancellation. Stop or
 * unmount aborts cleanly without leaving the orb in a stale state.
 *
 * Reading speed: ~28 ms/char is roughly 'fast read aloud' pace for
 * Chinese; the convergeWords animation runs faster than that, so the
 * dwell is dominated by reading rather than animation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEMO_CONVERSATION_ZH,
  type DemoChartSpec,
  type DemoTurn,
} from '../lib/demoConversation';

type Phase =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'replying'
  | 'error';

interface ScriptTurn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** Files the AI consulted for this assistant turn. Forwarded into
   *  the host's Turn record so a "Consulted" panel can stay attached
   *  to the bubble after the live reading panel unmounts. */
  files?: string[];
  /** Optional inline line-chart spec rendered below the bubble. */
  chart?: DemoChartSpec;
}

export interface UseDemoConversationOptions {
  /** Append a turn to the host's conversation list. */
  appendTurn: (turn: ScriptTurn) => void;
  /** Wipe the host's conversation list (called at start). */
  clearTurns: () => void;
  /** Drive the host's phase override. `null` releases the override
   *  back to the live state machine. */
  setPhaseOverride: (phase: Phase | null) => void;
  /** Override the script. Defaults to the zh version; CallPage
   *  passes the language-matched array via `getDemoConversation`. */
  script?: DemoTurn[];
  /** ms-per-char dwell after the assistant reply lands, on top of
   *  postReplyPauseMs. Used as a fallback when no `waitForReplyEnd`
   *  callback is supplied. */
  msPerChar?: number;
  /** Async dwell after the assistant turn lands, before the next
   *  turn's recording phase. CallPage passes a function that:
   *    1. plays the pre-recorded MP3 at `audioUrl` if present, or
   *    2. falls through to live TTS, or
   *    3. falls through to a char-based reading estimate.
   *  Whichever path runs, the Promise resolves only when the listener
   *  has had time to absorb the reply — so the next user turn doesn't
   *  step on top of audio still playing. When the option is omitted
   *  entirely, the player uses `text.length × msPerChar`. */
  waitForReplyEnd?: (turn: {
    text: string;
    audioUrl?: string;
  }) => Promise<void>;
}

export interface UseDemoConversationResult {
  /** True while the demo is mid-playback. */
  running: boolean;
  /** Index of the turn currently being played (0-based), or null. */
  turnIndex: number | null;
  /** Kick off (or restart) the demo from turn 0. Cancels any prior run. */
  start: () => void;
  /** Cancel an in-flight demo. Releases the phase override; the host's
   *  turns array is left as-is so the user can scroll back through
   *  what played. */
  stop: () => void;
}

// Per-char dwell after the assistant reply lands. 18 ms/char is brisk
// "skim-read" pace — the watcher catches the gist, the demo doesn't
// linger. Bump back toward 28 if the demo lands too fast to follow.
const DEFAULT_MS_PER_CHAR = 18;

export function useDemoConversation({
  appendTurn,
  clearTurns,
  setPhaseOverride,
  script = DEMO_CONVERSATION_ZH,
  msPerChar = DEFAULT_MS_PER_CHAR,
  waitForReplyEnd,
}: UseDemoConversationOptions): UseDemoConversationResult {
  const [running, setRunning] = useState(false);
  const [turnIndex, setTurnIndex] = useState<number | null>(null);

  // Cancellation token — flipped to true by stop() (or unmount); each
  // await checks it before continuing. Refs not state so an inflight
  // setTimeout doesn't race a stale closure.
  const cancelledRef = useRef(false);
  // Pending sleep timer so stop() can fast-forward out of a wait.
  const timerRef = useRef<number | null>(null);

  // Stash the wait callback in a ref so the running timeline always
  // reaches the latest implementation — without triggering a teardown
  // of the in-flight `start()` closure when CallPage's TTS state
  // (which the callback closes over) changes mid-demo.
  const waitForReplyEndRef = useRef<typeof waitForReplyEnd>(waitForReplyEnd);
  useEffect(() => {
    waitForReplyEndRef.current = waitForReplyEnd;
  }, [waitForReplyEnd]);

  const sleep = useCallback((ms: number): Promise<void> => {
    return new Promise((resolve) => {
      if (cancelledRef.current) {
        resolve();
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        resolve();
      }, ms);
    });
  }, []);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPhaseOverride(null);
    setRunning(false);
    setTurnIndex(null);
  }, [setPhaseOverride]);

  const start = useCallback(() => {
    // Cancel any prior run, then reset the cancellation token.
    cancelledRef.current = true;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    cancelledRef.current = false;
    clearTurns();
    setRunning(true);
    setTurnIndex(0);

    void (async () => {
      let nextId = Date.now();
      try {
        for (let i = 0; i < script.length; i++) {
          if (cancelledRef.current) return;
          setTurnIndex(i);
          const turn = script[i];

          setPhaseOverride('recording');
          await sleep(turn.recordMs);
          if (cancelledRef.current) return;

          setPhaseOverride('transcribing');
          await sleep(turn.transcribeMs);
          if (cancelledRef.current) return;

          // Drop the user transcript. CallPage's morph keys off
          // `turns.length > 0`, so this is the frame the orb morphs
          // into the chat card.
          appendTurn({
            id: nextId++,
            role: 'user',
            text: turn.user,
          });

          setPhaseOverride('thinking');
          await sleep(turn.thinkMs);
          if (cancelledRef.current) return;

          appendTurn({
            id: nextId++,
            role: 'assistant',
            text: turn.ai,
            files: turn.files,
            chart: turn.chart,
          });
          setPhaseOverride('replying');

          // Dwell on the reply: when the host has supplied a
          // wait-for-reply callback (CallPage does, hooked to TTS),
          // we await it and let voice playback set the pace; the
          // next turn doesn't kick until the AI has finished talking.
          // When no callback is supplied (or TTS is off inside it),
          // fall back to a char-based estimate of reading time.
          const waitFn = waitForReplyEndRef.current;
          if (waitFn) {
            await waitFn({ text: turn.ai, audioUrl: turn.audioUrl });
          } else {
            await sleep(turn.ai.length * msPerChar);
          }
          if (cancelledRef.current) return;
          await sleep(turn.postReplyPauseMs);
          if (cancelledRef.current) return;
        }
      } finally {
        if (!cancelledRef.current) {
          // Clean finish — release the phase override so the orb
          // settles back to idle and the chat card stays expanded.
          setPhaseOverride(null);
          setRunning(false);
          setTurnIndex(null);
        }
      }
    })();
  }, [script, sleep, appendTurn, clearTurns, setPhaseOverride, msPerChar]);

  // Unmount cleanup — same as stop(), guarded so a pending setTimeout
  // doesn't fire after the component is gone.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return { running, turnIndex, start, stop };
}
