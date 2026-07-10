/**
 * CallPage — voice-call surface with persistent multi-turn chat.
 *
 * Latest design pass:
 *   - Conversation card has TWO shapes that morph into each other:
 *     compact (idle, single-line placeholder) and expanded
 *     (rectangular, scrollable, multi-turn history). The morph is a
 *     CSS `transition-all` so the two states feel like one element.
 *   - Conversation history (`turns`) accumulates across the call —
 *     no auto-collapse. The user's transcript and Claude's reply are
 *     each pushed once when finalised; resetting only the in-flight
 *     state (callChat.status, transcriber.state) doesn't wipe history.
 *   - Assistant messages render through `MessageMarkdown` (the same
 *     component the chat page uses), so headings, lists, code fences,
 *     **bold**, and tables all look right. User messages stay plain.
 *   - The latest assistant message animates in via a fade + upward
 *     translate on its container — chosen over per-char convergence
 *     because per-char doesn't compose cleanly with the markdown DOM
 *     tree.
 *   - Card auto-scrolls to its bottom whenever a new turn lands.
 *
 * State machine (visible to the user via orb colour):
 *
 *   idle ─PTT/VAD onset─▶ recording ─PTT up/VAD silence─▶ transcribing
 *      ▲                                                     │
 *      │                              text non-empty          ▼
 *      │                                            thinking  (calling Claude)
 *      │                                                     │
 *      │                                          reply ready ▼
 *      │                                            replying  (history grows)
 *      │                                                     │
 *      └──────── back to idle, history persists  ◀───────────┘
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang, useT } from '../../contexts/LanguageContext';
import { useAudioLevel, type AudioSource } from '../../hooks/useAudioLevel';
import { useTranscriber } from '../../hooks/useTranscriber';
import { useVad } from '../../hooks/useVad';
import { useCallChat } from '../../hooks/useCallChat';
import { useChatStore, VOICE_LANGS } from '../../store/chatStore';
import { MessageMarkdown } from '../chat/MessageMarkdown';
import { RecordingsPanel } from '../chat/RecordingsPanel';
import type { RecordingDragPayload } from '../chat/RecordingsPanel';
import { recordingsApi } from '../../api/recordingsApi';
import { claudeApi, type SessionSummary } from '../../api/claudeApi';
import {
  RECORDING_DRAG_MIME,
  formatSize,
  iconForKind,
  type PendingAttachment,
} from '../../lib/attachments';
import { Orb, type OrbState } from './Orb';
import { Waveform } from './Waveform';
import { Starfield } from './Starfield';
import { ThinkingLoader } from './ThinkingLoader';
import { ReadingDataLoader } from './ReadingDataLoader';
import { MiniLineChart } from './MiniLineChart';
import { isDemoMode } from '../../lib/demoMode';
import { useDemoConversation } from '../../hooks/useDemoConversation';
import { getDemoConversation } from '../../lib/demoConversation';
import { useTextToSpeech } from '../../hooks/useTextToSpeech';

type TriggerMode = 'ptt' | 'vad';

/** One conversation turn. The `id` is used as React key so the latest
 *  assistant message animates in once; a brand-new id means a brand-new
 *  DOM element, which is what the on-mount transition relies on.
 *
 *  `files` is set on assistant turns by the demo player when the
 *  scripted turn declares a file list — it lets the conversation view
 *  render a persistent "Consulted N files" panel attached to that AI
 *  turn so the watcher can scroll back through the call and see what
 *  was read at each step. `chart` is the optional inline line chart
 *  spec rendered below the bubble. Live (non-demo) AI turns leave
 *  both undefined and only the bubble + markdown renders. */
interface Turn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  files?: string[];
  chart?: import('../../lib/demoConversation').DemoChartSpec;
}

export default function CallPage() {
  const navigate = useNavigate();
  const t = useT();
  const { lang } = useLang();
  const voiceLang = useChatStore((s) => s.voiceLang);
  const setVoiceLang = useChatStore((s) => s.setVoiceLang);

  const [source, setSource] = useState<AudioSource>('synthetic');
  const [trigger, setTrigger] = useState<TriggerMode>('ptt');
  const [pttHeld, setPttHeld] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);

  // Demo mode: when VITE_DEMO_MODE=1, the user can click "Play demo"
  // to run a scripted conversation through the same render path the
  // live call uses. While the demo is running we override the phase
  // computed below so the orb morphs through recording / transcribing
  // / thinking / replying without any mic capture or Claude calls.
  // `demoPhase = null` means the live state machine is in charge.
  const demo = isDemoMode();
  const [demoPhase, setDemoPhase] = useState<
    'idle' | 'recording' | 'transcribing' | 'thinking' | 'replying' | 'error' | null
  >(null);

  // Pending attachments — files the user has dropped onto the orb
  // since their last send. Cleared after a send completes.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Drop-zone visual state.
  const [dragOver, setDragOver] = useState(false);
  const [absorbing, setAbsorbing] = useState(false);
  // Recordings drawer (right side) and History drawer (left side).
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Past sessions for the simple History drawer. Lazy-fetched the
  // first time the drawer opens so the call page boots fast.
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [resumedSessionLabel, setResumedSessionLabel] = useState<string | null>(null);
  // Drag-enter/leave fire on every child boundary, so we count depth
  // to know when the cursor truly leaves the drop zone.
  const dragDepthRef = useRef(0);

  const { levelRef, status: audioStatus } = useAudioLevel(source);

  const callChat = useCallChat();

  // Push the user's transcript onto the conversation history before
  // we kick the chat round-trip. Doing it here (instead of inside
  // useTranscriber) keeps the hook source-agnostic and lets the page
  // own conversation state.
  const transcriber = useTranscriber({
    source,
    lang: voiceLang || undefined,
    onFinalized: (text) => {
      // Snapshot attachments at send time and clear immediately so
      // the user sees the chips disappear (signal that the message
      // actually went out with them).
      const attsAtSend = attachments;
      // Build history BEFORE the setTurns call. We use the closure-
      // captured `turns` value because:
      //   1. setState updater functions MUST be pure — calling
      //      `callChat.send` inside one runs twice under React 18
      //      StrictMode (it double-invokes updaters to catch impurity)
      //      → two API calls → two duplicated assistant replies.
      //      That was the "every message replied twice" bug.
      //   2. `turns` here is fresh because useTranscriber stores
      //      `onFinalized` in a ref and re-binds on every render, so
      //      whichever closure fires has the latest state.
      const history = turns.map((tn) => ({
        role: tn.role,
        content: tn.text,
      }));
      setTurns((prev) => [
        ...prev,
        { id: Date.now(), role: 'user' as const, text },
      ]);
      void callChat.send(text, attsAtSend, history);
      setAttachments([]);
    },
  });

  // Demo audio synth — while the scripted player is in 'recording'
  // mode, write speech-like RMS/peak values straight into levelRef.
  // The orb (springs read levelRef.rms) and the waveform (bars read
  // levelRef.peak) both pulse off the same ref, so a single rAF
  // here drives both visuals without touching either component.
  //
  // Signal shape:
  //   utterance — slow ~1 cycle/sec breath-like envelope, sets the
  //               overall volume the speaker is running at
  //   syllable — fast ~3.5 cycles/sec sharp bursts, gives the
  //               percussive "speaking" feel (consonant attacks)
  //   noiseEnvelope — every ~600 ms reseeds a slow target so the
  //               loop never lands on identical frames; without
  //               this the demo visibly cycles after ~3 seconds
  //   jitter — per-frame ±0.18 noise, enough to keep adjacent
  //               waveform bars uneven without going jittery-flat
  //
  // High floor (0.45) keeps the orb visibly engaged through "between
  // syllables" gaps so it doesn't look like the recording dropped.
  // RMS lerps fast (0.45 step) so the springs really move; bigger
  // step trades oscillation for visible pulse, which is what the
  // demo wants.
  //
  // Outside the recording phase we let the natural audio source
  // (synthetic / mic / esp32) resume — we don't reset levelRef on
  // teardown, so the next animation frame after stop just reads
  // whatever the live source last wrote.
  useEffect(() => {
    if (demoPhase !== 'recording') return;
    let raf = 0;
    const t0 = performance.now();
    let envelopeTarget = 0.7;
    let envelopeNow = 0.7;
    let nextEnvelopeAt = 0;
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      // Reseed slow envelope every 500–900 ms so the loop never
      // visibly repeats over the demo's recording window.
      if (t * 1000 >= nextEnvelopeAt) {
        envelopeTarget = 0.55 + Math.random() * 0.4; // 0.55..0.95
        nextEnvelopeAt = t * 1000 + 500 + Math.random() * 400;
      }
      envelopeNow += (envelopeTarget - envelopeNow) * 0.04;

      const utterance = 0.5 + 0.5 * Math.sin(t * 1.1);
      const syllable = Math.max(0, Math.sin(t * 22));
      const sharp = Math.pow(syllable, 0.4); // 0.4 keeps bursts wide
      const baseAmp = 0.55 + utterance * 0.45 * envelopeNow; // 0.55..1.0
      const jitter = (Math.random() - 0.5) * 0.18;
      const peak = Math.max(0.45, Math.min(1, baseAmp * sharp + jitter));
      const prevRms = levelRef.current.rms;
      const target = 0.45 + peak * 0.5; // 0.45..0.95
      const rms = prevRms + (target - prevRms) * 0.45;
      levelRef.current = { rms, peak };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [demoPhase, levelRef]);

  // Demo player — feeds scripted turns into setTurns + setDemoPhase.
  // The hook is always mounted (even outside demo mode) so its
  // unmount cleanup can guard runaway timers; the `running` flag
  // stays false until `start()` is called, so there's zero cost
  // when the user never opens demo mode. Declared above useVad so
  // the VAD enabled-flag (and the PTT handlers below) can reference
  // `demoPlayer.running` to bypass real mic capture mid-demo.
  // TTS — reads the latest committed assistant reply aloud when the
  // user has the toggle on. Uses Web Speech API; no backend cost.
  const tts = useTextToSpeech();

  // Cache the script object so the demo player + ReadingDataLoader
  // lookup share the same array identity. Without useMemo each
  // render rebuilds the script (cheap but unnecessary churn).
  const demoScript = useMemo(() => getDemoConversation(lang), [lang]);

  // Hand the demo player a "wait for reply consumed" callback. Order
  // of resolution, top to bottom:
  //   1. If the turn has a pre-recorded `audioUrl` (and the user
  //      hasn't muted via 🔊), play the MP3 and resolve on the
  //      <audio>'s `ended` event. Pre-recorded files are the
  //      best-quality path — generated once externally via whatever
  //      TTS service the user prefers — and skip every runtime cost.
  //   2. If audio fails to load (404 / decode error / network) OR no
  //      `audioUrl` was supplied, fall through to live TTS (Edge-TTS
  //      via the backend, with Web Speech as its own fallback).
  //   3. If the user has muted, use a char-based reading estimate so
  //      the demo still paces correctly without sound.
  //
  // `pendingDemoAudioRef` holds the currently-playing <audio> element
  // so the Stop demo button can pause it cleanly. Storing the resolver
  // alongside lets Stop also unblock the awaiting Promise immediately
  // — without it the demo loop would sit on `audio.onended` forever
  // even after stop().
  const pendingDemoAudioRef = useRef<{
    audio: HTMLAudioElement;
    cancel: () => void;
  } | null>(null);

  const waitForReplyEnd = useCallback(
    async ({
      text,
      audioUrl,
    }: {
      text: string;
      audioUrl?: string;
    }): Promise<void> => {
      // Path 1: pre-recorded audio. Only when the user hasn't muted —
      // 🔊 off means "no sound at all", we don't second-guess that
      // for pre-recorded files.
      if (audioUrl && tts.enabled) {
        const result = await new Promise<'ended' | 'failed' | 'cancelled'>(
          (resolve) => {
            const audio = new Audio(audioUrl);
            const cleanup = () => {
              audio.onended = null;
              audio.onerror = null;
              if (pendingDemoAudioRef.current?.audio === audio) {
                pendingDemoAudioRef.current = null;
              }
            };
            audio.onended = () => {
              cleanup();
              resolve('ended');
            };
            audio.onerror = () => {
              cleanup();
              resolve('failed');
            };
            pendingDemoAudioRef.current = {
              audio,
              cancel: () => {
                try {
                  audio.pause();
                } catch {
                  /* ignore */
                }
                cleanup();
                resolve('cancelled');
              },
            };
            void audio.play().catch(() => {
              cleanup();
              resolve('failed');
            });
          },
        );
        if (result === 'ended' || result === 'cancelled') return;
        // result === 'failed' → fall through to live TTS so the demo
        // doesn't go silent because a file is missing.
      }

      // Path 2: live TTS (Edge-TTS via backend with Web Speech fallback).
      if (tts.enabled) {
        await tts.speakUntilDone(text);
        return;
      }

      // Path 3: muted — char-based dwell so the demo still paces.
      await new Promise<void>((r) => {
        const ms = Math.max(800, text.length * 18);
        window.setTimeout(r, ms);
      });
    },
    [tts],
  );

  const demoPlayer = useDemoConversation({
    appendTurn: (t) => setTurns((prev) => [...prev, t]),
    clearTurns: () => setTurns([]),
    setPhaseOverride: setDemoPhase,
    // Switching the LanguageToggle mid-demo doesn't hot-swap the
    // in-flight script (re-running this hook would yank the timeline)
    // but the next start() call will pick up the new value.
    script: demoScript,
    waitForReplyEnd,
  });

  // Current demo turn — used by ConversationPanel to drive the
  // ReadingDataLoader during the 'thinking' phase. Null when the
  // demo isn't running, when no turn is active, or for the boundary
  // turn (which has no files by design).
  const currentDemoTurn =
    demoPlayer.turnIndex !== null ? demoScript[demoPlayer.turnIndex] : null;
  const readingFiles = currentDemoTurn?.files ?? [];
  const readingDurationMs = currentDemoTurn?.thinkMs ?? 0;

  // Speak the latest assistant turn aloud once — for LIVE conversations.
  // During the scripted demo we skip the actual speak() call; the demo
  // player already drives TTS through `waitForReplyEnd` (with the
  // pre-recorded audio path or live TTS), so a parallel speak() here
  // would either duplicate or race the demo's audio.
  //
  // Critically: we still UPDATE the "last spoken id" ref during the
  // demo, even though we don't speak. Without that update, the moment
  // the demo's `running` flag flips to false on completion, this
  // effect re-runs (because `demoPlayer.running` is in the deps),
  // sees the last assistant turn's id as "unseen", and speaks it
  // through TTS — which is exactly the bug where the last turn's
  // pre-recorded audio gets repeated by Web Speech / Edge after the
  // demo ends.
  const lastSpokenIdRef = useRef<number | null>(null);
  useEffect(() => {
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (last.id === lastSpokenIdRef.current) return;
    // Mark as seen first, regardless of who's driving playback.
    lastSpokenIdRef.current = last.id;
    // Live path only speaks here. Demo path does its own playback
    // through waitForReplyEnd; calling speak() now would duplicate.
    if (demoPlayer.running) return;
    tts.speak(last.text);
  }, [turns, tts, demoPlayer.running]);

  useVad({
    enabled: trigger === 'vad' && source !== 'synthetic' && !demoPlayer.running,
    levelRef,
    onSpeechStart: () => transcriber.begin(),
    onSpeechEnd: () => transcriber.end(),
  });

  // Watch for the chat round-trip transitioning into 'replied' and
  // commit the reply to history exactly once per turn. A ref guards
  // against double-add if the effect re-fires for any reason while
  // status stays at 'replied'.
  const committedReplyRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      callChat.status === 'replied' &&
      callChat.reply &&
      committedReplyRef.current !== callChat.reply
    ) {
      committedReplyRef.current = callChat.reply;
      setTurns((prev) => [
        ...prev,
        { id: Date.now() + 1, role: 'assistant', text: callChat.reply },
      ]);
    }
    if (callChat.status === 'idle') {
      committedReplyRef.current = null;
    }
  }, [callChat.status, callChat.reply]);

  type CallPhase =
    | 'idle'
    | 'recording'
    | 'transcribing'
    | 'thinking'
    | 'replying'
    | 'error';
  const phase: CallPhase = useMemo(() => {
    // Demo mode wins — when the scripted player has set an override
    // we ignore the live transcriber/callChat states (which are
    // intentionally never invoked while the demo runs anyway).
    if (demoPhase) return demoPhase;
    if (callChat.status === 'thinking') return 'thinking';
    if (callChat.status === 'replied') return 'replying';
    if (callChat.status === 'error') return 'error';
    if (transcriber.state === 'transcribing') return 'transcribing';
    if (transcriber.state === 'recording') return 'recording';
    if (transcriber.state === 'error') return 'error';
    if (trigger === 'ptt' && pttHeld) return 'recording';
    return 'idle';
  }, [demoPhase, callChat.status, transcriber.state, trigger, pttHeld]);

  // Visual press-state for the mic button. True when the user is
  // really holding it OR the demo player is in its 'recording' phase.
  // Lets the demo's button look like the user pressed it without
  // actually firing the real pointer-down path (which the demo
  // intentionally bypasses).
  const pttPressed = pttHeld || demoPhase === 'recording';

  const orbState: OrbState = useMemo(() => {
    switch (phase) {
      case 'recording':
        return 'listening';
      case 'transcribing':
      case 'thinking':
        return 'thinking';
      case 'replying':
        return 'speaking';
      default:
        return 'idle';
    }
  }, [phase]);

  // PTT bindings — see deps note in earlier version: the methods
  // closure-captured here come from `useCallback([])` and are stable
  // across re-renders, so we deliberately omit them from the deps.
  const pttButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (trigger !== 'ptt') return;
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        if (demoPlayer.running) return;
        e.preventDefault();
        setPttHeld(true);
        if (source !== 'synthetic') {
          callChat.reset();
          transcriber.begin();
        }
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        if (demoPlayer.running) return;
        e.preventDefault();
        setPttHeld(false);
        if (source !== 'synthetic') transcriber.end();
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, source]);

  // Source switch: cancel any in-flight turn AND wipe history
  // (different audio path = different mental "session").
  useEffect(() => {
    transcriber.reset();
    callChat.reset();
    setPttHeld(false);
    setTurns([]);
    committedReplyRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const sourceStatusLabel = useMemo(() => {
    if (callChat.error) return t.call.replyError(callChat.error);
    if (transcriber.error) return t.call.transcribeError(transcriber.error);
    if (source === 'esp32' && audioStatus === 'waiting') return t.call.waitingAudio;
    if (source === 'mic' && audioStatus === 'blocked') return t.call.micUnavailable;
    return null;
  }, [source, audioStatus, callChat.error, transcriber.error, t]);

  const onPttPointerDown = () => {
    // Block PTT while the scripted demo is running — the demo owns
    // the orb's phase and turns, and a real mic capture mid-demo
    // would race the scripted timeline + leave a real user transcript
    // landing alongside the script.
    if (demoPlayer.running) return;
    setPttHeld(true);
    if (source !== 'synthetic') {
      callChat.reset();
      transcriber.begin();
    }
  };
  const onPttPointerEnd = () => {
    if (demoPlayer.running) return;
    setPttHeld(false);
    if (source !== 'synthetic') transcriber.end();
  };

  // ───── Drop-zone wiring ─────
  // Recording drag payload → PendingAttachment[].
  //
  // Call-page variant intentionally SKIPS the CSV preview fetch that
  // the chat-page builder does. Reasons:
  //   - The fetch adds 200–800 ms of "what's the orb doing?" latency
  //     between drop and the next turn — visible on the call page
  //     because there's no chips-area progress signal.
  //   - For voice flow, Claude is much faster pulling fresh data via
  //     its own Read tool when it actually needs to look at numbers,
  //     vs. having a 50-row inline preview blow up the prompt.
  //   - Larger recordings hit the chat page's
  //     RECORDING_CSV_INLINE_BYTES cap and end up path-only anyway;
  //     making the call page consistently path-only removes the
  //     small/large file divergence.
  //
  // useCallChat already adds `allowedTools: ['Read']` whenever
  // attachments are non-empty, so Read is permitted with no
  // permission prompt fired (matches the voice-mode "no UI dialogs"
  // contract).
  const buildRecordingAttachments = useCallback(
    async (payload: RecordingDragPayload): Promise<PendingAttachment[]> => {
      const out: PendingAttachment[] = [];
      const newId = () =>
        (typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

      if (payload.csvFilename) {
        out.push({
          id: newId(),
          path: payload.csvPath ?? payload.csvFilename,
          filename: payload.csvFilename,
          sizeBytes: payload.csvSizeBytes ?? 0,
          mimeType: 'text/csv',
          kind: 'recording',
          // No `content` — Claude's Read tool fetches the full file
          // on demand. `renderRecordingBlock` still emits the
          // `CSV file: <abs path>` line plus channels / row count
          // metadata so the model knows what's there.
          content: undefined,
          recording: {
            sessionId: payload.id,
            csvFilename: payload.csvFilename,
            csvRows: payload.csvRows,
          },
        });
      }
      if (payload.audioFilename) {
        const audioPath =
          payload.audioPath ?? recordingsApi.audioUrl(payload.audioFilename);
        out.push({
          id: newId(),
          path: audioPath,
          filename: payload.audioFilename,
          sizeBytes: payload.audioSizeBytes ?? 0,
          mimeType: 'audio/wav',
          kind: 'recording',
          recording: {
            sessionId: payload.id,
            audioFilename: payload.audioFilename,
            audioDurationSeconds: payload.audioDurationSeconds,
            audioSizeBytes: payload.audioSizeBytes,
            audioUrl: recordingsApi.audioUrl(payload.audioFilename),
          },
        });
      }
      return out;
    },
    [],
  );

  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(RECORDING_DRAG_MIME)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(RECORDING_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(RECORDING_DRAG_MIME)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };
  const handleDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(RECORDING_DRAG_MIME)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);

    // Visual ack — orb does an absorption pulse for ~500ms.
    setAbsorbing(true);
    window.setTimeout(() => setAbsorbing(false), 520);

    const raw = e.dataTransfer.getData(RECORDING_DRAG_MIME);
    if (!raw) return;
    let payload: RecordingDragPayload;
    try {
      payload = JSON.parse(raw) as RecordingDragPayload;
    } catch {
      return;
    }
    try {
      const atts = await buildRecordingAttachments(payload);
      if (atts.length > 0) {
        setAttachments((prev) => [...prev, ...atts]);
      }
    } catch (err) {
      // Surface as the source-status label so the user sees something.
      // eslint-disable-next-line no-console
      console.error('[CallPage] attachment build failed:', err);
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  // History drawer — lazy fetch on first open and on subsequent opens
  // so newly-created sessions appear without a page reload. Failures
  // are silent; the drawer just shows the empty-state message.
  const openHistory = async () => {
    setHistoryOpen(true);
    setSessionsLoading(true);
    try {
      const list = await claudeApi.getSessions();
      setSessions(list);
    } finally {
      setSessionsLoading(false);
    }
  };

  // Pick a past session to continue. We don't fetch its messages
  // back — the simple version just plumbs the session id into
  // `useCallChat` so the next `send()` carries it; Claude sees prior
  // context, but the on-screen `turns` start fresh. A small banner
  // tells the user which session they resumed.
  const resumeSession = (s: SessionSummary) => {
    callChat.setSessionId(s.sessionId);
    callChat.reset();
    setTurns([]);
    committedReplyRef.current = null;
    const preview =
      (s.firstMessage || s.lastMessage || s.sessionId).slice(0, 40);
    setResumedSessionLabel(preview);
    setHistoryOpen(false);
  };

  // ───── Morph geometry ─────
  // Morph triggers as soon as the first transcript lands — i.e. the
  // first user turn enters `turns` (onFinalized appends it before
  // calling Claude). The card then shows the user bubble while
  // Claude is thinking, instead of the user staring at the round
  // orb wondering whether the transcript was captured. Once
  // expanded the card stays that way for the rest of the call
  // (no compact-collapse between turns) so chat history isn't
  // visually flapping.
  //
  // Border-radius transitions from a large pixel value (effectively
  // a circle for the smaller box) to a small one — using PIXELS for
  // both ends so the browser can interpolate smoothly. 50% would
  // need % → px interpolation which doesn't ease cleanly.
  const cardExpanded = turns.length > 0;
  const idleSize = 460;
  // Widened from 720 → 880 so multi-line replies + avatar circles
  // both fit without the bubbles squeezing into a narrow column.
  const activeWidth = 880;
  const activeHeight = 560;

  // Auto-scroll the conversation list to its bottom whenever a new
  // turn arrives. Layout-effect so the scroll lands on the same
  // frame the new message paints — no visible jump.
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Mount latch for the "start with saying hi" hint above the orb.
  // Starts false so the hint is parked at translate(-12px) opacity 0;
  // a double-rAF after mount flips it to true → CSS transition slides
  // it down + fades it in. Without this the entry animation would not
  // run because the initial paint already shows the final state.
  const [hintMounted, setHintMounted] = useState(false);
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setHintMounted(true));
    });
    return () => {
      cancelAnimationFrame(r1);
      if (r2) cancelAnimationFrame(r2);
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col select-none text-text-primary"
      style={{
        background:
          'radial-gradient(ellipse at center, rgb(var(--color-window-bg)) 0%, rgb(var(--color-card-bg)) 75%, rgb(var(--color-card-bg)) 100%)',
      }}
    >
      <Starfield />

      <header className="relative z-10 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3 text-xs uppercase tracking-[0.22em] text-text-muted">
          <span>{source === 'esp32' ? t.call.sourceEsp32 : source === 'mic' ? t.call.sourceMic : '—'}</span>
          <span aria-hidden className="text-text-muted/60">·</span>
          <span className="text-accent">{t.call.state[orbState]}</span>
        </div>

        <div className="flex items-center gap-2">
          {/* Play demo — only in VITE_DEMO_MODE. Runs a scripted
              conversation through the same render path as a live
              call (orb morph + AssistantBubble + convergeWords).
              Click again to abort mid-playback; the chat history
              left on screen stays as-is so the user can scroll back
              through what played. */}
          {demo && (
            <button
              type="button"
              onClick={() => {
                if (demoPlayer.running) {
                  // Stop any pre-recorded audio FIRST — its cancel
                  // also resolves the awaiting Promise inside
                  // waitForReplyEnd, which lets the demo loop see
                  // cancelledRef on its next tick and exit cleanly.
                  // Without this, demoPlayer.stop() flips its flag
                  // but the loop is parked on audio.onended and
                  // won't notice until the file finishes playing.
                  pendingDemoAudioRef.current?.cancel();
                  demoPlayer.stop();
                  // Live TTS path may also be mid-utterance (when
                  // there's no pre-recorded file). Kill that too.
                  tts.stop();
                } else {
                  demoPlayer.start();
                }
              }}
              aria-label={demoPlayer.running ? 'Stop demo' : 'Play demo'}
              className={`px-3 h-10 rounded-full border text-xs font-semibold uppercase tracking-[0.16em] transition-colors ${
                demoPlayer.running
                  ? 'border-status-danger text-status-danger hover:bg-status-danger/10'
                  : 'border-accent text-accent hover:bg-accent/10'
              }`}
              title={
                demoPlayer.running
                  ? 'Stop the scripted demo'
                  : 'Play the scripted demo conversation'
              }
            >
              {demoPlayer.running ? '■ Stop demo' : '▶ Play demo'}
            </button>
          )}

          {/* TTS toggle — when on, the latest committed assistant
              reply is read aloud via Web Speech API. Hidden in
              browsers that don't support speechSynthesis (mostly
              embedded WebViews and some legacy builds). */}
          {tts.available && (
            <button
              type="button"
              onClick={() => tts.setEnabled(!tts.enabled)}
              aria-pressed={tts.enabled}
              aria-label={tts.enabled ? t.call.ttsOnTitle : t.call.ttsOffTitle}
              title={tts.enabled ? t.call.ttsOnTitle : t.call.ttsOffTitle}
              className={`grid h-10 w-10 place-items-center rounded-full border text-base transition-colors ${
                tts.enabled
                  ? 'border-accent text-accent'
                  : 'border-card-border text-text-secondary hover:border-accent hover:text-accent'
              }`}
              style={
                tts.enabled
                  ? { background: 'rgb(var(--color-accent) / 0.12)' }
                  : undefined
              }
            >
              <span aria-hidden className="leading-none">
                {tts.enabled ? '🔊' : '🔇'}
              </span>
            </button>
          )}

          {/* History drawer toggle — opens the LEFT-side session
              list so the user can resume a past chat. Lazy-fetches
              sessions on first open. */}
          <button
            type="button"
            onClick={() => (historyOpen ? setHistoryOpen(false) : void openHistory())}
            aria-label="Toggle history"
            aria-pressed={historyOpen}
            className={`grid h-10 w-10 place-items-center rounded-full border transition-colors ${
              historyOpen
                ? 'border-accent text-accent'
                : 'border-card-border text-text-secondary hover:border-accent hover:text-accent'
            }`}
            style={
              historyOpen
                ? { background: 'rgb(var(--color-accent) / 0.12)' }
                : undefined
            }
            title="History"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
              />
            </svg>
          </button>

          {/* Recordings drawer toggle — opens the RIGHT-side panel
              users can drag from. */}
          <button
            type="button"
            onClick={() => setRecordingsOpen((v) => !v)}
            aria-label="Toggle recordings"
            aria-pressed={recordingsOpen}
            className={`grid h-10 w-10 place-items-center rounded-full border transition-colors ${
              recordingsOpen
                ? 'border-accent text-accent'
                : 'border-card-border text-text-secondary hover:border-accent hover:text-accent'
            }`}
            style={
              recordingsOpen
                ? { background: 'rgb(var(--color-accent) / 0.12)' }
                : undefined
            }
            title="Recordings"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M10 3a3 3 0 00-3 3v4a3 3 0 006 0V6a3 3 0 00-3-3z" />
              <path d="M5 9a1 1 0 012 0 3 3 0 006 0 1 1 0 112 0 5 5 0 01-4 4.9V17h-2v-3.1A5 5 0 015 9z" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => navigate('/chat')}
            aria-label={t.call.closeAria}
            className="grid h-10 w-10 place-items-center rounded-full border border-card-border text-text-secondary transition-colors hover:border-accent hover:text-accent"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M5 5L15 15M15 5L5 15" />
            </svg>
          </button>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center gap-6">
        {/* Hint above the orb — "Start with saying hi!". Pops in
            from above on first mount (translate(-12px) → 0, fade in)
            so it feels like it emerges over the orb rather than
            being a static label. Fades out + slides up when the
            card expands. The element keeps a layout slot (h fixed
            so the orb position doesn't shift on fade) regardless
            of state. */}
        <div
          className="h-5 text-xs uppercase tracking-[0.28em] text-text-secondary"
          aria-hidden={cardExpanded || !hintMounted}
          style={{
            opacity: !cardExpanded && hintMounted ? 1 : 0,
            transform:
              !cardExpanded && hintMounted ? 'translateY(0)' : 'translateY(-12px)',
            transition:
              'opacity 600ms ease-out, transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        >
          {t.call.transcriptPlaceholder}
        </div>

        {/* Morph card — single container that holds BOTH the orb and
            the conversation panel. Shape (width / height / border-
            radius) animates 700 ms cubic-bezier between two states:
              - idle:   460×460 circle, orb fills it, conversation hidden
              - active: 720×560 rounded rectangle, orb shrinks to a small
                        avatar at top-center, conversation flows below
            Drop handlers live on this same container so dragging onto
            ANY part (including the future conversation area) still
            registers as a drop on the orb. */}
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className="relative flex flex-col items-center"
          style={{
            width: cardExpanded ? activeWidth : idleSize,
            // Cap by viewport height so the footer (mic button) is
            // never pushed off-screen on shorter monitors. 360px
            // reserves room for header (~64) + footer (~200) +
            // breathing margin (~96). On taller monitors `height`
            // wins; on shorter ones `maxHeight` clamps and the
            // conversation panel just scrolls inside.
            height: cardExpanded ? activeHeight : idleSize,
            maxHeight: cardExpanded ? 'calc(100vh - 360px)' : undefined,
            borderRadius: cardExpanded ? 28 : idleSize / 2,
            // When the card is expanded the orb's `excited` ring is
            // hidden (the orb itself is opacity 0), so the container
            // has to carry the drag feedback instead. dragOver lights
            // up the border to a full-strength accent and adds a halo
            // box-shadow; absorbing briefly scales up by 1%. In the
            // compact state the orb's own ring still drives the feel,
            // so we leave the border transparent.
            border: cardExpanded
              ? dragOver
                ? '2px solid rgb(var(--color-accent))'
                : '1px solid rgb(var(--color-card-border) / 0.6)'
              : '1px solid transparent',
            background: cardExpanded
              ? 'rgb(var(--color-card-bg) / 0.45)'
              : 'transparent',
            backdropFilter: cardExpanded ? 'blur(16px)' : 'none',
            WebkitBackdropFilter: cardExpanded ? 'blur(16px)' : 'none',
            boxShadow: dragOver
              ? '0 0 60px rgb(var(--color-accent) / 0.55), 0 0 0 4px rgb(var(--color-accent) / 0.15)'
              : 'none',
            transform: absorbing ? 'scale(1.015)' : 'scale(1)',
            overflow: 'hidden',
            transition:
              'width 700ms cubic-bezier(0.4, 0, 0.2, 1), ' +
              'height 700ms cubic-bezier(0.4, 0, 0.2, 1), ' +
              'border-radius 700ms cubic-bezier(0.4, 0, 0.2, 1), ' +
              'border-color 250ms ease-out, ' +
              'border-width 250ms ease-out, ' +
              'background 700ms ease-out, ' +
              'backdrop-filter 700ms ease-out, ' +
              'box-shadow 250ms ease-out, ' +
              'transform 500ms ease-out',
            // Resize-aware max width: never wider than viewport.
            maxWidth: '90vw',
          }}
        >
          {/* Phase-glow overlay — once the card is expanded the orb
              is gone, so this layer carries the visual feedback for
              recording / transcribing / thinking / replying phases.
              Radial gradient tinted with whichever accent slot the
              orb would be using; pulses softly via @keyframes.
              Behind the conversation panel (z-index by source order)
              so words sit on top of the glow. */}
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none rounded-[inherit]"
            style={{
              background: (() => {
                if (phase === 'thinking' || phase === 'transcribing') {
                  return 'radial-gradient(ellipse at center, rgb(var(--color-accent-warm) / 0.40) 0%, transparent 70%)';
                }
                if (phase === 'recording') {
                  return 'radial-gradient(ellipse at center, rgb(var(--color-accent) / 0.35) 0%, transparent 72%)';
                }
                if (phase === 'replying') {
                  return 'radial-gradient(ellipse at center, rgb(var(--color-accent-hover) / 0.30) 0%, transparent 75%)';
                }
                return 'radial-gradient(ellipse at center, transparent, transparent)';
              })(),
              opacity: cardExpanded && phase !== 'idle' ? 1 : 0,
              transition:
                'opacity 600ms ease-out, background 700ms ease-out',
              animation:
                cardExpanded && phase !== 'idle'
                  ? 'call-glow-pulse 3s ease-in-out infinite'
                  : 'none',
            }}
          />

          {/* Orb — fills the whole circle while the card is compact.
              On morph it fades out (opacity 400 ms) AND its slot
              collapses to zero size simultaneously, so the
              conversation panel can take the whole expanded box.
              Once expanded we never show the orb inside the card —
              the user explicitly didn't want any extra graphic in
              there besides the chat. */}
          <div
            className="shrink-0 absolute inset-0"
            style={{
              opacity: cardExpanded ? 0 : 1,
              pointerEvents: cardExpanded ? 'none' : 'auto',
              transition:
                'opacity 400ms ease-out',
            }}
          >
            <Orb
              state={orbState}
              levelRef={levelRef}
              excited={dragOver}
              absorbing={absorbing}
            />
          </div>

          {/* Conversation panel — always mounted so the opacity
              transition actually fires (a conditional render would
              create the node already at opacity 1, no fade-in). The
              300 ms delay matches the orb fade-out so the two cross-
              fade cleanly. pointer-events:none when invisible so it
              doesn't intercept drag events on the still-visible orb. */}
          <div
            ref={scrollRef}
            className="absolute inset-0 w-full overflow-y-auto px-6 py-5"
            style={{
              opacity: cardExpanded ? 1 : 0,
              pointerEvents: cardExpanded ? 'auto' : 'none',
              transition: 'opacity 400ms ease-out 300ms',
            }}
          >
            <ConversationPanel
              turns={turns}
              phase={phase}
              inFlightUserText={transcriber.text}
              streamingReply={callChat.reply}
              readingFiles={readingFiles}
              readingDurationMs={readingDurationMs}
            />
          </div>
        </div>

        {sourceStatusLabel && (
          <div className="text-xs uppercase tracking-[0.22em] text-status-warning">
            {sourceStatusLabel}
          </div>
        )}
      </main>

      <div className="relative z-10 mx-auto h-20 w-[min(720px,82vw)]">
        <Waveform levelRef={levelRef} />
      </div>

      {/* Resumed-session banner — appears after the user picks a
          past session from the History drawer. Visual reminder that
          Claude has prior context even though `turns` here is empty. */}
      {resumedSessionLabel && (
        <div className="relative z-10 mx-auto mt-3 flex w-[min(760px,86vw)] items-center justify-between gap-2 rounded-lg border border-accent/30 px-3 py-1.5 text-[11px] text-text-secondary"
          style={{ background: 'rgb(var(--color-accent) / 0.08)' }}>
          <span>
            <span className="text-text-muted">Resumed: </span>
            <span className="text-text-primary">{resumedSessionLabel}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              callChat.setSessionId(null);
              setResumedSessionLabel(null);
            }}
            aria-label="Forget resumed session"
            className="text-text-muted hover:text-text-primary"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-3 w-3">
              <path d="M5 5L15 15M15 5L5 15" />
            </svg>
          </button>
        </div>
      )}

      {/* Attachment chips — sit JUST above the conversation card so
          the user can see what'll go out with the next message. The
          row is rendered only when there's at least one attachment;
          empty state stays out of the layout entirely. */}
      {attachments.length > 0 && (
        <div className="relative z-10 mx-auto mt-3 flex w-[min(760px,86vw)] flex-wrap items-center gap-2">
          {attachments.map((att) => (
            <span
              key={att.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 px-3 py-1 text-[11px] text-text-primary"
              style={{ background: 'rgb(var(--color-accent) / 0.12)' }}
            >
              <span aria-hidden>{iconForKind(att.kind)}</span>
              <span className="font-medium truncate max-w-[16rem]" title={att.path}>
                {att.filename}
              </span>
              <span className="text-text-muted">{formatSize(att.sizeBytes)}</span>
              <button
                type="button"
                onClick={() => removeAttachment(att.id)}
                aria-label={`Remove ${att.filename}`}
                className="ml-1 grid h-4 w-4 place-items-center rounded-full text-text-muted hover:bg-card-border hover:text-text-primary"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Conversation panel is no longer a separate card — it lives
          inside the morph container above so the orb and the chat
          history share one element that grows from circle to
          rectangle. See the morph block in <main>. */}

      {/* ──────── Recordings drawer (right) ──────── */}
      {/* Floating panel rather than full-height drawer: top/bottom
          margins so it doesn't dominate the viewport, max-height so
          long lists scroll inside, narrow (~300px) so it never
          covers the centred orb on any reasonable screen. The panel
          stays mounted (transform-only hide) so its WS subscription
          survives toggles. */}
      <aside
        className={`fixed top-20 right-4 z-20 flex w-[300px] max-h-[calc(100vh-7rem)] flex-col rounded-xl border border-card-border bg-card-bg/90 shadow-2xl backdrop-blur-md transition-transform duration-300 ease-out ${
          recordingsOpen
            ? 'translate-x-0'
            : 'translate-x-[calc(100%+1.5rem)]'
        }`}
        aria-hidden={!recordingsOpen}
      >
        <header className="flex shrink-0 items-center justify-between px-3 py-2 border-b border-card-border">
          <span className="text-[11px] uppercase tracking-[0.18em] text-text-muted">
            Recordings
          </span>
          <button
            type="button"
            onClick={() => setRecordingsOpen(false)}
            aria-label="Close recordings"
            className="grid h-6 w-6 place-items-center rounded-md text-text-muted hover:bg-card-border/40 hover:text-text-primary"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-3 w-3">
              <path d="M5 5L15 15M15 5L5 15" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          <RecordingsPanel />
        </div>
      </aside>

      {/* ──────── History drawer (left) ──────── */}
      {/* Simple session list: clicking an entry resumes that session
          on the next send (Claude sees prior context server-side).
          We deliberately don't fetch / display the past messages —
          that's the "simple version". The banner above the
          conversation card tells the user which session is loaded. */}
      <aside
        className={`fixed top-20 left-4 z-20 flex w-[300px] max-h-[calc(100vh-7rem)] flex-col rounded-xl border border-card-border bg-card-bg/90 shadow-2xl backdrop-blur-md transition-transform duration-300 ease-out ${
          historyOpen
            ? 'translate-x-0'
            : '-translate-x-[calc(100%+1.5rem)]'
        }`}
        aria-hidden={!historyOpen}
      >
        <header className="flex shrink-0 items-center justify-between px-3 py-2 border-b border-card-border">
          <span className="text-[11px] uppercase tracking-[0.18em] text-text-muted">
            History
          </span>
          <button
            type="button"
            onClick={() => setHistoryOpen(false)}
            aria-label="Close history"
            className="grid h-6 w-6 place-items-center rounded-md text-text-muted hover:bg-card-border/40 hover:text-text-primary"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-3 w-3">
              <path d="M5 5L15 15M15 5L5 15" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-2">
          {sessionsLoading ? (
            <div className="p-3 text-center text-xs text-text-muted">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="p-3 text-center text-xs text-text-muted">
              No past sessions.
            </div>
          ) : (
            <ul className="space-y-1">
              {sessions.map((s) => (
                <li key={s.sessionId}>
                  <button
                    type="button"
                    onClick={() => resumeSession(s)}
                    className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-card-border/40"
                  >
                    <div className="truncate font-medium text-text-primary">
                      {s.firstMessage || s.lastMessage || '(empty)'}
                    </div>
                    <div className="mt-0.5 flex justify-between text-[10px] text-text-muted">
                      <span className="font-mono truncate max-w-[10rem]">
                        {s.sessionId.slice(0, 8)}
                      </span>
                      <span>{s.messageCount} msg</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <footer className="relative z-10 flex flex-col items-center gap-6 px-6 pb-10 pt-6">
        <div className="flex items-center gap-8 text-xs uppercase tracking-[0.18em]">
          <SegmentedToggle
            label={t.call.sourceLabel}
            value={source === 'mic' ? 'mic' : source === 'esp32' ? 'esp32' : 'synthetic'}
            onChange={(v) => setSource(v as AudioSource)}
            options={[
              { value: 'esp32', label: t.call.sourceEsp32 },
              { value: 'mic', label: t.call.sourceMic },
            ]}
          />
          <SegmentedToggle
            label={t.call.triggerLabel}
            value={trigger}
            onChange={(v) => setTrigger(v as TriggerMode)}
            options={[
              { value: 'ptt', label: t.call.triggerPtt },
              { value: 'vad', label: t.call.triggerVad },
            ]}
          />
          <label className="flex items-center gap-3" title={t.call.langTitle}>
            <span className="text-text-muted">{t.call.langLabel}</span>
            <select
              value={voiceLang}
              onChange={(e) => setVoiceLang(e.target.value)}
              className="rounded-full border border-card-border px-3 py-1 text-[11px] tracking-[0.18em] text-accent backdrop-blur-sm focus:outline-none focus:ring-1 focus:ring-accent"
              style={{ background: 'rgb(var(--color-card-bg) / 0.5)' }}
              aria-label={t.call.langTitle}
            >
              {VOICE_LANGS.map((opt) => (
                <option key={opt.code} value={opt.code}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {trigger === 'ptt' ? (
          <>
            {/* Visual "pressed" state combines the real held flag with
                the demo player's recording phase, so during the
                scripted demo the mic button looks exactly like the
                user is holding it down — accent border, glow, scale,
                and the "release to send" caption — even though no
                pointer is actually on it. The pointer handlers stay
                wired to the real flag and are short-circuited inside
                themselves when the demo is running, so we never end
                up with the visual lying about real input state. */}
            <button
              ref={pttButtonRef}
              type="button"
              onPointerDown={onPttPointerDown}
              onPointerUp={onPttPointerEnd}
              onPointerCancel={onPttPointerEnd}
              onPointerLeave={() => {
                if (pttHeld) onPttPointerEnd();
              }}
              className={`group relative grid h-20 w-20 place-items-center rounded-full border transition-all duration-150 ${
                pttPressed
                  ? 'scale-105 border-accent text-accent'
                  : 'border-card-border text-text-secondary hover:border-accent hover:text-accent'
              }`}
              style={
                pttPressed
                  ? {
                      background: 'rgb(var(--color-accent) / 0.18)',
                      boxShadow: '0 0 60px rgb(var(--color-accent) / 0.55)',
                    }
                  : { background: 'rgb(var(--color-card-bg) / 0.5)' }
              }
              aria-label={pttPressed ? t.call.releaseToSend : t.call.holdToTalk}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-7 w-7">
                <path d="M10 12a3 3 0 003-3V5a3 3 0 10-6 0v4a3 3 0 003 3z" />
                <path
                  fillRule="evenodd"
                  d="M5 9a1 1 0 012 0 3 3 0 006 0 1 1 0 112 0 5 5 0 01-4 4.9V16h2a1 1 0 110 2H7a1 1 0 110-2h2v-2.1A5 5 0 015 9z"
                />
              </svg>
              <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] uppercase tracking-[0.18em] text-text-muted">
                {pttPressed ? t.call.releaseToSend : t.call.holdToTalk}
              </span>
            </button>
            <p className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
              {t.call.holdHint}
            </p>
          </>
        ) : (
          <>
            <div
              className="rounded-full border border-card-border px-5 py-2 text-xs uppercase tracking-[0.18em] text-accent"
              style={{ background: 'rgb(var(--color-card-bg) / 0.5)' }}
            >
              {t.call.triggerVad}
            </div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-text-muted">
              {t.call.vadHint}
            </p>
          </>
        )}
      </footer>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */

interface ConversationPanelProps {
  turns: Turn[];
  phase: 'idle' | 'recording' | 'transcribing' | 'thinking' | 'replying' | 'error';
  /** Live transcript while the user is mid-turn — shown as a draft
   *  user bubble below the committed history. */
  inFlightUserText: string;
  /** Streaming Claude reply while phase==='thinking'. Rendered as a
   *  live assistant bubble; once the stream completes (`replied`),
   *  the parent commits this text into `turns` and clears it. */
  streamingReply?: string;
  /** Files for the current demo turn. When non-empty AND phase is
   *  'thinking', the thinking branch renders ReadingDataLoader
   *  instead of the generic ThinkingLoader. Empty for live (non-
   *  demo) calls and for the boundary turn — both fall back to
   *  the dot loader. */
  readingFiles?: string[];
  /** Total ms the loader is on screen (= the demo turn's thinkMs).
   *  ReadingDataLoader uses this to pace its file-by-file step. */
  readingDurationMs?: number;
}

function ConversationPanel({
  turns,
  phase,
  inFlightUserText,
  streamingReply: _streamingReply,
  readingFiles = [],
  readingDurationMs = 0,
}: ConversationPanelProps) {
  // streamingReply is intentionally unused — see the thinking branch
  // below. Kept on the prop interface so callers don't have to drop
  // it conditionally; if we re-enable a streaming display later
  // (e.g. low-opacity preview that fades into the converge animation)
  // we can wire it back without changing the call site.
  const t = useT();

  if (turns.length === 0 && phase === 'idle') {
    return (
      <p className="text-center text-sm text-text-muted">
        {t.call.transcriptPlaceholder}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {turns.map((turn, i) => {
        const isLast = i === turns.length - 1;
        if (turn.role === 'user') {
          return (
            <UserBubble key={turn.id} text={turn.text} animate={isLast} />
          );
        }
        // Assistant turn — three optional layers stacked vertically:
        //   1. Persistent "Consulted N files" panel above the bubble
        //   2. The bubble itself (with markdown / convergeWords text)
        //   3. Optional inline line chart below the bubble
        // All structured panels share a 36 px left spacer so they
        // hang under the doctor avatar's column. Boundary turns drop
        // both panels and render just the bubble.
        return (
          <div key={turn.id} className="flex flex-col gap-1.5">
            {turn.files && turn.files.length > 0 && (
              <div className="flex justify-start items-end gap-2">
                <div className="shrink-0 w-9" aria-hidden />
                <ReadingDataLoader files={turn.files} phase="consulted" />
              </div>
            )}
            <AssistantBubble text={turn.text} animate={isLast} />
            {turn.chart && (
              <div className="flex justify-start items-end gap-2">
                <div className="shrink-0 w-9" aria-hidden />
                <MiniLineChart
                  data={turn.chart.data}
                  labels={turn.chart.labels}
                  caption={turn.chart.caption}
                  unit={turn.chart.unit}
                  baseline={turn.chart.baseline}
                  highlight={turn.chart.highlight}
                />
              </div>
            )}
          </div>
        );
      })}

      {/* Mid-turn rows: live transcript bubble (recording) +
          loaders for transcribing + LIVE STREAMING reply during
          thinking. Streaming text shows as soon as the API starts
          returning deltas, so the user sees Claude type instead of
          watching a loader for 1-2s. The thinking loader still
          appears for the brief gap before the first delta lands. */}
      {phase === 'recording' && inFlightUserText && (
        <div className="flex justify-end items-end gap-2">
          <div className="rounded-2xl border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent max-w-[78%]">
            {inFlightUserText}
          </div>
          <Avatar role="user" />
        </div>
      )}
      {phase === 'transcribing' && (
        <div className="flex justify-end items-end gap-2">
          <ThinkingLoader caption={t.call.transcribing} />
          <Avatar role="user" />
        </div>
      )}
      {phase === 'thinking' && (
        // Always show a loader, never the streaming partial. Earlier
        // we displayed `streamingReply` here as a live "Claude is
        // typing" bubble — but that meant the user SAW the final
        // text fully formed before the committed turn mounted with
        // convergeWords, producing a visible "flash of already-
        // rendered text → scatter → converge" sequence. Letting the
        // loader hold its ground until status='replied' means
        // convergeWords' scattered initial state is the very first
        // thing the user sees of the reply, and the converge animation
        // reads as the reveal it's meant to be.
        //
        // When the demo player has supplied a non-empty file list,
        // swap the generic dot loader for ReadingDataLoader so the
        // watcher sees a concrete "📂 Reading data" panel listing
        // the files. Empty list (live calls + boundary demo turn)
        // falls back to the dot loader.
        <div className="flex justify-start items-end gap-2">
          <Avatar role="assistant" />
          {readingFiles.length > 0 ? (
            <ReadingDataLoader
              files={readingFiles}
              durationMs={readingDurationMs}
            />
          ) : (
            <ThinkingLoader caption={t.call.thinkingCaption} />
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */

interface BubbleProps {
  text: string;
  animate: boolean;
}

// Tiny circular avatar shown next to each chat bubble. Emoji-based
// because we don't ship per-user portraits and "doctor" is a persona,
// not a real account — the stethoscope reads as clinical/medical
// without committing to any specific gender or appearance.
//
// Sized at 36 px to match the bubble's vertical baseline; rendered
// with `flex-end` alignment in the bubble row so it sits on the same
// line as the bubble's last line of text. shrink-0 keeps it from
// being squeezed when long markdown wraps.
function Avatar({ role }: { role: 'user' | 'assistant' }) {
  const isUser = role === 'user';
  return (
    <div
      aria-hidden
      className={`shrink-0 grid h-9 w-9 place-items-center rounded-full border text-lg select-none ${
        isUser
          ? 'border-accent/40 bg-accent/15'
          : 'border-card-border bg-card-bg'
      }`}
      title={isUser ? 'You' : 'Doctor'}
    >
      <span className="leading-none">{isUser ? '👤' : '🩺'}</span>
    </div>
  );
}

// Both bubbles are wrapped with React.memo because CallPage re-renders
// at ~50 Hz (audio-level Zustand store updates the orb), and without
// memoization that cascades into AssistantBubble re-rendering, which
// re-renders MessageMarkdown, which makes react-markdown rebuild the
// entire markdown DOM tree — wiping out the per-word spans that
// `convergeWords` created. The animation looked like text "appeared
// instantly" because the spans got blown away on the very next frame
// after they were created. Memoizing breaks the cascade so
// convergeWords' DOM mutations survive.
const UserBubble = memo(function UserBubble({ text }: BubbleProps) {
  return (
    <div className="flex justify-end items-end gap-2">
      <div className="rounded-2xl rounded-tr-sm border border-accent/40 bg-accent/15 px-3 py-2 text-sm text-text-primary max-w-[78%] whitespace-pre-wrap break-words">
        {text}
      </div>
      <Avatar role="user" />
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({ text, animate }: BubbleProps) {
  // The committed (latest) assistant bubble runs a brief word-level
  // converge animation as a "settle" flourish — the user has just
  // watched the streaming bubble type the reply, so this isn't
  // revealing new information; it's a quick polish that signals
  // "this is the final version, conversation is committed". Keeping
  // the convergeWords helper but with tighter timings (15 ms / word
  // stagger, 500 ms duration, 60 px drift) so it reads as a flourish
  // rather than a re-replay of the text.
  //
  // Streaming bubbles (animate=false) skip this entirely and just
  // render the markdown — their motion comes from text growing
  // letter-by-letter as deltas arrive.
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!animate) return;
    const root = ref.current;
    if (!root) return;
    return convergeWords(root, {
      driftRadius: 60,
      wordDelayMs: 15,
      durationMs: 500,
    });
  }, [animate, text]);

  return (
    <div className="flex justify-start items-end gap-2">
      <Avatar role="assistant" />
      <div
        ref={ref}
        className="rounded-2xl rounded-tl-sm border border-card-border bg-card-bg/60 px-4 py-3 text-sm text-text-primary max-w-[82%]"
      >
        <MessageMarkdown content={text} variant="assistant" />
      </div>
    </div>
  );
});

/* ─────────────────────────────────────────────────────────────────── */

interface ConvergeWordsOptions {
  driftRadius: number;
  wordDelayMs: number;
  durationMs: number;
}

function pseudo(i: number, seed: number): number {
  const v = (Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1;
  return v < 0 ? v + 1 : v;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * Walk `root`'s text nodes, replace each with a sequence of word
 * spans + whitespace text nodes, then animate each span from a
 * random scattered/blurred state back to identity.
 *
 * Idempotent under React 18 StrictMode: if `root` has already been
 * wrapped (detected via `[data-cv-word]`), skip the TreeWalker and
 * reuse the existing spans. Without this the second strict invocation
 * would NEST spans and the outer wrappers would stay opacity 0
 * forever.
 */
function convergeWords(
  root: HTMLElement,
  opts: ConvergeWordsOptions,
): () => void {
  let wordSpans: HTMLSpanElement[];

  const existing = Array.from(
    root.querySelectorAll<HTMLSpanElement>('span[data-cv-word]'),
  );
  if (existing.length > 0) {
    wordSpans = existing;
  } else {
    // Skip text inside structured content — tables and SVGs would
    // get visually torn apart if every cell/label flew in from a
    // random offset. `data-cv-skip` lets future React subtrees opt
    // out without us teaching this function about new tags.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode: Node): number {
        let p: Node | null = textNode.parentNode;
        while (p && p !== root) {
          if (p.nodeType === Node.ELEMENT_NODE) {
            const el = p as Element;
            const tag = el.tagName;
            if (
              tag === 'TABLE' ||
              tag === 'SVG' ||
              el.hasAttribute('data-cv-skip')
            ) {
              return NodeFilter.FILTER_REJECT;
            }
          }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }

    wordSpans = [];
    for (const tn of textNodes) {
      const text = tn.textContent ?? '';
      if (!text || !text.trim()) continue;
      const parent = tn.parentNode;
      if (!parent) continue;

      const tokens = text.match(/(\S+|\s+)/g);
      if (!tokens) continue;

      const fragment = document.createDocumentFragment();
      for (const tok of tokens) {
        if (/^\s+$/.test(tok)) {
          fragment.appendChild(document.createTextNode(tok));
        } else {
          const span = document.createElement('span');
          span.textContent = tok;
          span.style.display = 'inline-block';
          span.style.willChange = 'transform, opacity, filter';
          span.setAttribute('data-cv-word', '1');
          fragment.appendChild(span);
          wordSpans.push(span);
        }
      }
      parent.replaceChild(fragment, tn);
    }
  }

  if (wordSpans.length === 0) return () => {};

  for (let i = 0; i < wordSpans.length; i++) {
    const span = wordSpans[i];
    const angle = pseudo(i, 1) * Math.PI * 2;
    const r = (0.35 + pseudo(i, 2) * 0.65) * opts.driftRadius;
    const dx = Math.cos(angle) * r;
    const dy = Math.sin(angle) * r;
    const blur = 2 + pseudo(i, 3) * 6;
    span.dataset.dx = String(dx);
    span.dataset.dy = String(dy);
    span.dataset.blur = String(blur);
    span.dataset.delay = String(i * opts.wordDelayMs);
    span.style.transform = `translate(${dx}px, ${dy}px) scale(1.3)`;
    span.style.opacity = '0';
    span.style.filter = `blur(${blur}px)`;
  }

  const startTime = performance.now();
  let raf = 0;
  const tick = (now: number) => {
    const elapsed = now - startTime;
    let allDone = true;
    for (const span of wordSpans) {
      const dx = Number(span.dataset.dx);
      const dy = Number(span.dataset.dy);
      const blur = Number(span.dataset.blur);
      const delay = Number(span.dataset.delay);
      const tRaw = (elapsed - delay) / opts.durationMs;
      const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
      if (t < 1) allDone = false;
      const p = easeOutCubic(t);
      const inv = 1 - p;
      span.style.transform = `translate(${dx * inv}px, ${dy * inv}px) scale(${1 + 0.3 * inv})`;
      span.style.opacity = String(p);
      span.style.filter = `blur(${blur * inv}px)`;
    }
    if (!allDone) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  // Watchdog: if any rAF gets dropped, force every span to identity
  // after a generous deadline so the bubble is at least readable.
  const totalMs = wordSpans.length * opts.wordDelayMs + opts.durationMs;
  const watchdog = window.setTimeout(() => {
    for (const span of wordSpans) {
      span.style.transform = 'translate(0, 0) scale(1)';
      span.style.opacity = '1';
      span.style.filter = 'blur(0)';
    }
  }, totalMs + 600);

  return () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(watchdog);
  };
}

/* ─────────────────────────────────────────────────────────────────── */

interface SegmentedToggleOption {
  value: string;
  label: string;
}

interface SegmentedToggleProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: SegmentedToggleOption[];
}

function SegmentedToggle({ label, value, onChange, options }: SegmentedToggleProps) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-text-muted">{label}</span>
      <div
        className="flex rounded-full border border-card-border p-0.5 backdrop-blur-sm"
        style={{ background: 'rgb(var(--color-card-bg) / 0.5)' }}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`rounded-full px-3 py-1 text-[11px] tracking-[0.18em] transition-colors ${
                active
                  ? 'text-accent'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
              style={
                active
                  ? { background: 'rgb(var(--color-accent) / 0.16)' }
                  : undefined
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
