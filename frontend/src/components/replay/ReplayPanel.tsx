/**
 * ReplayPanel — Dashboard sidebar control for replaying a recorded
 * CSV through the channel grid.
 *
 * Layout: card matching the other sidebar panels (ConnectionPanel,
 * DisplaySettings) so it slots naturally into the aside column.
 *
 * Once a recording is loaded we expose:
 *   - A clickable progress bar (also serves as a scrub track)
 *   - Play / pause / stop / restart buttons (single transport row,
 *     shape adapts to current state)
 *   - A speed picker (0.5× / 1× / 2× / 4×)
 *
 * The fetched recording list is sorted newest-first by the FastAPI
 * endpoint already, so we just render it in order. We don't poll —
 * the user explicitly picks "refresh" when they want to see new
 * recordings (keeping the panel quiet during normal use).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { recordingsApi, type RecordingSession } from '../../api/recordingsApi';
import { useReplay } from '../../hooks/useReplay';
import { useT } from '../../contexts/LanguageContext';
import { useStore } from '../../store';
import { isDemoMode } from '../../lib/demoMode';

const SPEEDS = [0.5, 1, 2, 4];

export function ReplayPanel() {
  const t = useT();
  const replay = useReplay();

  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string>('');
  // Mark in / mark out for clip export. Both default to "no clip
  // selected" — only when both are set do we offer the Export
  // button. They snap to the current playhead when set.
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  const [markOutMs, setMarkOutMs] = useState<number | null>(null);

  // Cross-page replay command — RecordingsPanel (chat page) writes
  // to this when the user clicks its inline Play button, then routes
  // them to the dashboard. We watch for changes to `nonce` so the
  // same session can be played twice in a row.
  const replayRequest = useStore((s) => s.replayRequest);
  const clearReplayRequest = useStore((s) => s.clearReplayRequest);

  // Demo synthetic stream control — surfaced as a small button in
  // this panel's header (only in demo mode). The actual emission
  // lives in useDemoSensorStream, mounted in AppBridge; we just
  // flip the play flag here. Disabled when a real source is active
  // because the underlying hook would refuse to emit anyway.
  const demoMode = isDemoMode();
  const demoStreamRunning = useStore((s) => s.demoStreamRunning);
  const setDemoStreamRunning = useStore((s) => s.setDemoStreamRunning);
  const serialConnected = useStore((s) => s.serial.connected);
  const bleConnected = useStore((s) => s.ble.connected);
  const demoStreamBlocked =
    serialConnected || bleConnected || replay.state !== 'idle';
  const demoBlockedReason = serialConnected
    ? 'Serial connected — live data takes priority'
    : bleConnected
      ? 'BLE connected — live data takes priority'
      : replay.state !== 'idle'
        ? 'CSV replay is loaded — stop or unload it first'
        : null;

  const refreshList = async () => {
    setListError(null);
    const r = await recordingsApi.list();
    if (r.error) {
      setListError(r.error);
      return;
    }
    setSessions(r.sessions);
  };

  useEffect(() => {
    void refreshList();
  }, []);

  // Honour cross-page Play requests. The chat page's RecordingsPanel
  // sets {sessionId, csvFilename, nonce} and navigates here. We pick
  // up the request on mount + on every nonce change, load the CSV,
  // play, then clear so a stale request doesn't replay if the user
  // navigates away and comes back.
  const lastNonceRef = useRef<number>(0);
  useEffect(() => {
    if (!replayRequest) return;
    if (replayRequest.nonce === lastNonceRef.current) return;
    lastNonceRef.current = replayRequest.nonce;
    setPickedId(replayRequest.sessionId);
    (async () => {
      await replay.load(replayRequest.csvFilename);
      replay.play();
      clearReplayRequest();
    })().catch(() => {
      // Errors surface via replay.error UI; nothing else to do here.
    });
    // We deliberately don't list `replay` in deps — its identity changes
    // on every parent render but the methods we need are stable refs
    // inside the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayRequest]);

  // Drop the loaded recording when the user picks a different
  // session — saves them having to click stop first.
  const lastLoadedRef = useRef<string>('');
  const handlePick = (sessionId: string) => {
    setPickedId(sessionId);
    setMarkInMs(null);
    setMarkOutMs(null);
    if (!sessionId) {
      // Picker cleared → fully unload. (The Stop button next to the
      // transport only rewinds + pauses, leaving the recording loaded
      // so the user can play again without re-fetching.)
      replay.clear();
      lastLoadedRef.current = '';
      return;
    }
    const session = sessions.find((s) => s.id === sessionId);
    const csvFilename = session?.csv?.filename;
    if (!csvFilename) return;
    lastLoadedRef.current = csvFilename;
    void replay.load(csvFilename);
  };

  // Filter to only sessions that have a CSV (audio-only sessions
  // can't be replayed through the channel grid).
  const playableSessions = useMemo(
    () => sessions.filter((s) => !!s.csv?.filename),
    [sessions],
  );

  const currentSec = replay.currentMs / 1000;
  const totalSec = replay.totalMs / 1000;
  const progressFrac =
    replay.totalMs > 0 ? replay.currentMs / replay.totalMs : 0;

  // Pointer-driven scrubbing on the progress bar:
  //   - down: capture the pointer so move events keep firing even if
  //     the cursor leaves the bar's bounding box; if currently playing,
  //     pause for the duration of the drag (resumed on release)
  //   - move: while dragging, seek continuously
  //   - up:   release capture; if we paused for the drag, resume play
  // A plain click is just down → up at the same x, so it falls out of
  // the same machinery — no separate onClick handler needed.
  const draggingRef = useRef(false);
  const wasPlayingRef = useRef(false);

  const seekFromPointer = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const frac = Math.max(0, Math.min(1, x / rect.width));
      replay.seek(frac * replay.totalMs);
    },
    [replay],
  );

  const onProgressPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (replay.totalMs === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    wasPlayingRef.current = replay.state === 'playing';
    // Pause during scrub so frame deltas don't fight the seek and
    // so we don't burn rAF ticks on positions the user is about to
    // overwrite.
    if (wasPlayingRef.current) replay.pause();
    seekFromPointer(e);
  };

  const onProgressPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    seekFromPointer(e);
  };

  const onProgressPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* element may have been replaced; ignore */
    }
    if (wasPlayingRef.current) {
      wasPlayingRef.current = false;
      replay.play();
    }
  };

  const transportLabel = (() => {
    if (replay.state === 'playing') return t.dashboard.replay.pause;
    if (replay.state === 'finished') return t.dashboard.replay.restart;
    return t.dashboard.replay.play;
  })();
  const onTransportClick = () => {
    if (replay.state === 'playing') replay.pause();
    else replay.play();
  };

  return (
    <div className="bg-card-bg rounded-xl p-4 border border-card-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">▶</span>
          <span className="font-semibold text-text-primary">
            {t.dashboard.replay.title}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Demo-mode synthetic stream toggle. Compact pill so it
              fits in the panel header next to the refresh icon —
              the spot the user pointed to. Disabled (but visible)
              when a real source / loaded recording would block the
              underlying hook from emitting; tooltip explains why. */}
          {demoMode && (
            <button
              type="button"
              onClick={() => setDemoStreamRunning(!demoStreamRunning)}
              disabled={demoStreamBlocked && !demoStreamRunning}
              aria-pressed={demoStreamRunning}
              title={
                demoStreamBlocked && !demoStreamRunning
                  ? (demoBlockedReason ?? 'Demo stream blocked')
                  : demoStreamRunning
                    ? 'Stop the synthetic 12-channel demo loop'
                    : 'Start the synthetic 12-channel demo loop'
              }
              className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-bold tracking-wider transition-colors ${
                demoStreamRunning
                  ? 'border-status-danger text-status-danger hover:bg-status-danger/10'
                  : demoStreamBlocked
                    ? 'border-card-border text-text-muted/60 cursor-not-allowed'
                    : 'border-accent text-accent hover:bg-accent/10'
              }`}
            >
              {demoStreamRunning ? '■ DEMO' : '▶ DEMO'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void refreshList()}
            className="text-xs text-text-muted hover:text-text-primary"
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Picker */}
      <select
        value={pickedId}
        onChange={(e) => handlePick(e.target.value)}
        disabled={replay.state === 'loading'}
        className="w-full bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm mb-3 disabled:opacity-50"
      >
        <option value="">{t.dashboard.replay.pickPlaceholder}</option>
        {playableSessions.map((s) => {
          const dur =
            typeof s.csv?.rows === 'number' && s.csv.rows > 0
              ? ` (${(s.csv.rows / 50).toFixed(0)}s)` // ~50 Hz, rough display
              : '';
          return (
            <option key={s.id} value={s.id}>
              {s.id}{dur}
            </option>
          );
        })}
      </select>

      {listError && (
        <div className="text-xs text-status-danger mb-3">
          {t.dashboard.replay.errorPrefix}
          {listError}
        </div>
      )}
      {sessions.length === 0 && !listError && (
        <div className="text-xs text-text-muted mb-3">
          {t.dashboard.replay.noRecordings}
        </div>
      )}

      {/* Status / error row */}
      {replay.state === 'loading' && (
        <div className="text-xs text-text-muted mb-2">
          {t.dashboard.replay.loading}
        </div>
      )}
      {replay.state === 'error' && replay.error && (
        <div className="text-xs text-status-danger mb-2 break-all">
          {t.dashboard.replay.errorPrefix}
          {replay.error}
        </div>
      )}

      {/* Transport — only visible after a recording is loaded */}
      {(replay.state === 'paused' ||
        replay.state === 'playing' ||
        replay.state === 'finished') && (
        <>
          {/* Progress bar — pointer events let the user click OR
              drag-scrub. Track is intentionally taller than the
              visible bar (`py-1` padding) so a user grabbing for it
              with a fat cursor doesn't have to land within 2 px.
              Visible bar + thumb live inside the padded hit-area. */}
          <div
            className="w-full py-1 cursor-pointer touch-none select-none"
            onPointerDown={onProgressPointerDown}
            onPointerMove={onProgressPointerMove}
            onPointerUp={onProgressPointerEnd}
            onPointerCancel={onProgressPointerEnd}
            title={t.dashboard.replay.progress(currentSec, totalSec)}
          >
            <div className="relative w-full h-2 bg-window-bg border border-card-border rounded overflow-visible">
              <div
                className="h-full bg-accent rounded-l"
                // No CSS transition while dragging — the pointer would
                // race ahead of the animated fill and feel laggy. While
                // playing the rAF tick already updates this 60×/sec,
                // so a transition is also unnecessary then.
                style={{ width: `${progressFrac * 100}%` }}
              />
              {/* Thumb — gives the user something concrete to grab.
                  Centered on progress fraction; pointer-events-none
                  so clicks land on the track, not the thumb itself. */}
              <div
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-accent border-2 border-card-bg shadow pointer-events-none"
                style={{ left: `${progressFrac * 100}%` }}
              />
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-text-muted font-mono mt-1 mb-3">
            <span>{t.dashboard.replay.duration(currentSec)}</span>
            <span>{t.dashboard.replay.duration(totalSec)}</span>
          </div>

          {/* Buttons row */}
          <div className="flex gap-2 mb-3">
            <button
              type="button"
              onClick={onTransportClick}
              className="flex-1 bg-accent hover:opacity-90 text-white font-medium py-1.5 rounded text-sm"
            >
              {transportLabel}
            </button>
            <button
              type="button"
              onClick={replay.stop}
              className="px-3 bg-card-border hover:bg-card-border/70 text-text-primary text-sm rounded"
            >
              {t.dashboard.replay.stop}
            </button>
          </div>

          {/* Speed picker */}
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-text-muted">
              {t.dashboard.replay.speed}
            </span>
            <div className="inline-flex rounded-lg border border-card-border bg-window-bg p-0.5">
              {SPEEDS.map((sp) => {
                const active = replay.speed === sp;
                return (
                  <button
                    key={sp}
                    type="button"
                    onClick={() => replay.setSpeed(sp)}
                    className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${
                      active
                        ? 'bg-accent text-white'
                        : 'text-text-secondary hover:text-text-primary hover:bg-card-border/40'
                    }`}
                  >
                    {sp}×
                  </button>
                );
              })}
            </div>
          </div>

          {/* Clip export — mark a region with the current playhead,
              then export it as a fresh CSV. Both marks must be set
              and ordered (in <= out) for export to be enabled. */}
          <div className="border-t border-card-border/50 pt-3 space-y-2">
            <div className="flex items-center justify-between text-[11px] text-text-muted">
              <span>{t.dashboard.replay.clipLabel}</span>
              <button
                type="button"
                onClick={() => {
                  setMarkInMs(null);
                  setMarkOutMs(null);
                }}
                disabled={markInMs === null && markOutMs === null}
                className="hover:text-text-primary disabled:opacity-50 disabled:hover:text-text-muted"
              >
                {t.dashboard.replay.clipReset}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMarkInMs(replay.currentMs)}
                className="rounded border border-card-border px-2 py-1 text-[11px] text-text-secondary hover:bg-card-border/40"
                title={
                  markInMs !== null
                    ? `${(markInMs / 1000).toFixed(1)}s`
                    : t.dashboard.replay.markInTitle
                }
              >
                {markInMs !== null
                  ? t.dashboard.replay.markInSet((markInMs / 1000).toFixed(1))
                  : t.dashboard.replay.markIn}
              </button>
              <button
                type="button"
                onClick={() => setMarkOutMs(replay.currentMs)}
                className="rounded border border-card-border px-2 py-1 text-[11px] text-text-secondary hover:bg-card-border/40"
                title={
                  markOutMs !== null
                    ? `${(markOutMs / 1000).toFixed(1)}s`
                    : t.dashboard.replay.markOutTitle
                }
              >
                {markOutMs !== null
                  ? t.dashboard.replay.markOutSet((markOutMs / 1000).toFixed(1))
                  : t.dashboard.replay.markOut}
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                if (markInMs === null || markOutMs === null) return;
                const a = Math.min(markInMs, markOutMs);
                const b = Math.max(markInMs, markOutMs);
                const sessionLabel = pickedId || 'clip';
                const startSec = (a / 1000).toFixed(1);
                const endSec = (b / 1000).toFixed(1);
                replay.exportClip(
                  a,
                  b,
                  `${sessionLabel}_${startSec}-${endSec}s.csv`,
                );
              }}
              disabled={markInMs === null || markOutMs === null}
              className="w-full rounded bg-accent text-white text-xs py-1.5 disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
            >
              {t.dashboard.replay.exportClip}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
