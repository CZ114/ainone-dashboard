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
export interface RecordingDragPayload {
  id: string;
  csvFilename?: string;
  audioFilename?: string;
  csvSizeBytes?: number;
  csvRows?: number | null;
  audioSizeBytes?: number;
  audioDurationSeconds?: number | null;
}

function payloadFromSession(s: RecordingSession): RecordingDragPayload {
  return {
    id: s.id,
    csvFilename: s.csv?.filename,
    csvSizeBytes: s.csv?.size_bytes,
    csvRows: s.csv?.rows,
    audioFilename: s.audio?.filename,
    audioSizeBytes: s.audio?.size_bytes,
    audioDurationSeconds: s.audio?.duration_seconds,
  };
}

export function RecordingsPanel({ open, onClose }: RecordingsPanelProps) {
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    // Refresh every time the drawer opens — cheap, keeps list current
    // without needing a WS event for new recordings.
    if (open) void refresh();
  }, [open, refresh]);

  const handleDragStart = (
    e: React.DragEvent<HTMLDivElement>,
    session: RecordingSession,
  ) => {
    const payload = payloadFromSession(session);
    e.dataTransfer.setData(RECORDING_DRAG_MIME, JSON.stringify(payload));
    // text/plain fallback so if the user drops on a non-chat target
    // (say, a regular textarea elsewhere), they get something sensible.
    e.dataTransfer.setData(
      'text/plain',
      `ESP32 recording ${session.id} — ` +
        (session.csv?.filename || session.audio?.filename || 'empty'),
    );
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <>
      {/* Backdrop — click to close */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40"
          onClick={onClose}
          aria-hidden
        />
      )}

      {/* Drawer — slides in from right */}
      <aside
        className={`fixed right-0 top-0 bottom-0 w-80 bg-card-bg border-l border-card-border shadow-2xl z-50 flex flex-col transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
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
              Drag a session into chat to attach
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

          {!error && sessions.length === 0 && !loading && (
            <div className="text-center text-xs text-text-muted px-4 py-10">
              No recordings yet.
              <br />
              Start one from the Dashboard.
            </div>
          )}

          {!error &&
            sessions.map((s) => (
              <div
                key={s.id}
                draggable
                onDragStart={(e) => handleDragStart(e, s)}
                className="mx-1 my-1 p-3 rounded-md bg-window-bg border border-card-border hover:border-blue-500/50 hover:bg-card-border/30 cursor-grab active:cursor-grabbing transition-colors"
                title="Drag into chat to attach"
              >
                <div className="flex items-center gap-2">
                  <span className="text-lg shrink-0">
                    {s.csv && s.audio ? '🎙️' : s.csv ? '📊' : '🔊'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-mono text-text-primary truncate">
                      {formatTimestamp(s.started_at_iso, s.id)}
                    </div>
                    <div className="text-[11px] text-text-muted flex flex-wrap gap-x-2">
                      {s.csv && (
                        <span>
                          📊 {s.csv.rows ?? '?'} rows · {formatSize(s.csv.size_bytes)}
                        </span>
                      )}
                      {s.audio && (
                        <span>
                          🔊 {formatDuration(s.audio.duration_seconds)} ·{' '}
                          {formatSize(s.audio.size_bytes)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
        </div>

        {/* Footer hint */}
        <div className="shrink-0 px-3 py-2 border-t border-card-border text-[11px] text-text-muted">
          Session ID = <code>YYYYMMDD_HHMMSS</code>
        </div>
      </aside>
    </>
  );
}
