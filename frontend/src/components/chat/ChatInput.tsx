// Chat Input component — textarea + attachments pill row + tool strip.
//
// Layout (top to bottom inside `<div className="bg-card-bg border-t">`):
//   1. AttachmentPills         — only when there are pending attachments
//   2. textarea + Send/Stop    — the input row
//   3. ChatInputTools          — [+ / | cwd | pills] strip
//
// Responsibilities owned here (not delegated):
//   - Slash-command detection on input change; menu display + keyboard
//     navigation (arrow keys / Enter / Tab / Esc).
//   - Submit routing: if input matches a slash command, dispatch via
//     `onSlashDispatch`; otherwise call `onSend`.
//   - Opening the menu when the toolbar's `/` button is clicked
//     (inserts `/` at cursor, triggering the normal detection path).
//   - Calling the file picker and pushing results into the store.
//
// Everything involving sessions/messages/sidebar lives at ChatPage and
// is passed in via callbacks.

import { useMemo, useRef, useState } from 'react';
import { useChatStore } from '../../store/chatStore';
import { claudeApi } from '../../api/claudeApi';
import { recordingsApi } from '../../api/recordingsApi';
import { AttachmentPills } from './AttachmentPills';
import { ChatInputTools } from './ChatInputTools';
import { SlashCommandMenu } from './SlashCommandMenu';
import {
  getMenuMatches,
  resolveCommand,
  SLASH_COMMANDS,
  type SlashCommand,
} from '../../lib/slashCommands';
import {
  RECORDING_DRAG_MIME,
  RECORDING_CSV_PREVIEW_ROWS,
  RECORDING_CSV_INLINE_BYTES,
  type PendingAttachment,
} from '../../lib/attachments';
import type { RecordingDragPayload } from './RecordingsPanel';
import {
  isSpeechRecognitionSupported,
  startSpeechRecognition,
  explainSpeechError,
  preflightMicrophone,
  SILENT_SPEECH_ERRORS,
  type SpeechRecognitionHandle,
} from '../../lib/speechRecognition';

interface ChatInputProps {
  onSend: (message: string) => void;
  onAbort: () => void;
  isLoading: boolean;
  // Active project's cwd (or null). Displayed in the tool strip.
  cwd: string | null;
  // Merged command list (local built-ins + server-discovered). Fallback
  // to bare SLASH_COMMANDS if parent doesn't pass anything — keeps the
  // menu functional even before the first /api/slash-commands fetch.
  commands?: SlashCommand[];
  // True when the Whisper-local extension is installed + enabled on
  // the Python backend. Toggles the secondary ESP32 mic button. Phase
  // C3 will wire that button to /ws/transcribe; currently it toasts.
  esp32MicAvailable?: boolean;
  // Called when the user hits a slash command — ChatPage assembles
  // the full context (toast, sidebar open, etc.) and invokes
  // cmd.execute(context). Raw input is forwarded so server commands
  // can extract $ARGUMENTS.
  onSlashDispatch: (cmd: SlashCommand, rawInput?: string) => void;
  // Fires when the user cycles a mode pill; ChatPage forwards to toast.
  onModeChangeAnnounce?: (text: string) => void;
}

export function ChatInput({
  onSend,
  onAbort,
  isLoading,
  cwd,
  commands = SLASH_COMMANDS,
  esp32MicAvailable = false,
  onSlashDispatch,
  onModeChangeAnnounce,
}: ChatInputProps) {
  const input = useChatStore((s) => s.input);
  const setInput = useChatStore((s) => s.setInput);
  const pendingAttachments = useChatStore((s) => s.pendingAttachments);
  const addPendingAttachments = useChatStore((s) => s.addPendingAttachments);
  const removePendingAttachment = useChatStore((s) => s.removePendingAttachment);

  const [isFocused, setIsFocused] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const [activeMenuIdx, setActiveMenuIdx] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  // Single source of truth for which voice path is active. PC and
  // ESP32 are mutually exclusive — starting one auto-stops the other.
  const [voiceSource, setVoiceSource] = useState<'idle' | 'pc' | 'esp32'>(
    'idle',
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Counter ref: dragenter/dragleave fire for every child element the
  // cursor traverses, so a single boolean would flicker. Incrementing
  // on enter / decrementing on leave — and checking zero — tells us
  // whether we're still inside the drop zone overall.
  const dragDepthRef = useRef(0);
  // Voice-session refs — kept out of React state since they change on
  // every recognition / WS event and we don't want a re-render per word.
  const micHandleRef = useRef<SpeechRecognitionHandle | null>(null);
  const esp32WsRef = useRef<WebSocket | null>(null);
  const micBaseTextRef = useRef('');
  const micFinalRef = useRef('');
  // Last string we pushed to setInput. Compared against the live
  // textarea value on every SR event to detect manual edits: if they
  // differ, the user has hand-corrected since our last write, and we
  // adopt their version as the new base so the next SR chunk APPENDS
  // to the correction instead of stomping it.
  const lastMicWrittenRef = useRef('');
  // User is actively recording with the PC mic. Chrome auto-ends
  // continuous recognition on silence (`no-speech` error → `end` event);
  // when this flag is true we re-create the recognition object so the
  // session feels continuous to the user.
  const pcKeepListeningRef = useRef(false);
  // Track consecutive auto-restarts in a short window. If we spin too
  // fast we bail — usually means the mic truly isn't producing audio.
  const pcRestartCountRef = useRef(0);
  const pcLastRestartMsRef = useRef(0);

  // Slash-menu matches are derived from the current input. Showing the
  // menu is purely a function of "does the input look like an in-
  // progress slash command" — no extra open/close state needed.
  const menuMatches = useMemo(
    () => getMenuMatches(input, commands),
    [input, commands],
  );
  const menuOpen = menuMatches.length > 0;

  // Keep activeIndex in bounds whenever the filtered list changes
  if (activeMenuIdx >= menuMatches.length && menuMatches.length > 0) {
    setActiveMenuIdx(0);
  }

  // --- Slash dispatch helpers --------------------------------------

  // Forward the current raw input so ChatPage can parse args for the
  // command (needed for server commands that substitute $ARGUMENTS).
  const dispatchCommand = (cmd: SlashCommand) => {
    onSlashDispatch(cmd, input);
  };

  // --- Attachment picker -------------------------------------------

  const handleAttachClick = async () => {
    setAttachBusy(true);
    try {
      const result = await claudeApi.pickFile({
        multiple: true,
        includeContent: true,
        maxContentBytes: 50 * 1024,
      });
      if (result.error) {
        window.alert(`File picker failed:\n${result.error}`);
        return;
      }
      if (result.files.length === 0) return; // user cancelled
      addPendingAttachments(
        result.files.map((f) => ({
          id:
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `att_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          path: f.path,
          filename: f.filename,
          sizeBytes: f.sizeBytes,
          mimeType: f.mimeType,
          kind: f.kind,
          content: f.content,
        })),
      );
    } finally {
      setAttachBusy(false);
    }
  };

  // --- Recording drop handler --------------------------------------
  //
  // Triggered when the user drags a card from RecordingsPanel and
  // releases it over the textarea area. We fetch a CSV preview (small
  // head cut) from the Python backend and materialize a PendingAttachment
  // with kind='recording'; the prompt builder later inlines the preview
  // and lists paths so Claude can Read full content on demand.

  const buildRecordingAttachment = async (
    payload: RecordingDragPayload,
  ): Promise<PendingAttachment> => {
    let csvPreview: string | undefined;
    if (payload.csvFilename) {
      // Fetch either full content (tiny files) or just a head preview.
      // Full CSV path is always included in the prompt so Claude can
      // Read more rows if needed.
      const head =
        (payload.csvSizeBytes ?? 0) <= RECORDING_CSV_INLINE_BYTES
          ? undefined
          : RECORDING_CSV_PREVIEW_ROWS;
      const res = await recordingsApi.csvContent(payload.csvFilename, { head });
      if (res.text) csvPreview = res.text;
    }

    const primaryFilename =
      payload.csvFilename ||
      payload.audioFilename ||
      `recording_${payload.id}`;
    const sizeBytes =
      (payload.csvSizeBytes || 0) + (payload.audioSizeBytes || 0);

    return {
      id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `rec_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      // We stash the session id into `path` so prompt rendering shows
      // something meaningful. The real file paths are on the backend
      // (Python `RECORDINGS_DIR`); Claude doesn't need absolute FS
      // access because the prompt block includes an HTTP audio URL and
      // the CSV content preview inline.
      path: `(ESP32 session ${payload.id})`,
      filename: primaryFilename,
      sizeBytes,
      mimeType: payload.csvFilename ? 'text/csv' : 'audio/wav',
      kind: 'recording',
      content: csvPreview,
      recording: {
        sessionId: payload.id,
        csvFilename: payload.csvFilename,
        csvRows: payload.csvRows,
        audioFilename: payload.audioFilename,
        audioDurationSeconds: payload.audioDurationSeconds,
        audioSizeBytes: payload.audioSizeBytes,
        audioUrl: payload.audioFilename
          ? recordingsApi.audioUrl(payload.audioFilename)
          : undefined,
      },
    };
  };

  const handleDragEnter = (e: React.DragEvent) => {
    // Only claim the drop when a recording payload is actually present,
    // so dragging generic OS files doesn't trigger our visual state.
    if (!e.dataTransfer.types.includes(RECORDING_DRAG_MIME)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(RECORDING_DRAG_MIME)) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(RECORDING_DRAG_MIME)) return;
    // preventDefault on dragover is what actually enables drop — without
    // it the browser falls back to its native "rejected" cursor.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = async (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(RECORDING_DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);

    let payload: RecordingDragPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      window.alert('Recording drop: malformed payload');
      return;
    }
    if (!payload.id) return;

    try {
      const att = await buildRecordingAttachment(payload);
      addPendingAttachments([att]);
    } catch (err) {
      window.alert(
        `Failed to attach recording ${payload.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  // --- Voice input (PC SpeechRecognition / ESP32 Whisper WS) --------
  //
  // Two mutually-exclusive paths write into the same textarea:
  //   PC: local browser SpeechRecognition (zero cost, no extension)
  //   ESP32: /ws/transcribe streams Whisper-local transcripts from the
  //          Python backend (requires whisper-local extension enabled)
  //
  // Shared invariants:
  //   - baseText captured at start; finals append; interim replaces each event
  //   - textarea is never auto-submitted (user Enter-sends intentionally)
  //   - starting one path stops the other first

  const micSupported = isSpeechRecognitionSupported();

  // Recombine base text + accumulated finals + current interim; push
  // to textarea. Reconciles against manual user edits first:
  //   if the live textarea value differs from what we last wrote,
  //   the user has hand-edited since our last tick — adopt their
  //   version as the new base + clear the accumulated final buffer
  //   so the user's correction is preserved and subsequent speech
  //   appends to it instead of overwriting it.
  const writeMicInput = (currentInterim: string) => {
    const current = useChatStore.getState().input;
    if (current !== lastMicWrittenRef.current) {
      micBaseTextRef.current = current;
      micFinalRef.current = '';
    }
    const base = micBaseTextRef.current;
    const final = micFinalRef.current;
    const baseSep = base && !/\s$/.test(base) ? ' ' : '';
    const next = base + baseSep + final + currentInterim;
    lastMicWrittenRef.current = next;
    setInput(next);
  };

  const stopPcMic = () => {
    // Mark as intentional: the onEnd handler below checks this to
    // decide whether to auto-restart (Chrome silence-stop) or clean up.
    pcKeepListeningRef.current = false;
    micHandleRef.current?.stop();
    micHandleRef.current = null;
  };

  const stopEsp32Ws = () => {
    const ws = esp32WsRef.current;
    esp32WsRef.current = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };

  const resetVoiceSession = () => {
    // Called when either source ends. Flush the final buffer into the
    // input one more time (interim was already dropped) and go idle.
    writeMicInput('');
    micBaseTextRef.current = '';
    micFinalRef.current = '';
    setVoiceSource('idle');
  };

  // Single recognition-session spawn. Factored out so the onEnd
  // handler can auto-restart without duplicating the options block.
  // Reads voiceLang live from the store each spawn so auto-restarts
  // after a language change pick up the new code.
  const spawnPcRecognition = () => {
    const lang = useChatStore.getState().voiceLang;
    const handle = startSpeechRecognition(lang, {
      onStart: () => {
        console.debug('[mic] pc recognition started');
        setVoiceSource('pc');
      },
      onInterim: (interim) => writeMicInput(interim),
      onFinal: (delta) => {
        console.debug('[mic] final chunk:', delta);
        micFinalRef.current += delta;
        writeMicInput('');
      },
      onError: (code) => {
        // `no-speech` and `aborted` are expected in continuous mode —
        // they arrive every silence window and when we call stop().
        // Don't pester the user with toasts, but DO log at `log` level
        // (not debug) so the full event trace is visible without the
        // Verbose console filter.
        if (SILENT_SPEECH_ERRORS.has(code)) {
          console.log('[mic] silent error:', code);
          return;
        }
        console.warn('[mic] real error:', code);
        // Stop auto-restarting once we hit a real error — something
        // the user must resolve (permission, missing device, network).
        pcKeepListeningRef.current = false;
        onModeChangeAnnounce?.(explainSpeechError(code));
      },
      onEnd: () => {
        // Chrome ends recognition on ~every long silence. If the user
        // hasn't clicked stop, resume the session transparently so it
        // feels continuous. Throttle to avoid a spin-loop when the mic
        // is genuinely broken (no audio ever coming in).
        if (pcKeepListeningRef.current) {
          const now = Date.now();
          if (now - pcLastRestartMsRef.current < 1500) {
            pcRestartCountRef.current += 1;
          } else {
            pcRestartCountRef.current = 1;
          }
          pcLastRestartMsRef.current = now;
          if (pcRestartCountRef.current > 5) {
            console.warn(
              '[mic] too many rapid restarts — giving up.',
              'This usually means Chrome got the mic stream but the Web Speech',
              'service (Google STT backend) is unreachable or timing out.',
              'Check network / try again / or consider installing the Whisper',
              'extension (Settings → Extensions) for a fully-local path.',
            );
            onModeChangeAnnounce?.(
              'Speech service is unreachable. Chrome Web Speech uses Google\'s servers; ' +
                'check internet, or install the Whisper-local extension in Settings for offline transcription.',
            );
            pcKeepListeningRef.current = false;
            resetVoiceSession();
            return;
          }
          console.debug(
            `[mic] silent end — auto-restart #${pcRestartCountRef.current}`,
          );
          try {
            micHandleRef.current = spawnPcRecognition();
            return;
          } catch (err) {
            console.error('[mic] restart failed:', err);
            pcKeepListeningRef.current = false;
          }
        }
        // Genuine end (user clicked stop, or restart failed).
        console.debug('[mic] session fully ended');
        resetVoiceSession();
      },
    });
    return handle;
  };

  const handleMicClick = async () => {
    // Toggle off: clicking the same button that's active
    if (voiceSource === 'pc') {
      console.log('[mic] user stopped pc mic');
      stopPcMic();
      return;
    }
    if (!micSupported) {
      onModeChangeAnnounce?.(
        'Voice input not supported in this browser. Use Chrome or Edge.',
      );
      return;
    }
    if (isLoading) return;

    // Pre-flight: prove the browser can actually open a mic stream
    // and capture audio before we hand off to SpeechRecognition. This
    // turns cryptic "empty end loop" failures into clear diagnostics:
    //   - permission denied → we say so
    //   - no device / device busy → we say so
    //   - permission OK but -Infinity dB → warn about muted / wrong device
    console.log('[mic] running pre-flight getUserMedia check...');
    const diag = await preflightMicrophone(500);
    console.log('[mic] preflight diagnostic:', diag);
    if (!diag.ok) {
      onModeChangeAnnounce?.(diag.reason || 'Microphone unavailable.');
      return;
    }
    if (diag.sampled && diag.rmsDb !== undefined && diag.rmsDb <= -80) {
      // Browser got the stream but saw essentially no signal. Still try
      // — the user might just be silent before the button click — but
      // warn them so they know what to fix if it stays broken.
      onModeChangeAnnounce?.(
        `Mic "${diag.deviceLabel}" is reachable but nearly silent (${diag.rmsDb.toFixed(0)} dB). ` +
          'Check that it\'s the right device and not muted in Windows / Chrome sound settings.',
      );
    } else if (diag.sampled && diag.deviceLabel) {
      console.log(`[mic] using device "${diag.deviceLabel}", peak ${diag.rmsDb?.toFixed(1)} dB`);
    }

    // Stop the other path first — they share baseText / final buffers
    if (voiceSource === 'esp32') {
      stopEsp32Ws();
    }
    console.log('[mic] starting pc recognition, current input length:', input.length);
    micBaseTextRef.current = input;
    micFinalRef.current = '';
    // Seed lastWritten so the first SR event doesn't trigger a false
    // "user edited" reconcile — at session start, the textarea IS
    // exactly what we consider the base.
    lastMicWrittenRef.current = input;
    pcKeepListeningRef.current = true;
    pcRestartCountRef.current = 0;
    pcLastRestartMsRef.current = 0;
    try {
      micHandleRef.current = spawnPcRecognition();
    } catch (err) {
      console.error('[mic] failed to start:', err);
      pcKeepListeningRef.current = false;
      setVoiceSource('idle');
      onModeChangeAnnounce?.(
        err instanceof Error
          ? err.message
          : 'Could not start speech recognition',
      );
    }
  };

  const handleEsp32MicClick = () => {
    if (voiceSource === 'esp32') {
      stopEsp32Ws();
      return;
    }
    if (isLoading) return;

    if (voiceSource === 'pc') {
      stopPcMic();
    }
    micBaseTextRef.current = input;
    micFinalRef.current = '';
    lastMicWrittenRef.current = input;

    // Vite proxies /ws/* to the Python backend. The protocol mirrors
    // `location.protocol` so the same code works under HTTPS in prod.
    // Pass voiceLang via query string so the Whisper extension can
    // pin its decoder to that language — fixes the "random language
    // every chunk" issue auto-detect has on noisy audio.
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const lang = useChatStore.getState().voiceLang;
    const url = `${proto}//${window.location.host}/ws/transcribe?lang=${encodeURIComponent(lang)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      window.alert(
        `Could not open ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    esp32WsRef.current = ws;

    ws.onopen = () => {
      setVoiceSource('esp32');
    };
    ws.onmessage = (evt) => {
      let msg: { kind?: string; text?: string; message?: string };
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.kind === 'partial' && typeof msg.text === 'string') {
        // ESP32 path: each chunk's output is treated as final (Whisper
        // doesn't deliver interim revisions) — append with a separator.
        const sep =
          micFinalRef.current && !/\s$/.test(micFinalRef.current) ? ' ' : '';
        micFinalRef.current += sep + msg.text;
        writeMicInput('');
      } else if (msg.kind === 'error') {
        window.alert(`ESP32 transcription error: ${msg.message || 'unknown'}`);
        stopEsp32Ws();
      } else if (msg.kind === 'notice') {
        // Non-fatal hint from backend (e.g. "start UDP listener first").
        onModeChangeAnnounce?.(msg.message || '');
      }
      // 'ready' / 'ping' are no-ops on this end.
    };
    ws.onerror = () => {
      // onerror fires without detail; give the user something actionable.
      window.alert(
        'ESP32 WebSocket errored. Is the Python backend running and is ' +
          'Whisper-local enabled in Settings?',
      );
    };
    ws.onclose = () => {
      resetVoiceSession();
    };
  };

  // --- Slash button in toolbar -------------------------------------

  const handleSlashClick = () => {
    // Insert `/` at the cursor (or end) — the normal menu detection
    // logic then takes over. Refocus + move caret to end for UX.
    const prefix = input.length === 0 || input.endsWith(' ') ? '' : ' ';
    const next = input + prefix + '/';
    setInput(next);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  };

  // --- Submit flow --------------------------------------------------

  const submitCurrent = () => {
    if (isLoading) return;
    const text = input.trim();
    if (!text && pendingAttachments.length === 0) return;

    // Slash command takes precedence when input starts with `/` and
    // has an exact registered name match. Otherwise, send as message.
    const cmd = resolveCommand(text, commands);
    if (cmd) {
      dispatchCommand(cmd);
      return;
    }

    onSend(text);
    setInput('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitCurrent();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Menu navigation takes over only when the menu is visible
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveMenuIdx((i) => (i + 1) % menuMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveMenuIdx((i) => (i - 1 + menuMatches.length) % menuMatches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const picked = menuMatches[activeMenuIdx];
        if (picked) dispatchCommand(picked);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Clearing the `/` prefix closes the menu without losing the rest
        setInput('');
        return;
      }
      // Any other key: let textarea handle normally, menu will re-filter
      // on the input change.
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitCurrent();
    }
  };

  const hasSendable =
    input.trim().length > 0 || pendingAttachments.length > 0;

  return (
    <div className="bg-card-bg border-t border-card-border">
      {/* Row 1: Attachment pills (only when present) */}
      <AttachmentPills
        attachments={pendingAttachments}
        onRemove={removePendingAttachment}
      />

      {/* Row 2: Textarea + Send/Stop. `relative` anchors the slash menu.
          onDrag* handlers at this level (not the textarea) so the
          whole card including Send button is a drop target — users
          don't have to aim precisely at the small textarea rectangle. */}
      <div
        className="relative p-4"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {menuOpen && (
          <SlashCommandMenu
            commands={menuMatches}
            activeIndex={activeMenuIdx}
            onSelect={dispatchCommand}
            onHoverIndex={setActiveMenuIdx}
          />
        )}
        {isDragOver && (
          <div className="absolute inset-2 pointer-events-none border-2 border-dashed border-blue-500/70 rounded-lg bg-blue-500/10 z-10 flex items-center justify-center">
            <span className="text-sm text-blue-400 font-medium">
              🎙️ Drop recording to attach
            </span>
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex gap-3">
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="Type your message to Claude... (`/` for commands, drag a recording to attach)"
              disabled={isLoading}
              rows={1}
              className={`w-full bg-window-bg border rounded-lg px-4 py-3 text-text-primary placeholder-text-muted resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all ${
                isFocused ? 'border-blue-500/50' : 'border-card-border'
              } ${isLoading ? 'opacity-50' : ''}`}
              style={{ minHeight: '48px', maxHeight: '120px' }}
            />
          </div>

          <div className="flex gap-2">
            {isLoading ? (
              <button
                type="button"
                onClick={onAbort}
                className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
              >
                <span className="text-lg">⏹</span>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!hasSendable || isLoading}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-card-border disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors flex items-center gap-2"
              >
                <span className="text-lg">➤</span>
                Send
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Row 3: the toolbar strip (+ / 🎤 [PC] 🎛️ [ESP32] | cwd | pills) */}
      <ChatInputTools
        cwd={cwd}
        onAttachClick={handleAttachClick}
        onSlashClick={handleSlashClick}
        onMicClick={handleMicClick}
        onEsp32MicClick={handleEsp32MicClick}
        attachBusy={attachBusy}
        micState={voiceSource === 'pc' ? 'listening' : 'idle'}
        micSupported={micSupported}
        esp32MicAvailable={esp32MicAvailable}
        esp32MicListening={voiceSource === 'esp32'}
        onModeChangeAnnounce={onModeChangeAnnounce}
      />
    </div>
  );
}
