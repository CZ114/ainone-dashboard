// Recordings drawer — right-side floating panel that lists saved ESP32
// recording sessions (CSV + optional WAV) from the Python backend.
//
// Users drag a session card onto the ChatInput textarea to attach it to
// the next message as context. The drag payload is a custom MIME
// (RECORDING_DRAG_MIME) carrying the session's metadata; ChatInput's
// drop handler fetches a CSV preview and materializes a PendingAttachment.
//
// The panel is self-contained: it owns fetching, loading/error state,
// and a refresh button. It does not touch chatStore directly — attachments
// are created on the receiving side (ChatInput drop handler).

import { useEffect, useState, useCallback } from 'react';
import { recordingsApi, type RecordingSession } from '../../api/recordingsApi';
import { RECORDING_DRAG_MIME, formatSize } from '../../lib/attachments';

interface RecordingsPanelProps {
  open: boolean;
  onClose: () => void;
}

function formatTimestamp(iso: string | null, fallback: string): string {
  if (!iso) return fallback;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return fallback;
    // e.g. "Apr 24, 14:30:22" — month short + HH:MM:SS
    const month = d.toLocaleString('en', { month: 'short' });
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${month} ${day}, ${hh}:${mm}:${ss}`;
  } catch {
    return fallback;
  }
}

function formatDuration(sec: number | null | undefined): string {
  if (sec == null || Number.isNaN(sec)) return '–';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

// What we put on dataTransfer. Intentionally tiny — just enough for
// the drop handler to fetch the preview and build an attachment.
// Full type lives in lib/attachments.ts consumers.
//
// `mode` selects which files of the session are being attached:
//   'csv'   — sensor CSV only
//   'audio' — WAV audio only
//   'both'  — both files (default for whole-card drags)
// Drop handlers in ChatInput respect this so the user can attach
// just the readings, just the audio, or the full bundle.
export type RecordingDragMode = 'csv' | 'audio' | 'both';

export interface RecordingDragPayload {
  id: string;
  mode: RecordingDragMode;
  csvFilename?: string;
  audioFilename?: string;
  csvSizeBytes?: number;
  csvRows?: number | null;
  audioSizeBytes?: number;
  audioDurationSeconds?: number | null;
}

function payloadFromSession(
  s: RecordingSession,
  mode: RecordingDragMode,
): RecordingDragPayload {
  return {
    id: s.id,
    mode,
    csvFilename: mode !== 'audio' ? s.csv?.filename : undefined,
    csvSizeBytes: mode !== 'audio' ? s.csv?.size_bytes : undefined,
    csvRows: mode !== 'audio' ? s.csv?.rows : undefined,
    audioFilename: mode !== 'csv' ? s.audio?.filename : undefined,
    audioSizeBytes: mode !== 'csv' ? s.audio?.size_bytes : undefined,
    audioDurationSeconds:
      mode !== 'csv' ? s.audio?.duration_seconds : undefined,
  };
}

// Per-session transcription state. Stored in a Map keyed by session
// id so each row renders independently — clicking Transcribe on one
// recording doesn't reset another's state.
type TranscriptStatus = 'idle' | 'loading' | 'done' | 'error';
interface TranscriptEntry {
  status: TranscriptStatus;
  text?: string;
  language?: string | null;
  duration_seconds?: number;
  transcribe_ms?: number;
  error?: string;
}

export function RecordingsPanel({ open, onClose }: RecordingsPanelProps) {
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Map<string, TranscriptEntry>>(
    new Map(),
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await recordingsApi.list();
    if (result.error) {
      setError(result.error);
      setSessions([]);
    } else {
      setSessions(result.sessions);
    }
    setLoading(false);
  }, []);

  const handleTranscribe = useCallback(
    async (sessionId: string, audioFilename: string) => {
      // Set loading immediately so the UI flips before the network
      // request — the user sees their click acknowledged within one
      // frame, not after the round-trip.
      setTranscripts((prev) => {
        const next = new Map(prev);
        next.set(sessionId, { status: 'loading' });
        return next;
      });
      const r = await recordingsApi.transcribeAudio(audioFilename);
      setTranscripts((prev) => {
        const next = new Map(prev);
        if (r.error) {
          next.set(sessionId, { status: 'error', error: r.error });
        } else {
          next.set(sessionId, {
            status: 'done',
            text: r.text,
            language: r.language,
            duration_seconds: r.duration_seconds,
            transcribe_ms: r.transcribe_ms,
          });
        }
        return next;
      });
    },
    [],
  );

  const handleClearTranscript = useCallback((sessionId: string) => {
    setTranscripts((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  useEffect(() => {
    // Refresh every time the drawer opens — cheap, keeps list current
    // without needing a WS event for new recordings.
    if (open) void refresh();
  }, [open, refresh]);

  const handleDragStart = (
    e: React.DragEvent<HTMLElement>,
    session: RecordingSession,
    mode: RecordingDragMode,
  ) => {
    const payload = payloadFromSession(session, mode);
    e.dataTransfer.setData(RECORDING_DRAG_MIME, JSON.stringify(payload));
    // text/plain fallback so if the user drops on a non-chat target
    // (say, a regular textarea elsewhere), they get something sensible.
    const summary =
      mode === 'csv'
        ? session.csv?.filename || 'sensor data'
        : mode === 'audio'
        ? session.audio?.filename || 'audio'
        : `${session.csv?.filename || ''} ${session.audio?.filename || ''}`.trim();
    e.dataTransfer.setData(
      'text/plain',
      `ESP32 recording ${session.id}${mode === 'both' ? '' : ` (${mode})`} — ${summary}`,
    );
    e.dataTransfer.effectAllowed = 'copy';
    e.stopPropagation();
  };

  return (
    <>
      {/* No backdrop on purpose — the chat must remain interactive
          while the user drags a session card across the page. The
          previous black/40 overlay greyed out the chat and stole all
          pointer events, breaking drag-to-attach. The X button in
          the panel header is the only dismissal affordance. */}

      {/* Drawer — slides in from right */}
      <aside
        className={`fixed right-0 top-0 bottom-0 w-80 bg-card-bg border-l border-card-border shadow-2xl z-50 flex flex-col transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        }`}
        aria-hidden={!open}
      >
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-card-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              🎙️ Recordings
            </h2>
            <p className="text-xs text-text-muted">
              Drag CSV, audio, or both into chat to attach
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={refresh}
              disabled={loading}
              className="px-2 py-1 text-xs rounded text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors disabled:opacity-50"
              title="Refresh list"
            >
              {loading ? '⏳' : '↻'}
            </button>
            <button
              onClick={onClose}
              className="px-2 py-1 text-xs rounded text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors"
              title="Close"
              aria-label="Close recordings panel"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-2">
          {error && (
            <div className="mx-2 my-3 p-3 text-xs bg-red-500/10 border border-red-500/30 rounded text-red-400">
              <div className="font-semibold mb-1">Failed to load recordings</div>
              <div className="break-all">{error}</div>
              <div className="mt-2 text-text-muted">
                Is the Python backend running at <code>127.0.0.1:8080</code>?
              </div>
            </div>
          )}

          {/* Feature hint — visible whenever there's at least one
              audio recording so the user discovers the new
              click-to-transcribe action. Sits above the list, not
              inside any individual card, so it doesn't repeat. */}
          {!error && sessions.some((s) => !!s.audio) && (
            <div className="mx-1 my-2 p-2 rounded bg-blue-500/10 border border-blue-500/30 text-[11px] text-blue-300 leading-relaxed">
              ✨ <span className="font-semibold">New:</span> click{' '}
              <span className="font-mono px-1 py-0.5 bg-blue-500/20 rounded">
                Transcribe
              </span>{' '}
              on any audio row to convert it to text via Whisper. Runs
              locally — no audio leaves your machine.
            </div>
          )}

          {!error && sessions.length === 0 && !loading && (
            <div className="text-center text-xs text-text-muted px-4 py-10">
              No recordings yet.
              <br />
              Start one from the Dashboard.
            </div>
          )}

          {!error &&
            sessions.map((s) => {
              const hasBoth = !!s.csv && !!s.audio;
              return (
                <div
                  key={s.id}
                  className="mx-1 my-1 p-3 rounded-md bg-window-bg border border-card-border hover:border-blue-500/50 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg shrink-0">
                      {hasBoth ? '🎙️' : s.csv ? '📊' : '🔊'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-mono text-text-primary truncate">
                        {formatTimestamp(s.started_at_iso, s.id)}
                      </div>
                    </div>
                  </div>

                  {/* Per-file drag handles. Each row is its own drag
                      source so the user can attach CSV alone, audio
                      alone, or — via the bundle handle below — both. */}
                  <div className="space-y-1">
                    {s.csv && (
                      <div
                        draggable
                        onDragStart={(e) => handleDragStart(e, s, 'csv')}
                        className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-card-bg border border-card-border/60 hover:border-blue-500/60 cursor-grab active:cursor-grabbing transition-colors"
                        title="Drag CSV into chat"
                      >
                        <span className="text-[11px] text-text-secondary truncate">
                          📊 {s.csv.rows ?? '?'} rows · {formatSize(s.csv.size_bytes)}
                        </span>
                        <span className="text-[10px] text-text-muted shrink-0">
                          drag CSV
                        </span>
                      </div>
                    )}
                    {s.audio && (
                      <AudioRow
                        session={s}
                        audioFilename={s.audio.filename}
                        durationSeconds={s.audio.duration_seconds}
                        sizeBytes={s.audio.size_bytes}
                        transcript={transcripts.get(s.id)}
                        onTranscribe={() =>
                          handleTranscribe(s.id, s.audio!.filename)
                        }
                        onClearTranscript={() => handleClearTranscript(s.id)}
                        onDragStart={(e) => handleDragStart(e, s, 'audio')}
                      />
                    )}
                    {hasBoth && (
                      <div
                        draggable
                        onDragStart={(e) => handleDragStart(e, s, 'both')}
                        className="flex items-center justify-center gap-2 px-2 py-1.5 rounded bg-blue-500/10 border border-blue-500/40 hover:bg-blue-500/20 cursor-grab active:cursor-grabbing transition-colors"
                        title="Drag both files into chat as a single attachment"
                      >
                        <span className="text-[11px] text-blue-300">
                          📊 + 🔊 drag both
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
        </div>

        {/* Footer hint */}
        <div className="shrink-0 px-3 py-2 border-t border-card-border text-[11px] text-text-muted">
          Session ID = <code>YYYYMMDD_HHMMSS</code>
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// AudioRow — one row of the per-session audio listing. Holds its own
// drag source AND a Transcribe button + animated transcript panel.
//
// Animation strategy: we use `display: grid` with `grid-template-rows`
// transitioning from `0fr` to `1fr`. This is the modern way to
// animate to/from intrinsic content height — `max-height` workarounds
// require guessing a "tall enough" value and produce abrupt collapses
// on long content. grid-template-rows gives true content-driven
// animation in 4 lines of CSS.

interface AudioRowProps {
  session: RecordingSession;
  audioFilename: string;
  durationSeconds: number | null | undefined;
  sizeBytes: number;
  transcript: TranscriptEntry | undefined;
  onTranscribe: () => void;
  onClearTranscript: () => void;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
}

function AudioRow({
  audioFilename,
  durationSeconds,
  sizeBytes,
  transcript,
  onTranscribe,
  onClearTranscript,
  onDragStart,
}: AudioRowProps) {
  const status = transcript?.status ?? 'idle';
  const expanded = status !== 'idle';

  return (
    <div className="space-y-1">
      <div
        draggable
        onDragStart={onDragStart}
        className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-card-bg border border-card-border/60 hover:border-blue-500/60 cursor-grab active:cursor-grabbing transition-colors"
        title="Drag audio into chat"
      >
        <span className="text-[11px] text-text-secondary truncate flex-1 min-w-0">
          🔊 {formatDuration(durationSeconds)} · {formatSize(sizeBytes)}
        </span>
        <button
          // Keep the click off the drag source: stopPropagation
          // prevents the click triggering the drag's onDragStart on
          // browsers that fire one before the other.
          onClick={(e) => {
            e.stopPropagation();
            if (status === 'loading') return;
            onTranscribe();
          }}
          disabled={status === 'loading'}
          draggable={false}
          onDragStart={(e) => {
            // Don't let the drag bubble up — the parent row is the
            // intended drag source, the button isn't.
            e.preventDefault();
            e.stopPropagation();
          }}
          className="shrink-0 px-2 py-0.5 text-[10px] rounded border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 disabled:opacity-50 disabled:cursor-wait"
          title={
            status === 'loading'
              ? 'Whisper is decoding…'
              : status === 'done'
                ? 'Re-transcribe'
                : 'Transcribe with Whisper (runs locally)'
          }
        >
          {status === 'loading'
            ? '⏳ Transcribing'
            : status === 'done'
              ? '↻ Re-transcribe'
              : 'Transcribe'}
        </button>
      </div>

      {/* Animated transcript panel. Closed = grid-template-rows:0fr,
          open = 1fr. The inner div has overflow:hidden so collapsed
          content is clipped. Transition runs on grid-template-rows
          + opacity for a subtle fade-in, ~250ms ease-in-out. */}
      <div
        className={`grid transition-all duration-300 ease-in-out ${
          expanded
            ? 'grid-rows-[1fr] opacity-100'
            : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="mx-1 mt-1 p-2 rounded bg-window-bg border border-card-border/40 text-[11px] text-text-secondary">
            {status === 'loading' && (
              <div className="flex items-center gap-2 text-amber-400">
                <span className="animate-pulse">●</span>
                <span>Whisper is decoding{' '}{audioFilename}…</span>
              </div>
            )}

            {status === 'error' && (
              <div className="space-y-1">
                <div className="text-red-400 font-semibold">
                  Transcription failed
                </div>
                <div className="text-red-400/80 break-all">
                  {transcript?.error}
                </div>
                <button
                  onClick={onClearTranscript}
                  className="mt-1 text-[10px] text-text-muted hover:text-text-primary underline"
                >
                  dismiss
                </button>
              </div>
            )}

            {status === 'done' && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[10px] text-text-muted">
                  <span>
                    {transcript?.language ?? '?'} ·{' '}
                    {transcript?.transcribe_ms != null
                      ? `decoded in ${(transcript.transcribe_ms / 1000).toFixed(1)}s`
                      : ''}
                  </span>
                  <button
                    onClick={onClearTranscript}
                    className="ml-auto text-[10px] text-text-muted hover:text-text-primary"
                    title="Hide transcript"
                  >
                    ✕
                  </button>
                </div>
                <div className="whitespace-pre-wrap break-words leading-relaxed text-text-primary">
                  {transcript?.text || (
                    <span className="text-text-muted italic">
                      (empty — VAD filtered the audio as silence)
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
