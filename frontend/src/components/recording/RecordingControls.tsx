// RecordingControls — start / stop a sensor + audio recording session.
//
// State model (see store/index.ts → `recording`):
//   - When idle: this component owns the duration & include-audio choice.
//   - When active: it reads `recording.elapsedSec` / `recording.remainingSec`
//     for display; those are kept fresh by Dashboard's 100 ms tick.
//
// The component never tries to compute time itself. It just kicks
// off the backend, lets the store track the session, and renders
// whatever the store says.

import { useState } from 'react';
import { useStore } from '../../store';
import { recordingApi } from '../../api/client';

const PRESETS_S = [30, 60, 120, 300, 600];
const MIN_DURATION_S = 1;
const MAX_DURATION_S = 86400; // 24 h
const DEFAULT_DURATION_S = 60;

const formatTime = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
};

const presetLabel = (s: number): string => {
  if (s < 60) return `${s}s`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${(s / 60).toFixed(1)}m`;
};

export function RecordingControls() {
  const recording = useStore((state) => state.recording);
  const recordingStart = useStore((state) => state.recordingStart);
  const recordingStop = useStore((state) => state.recordingStop);

  // User input — only used while idle.
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION_S);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const clamp = (n: number) =>
    Math.max(MIN_DURATION_S, Math.min(MAX_DURATION_S, Math.round(n)));

  const handleStart = async () => {
    const d = clamp(duration);
    setDuration(d);
    setErrorMsg(null);
    setBusy('starting');
    try {
      await recordingApi.start(d, includeAudio);
      // Only flip local state ONCE the backend confirms; keeps the UI
      // honest if the POST fails.
      recordingStart(d);
    } catch (e) {
      console.error('[Recording] start failed:', e);
      setErrorMsg(e instanceof Error ? e.message : 'Failed to start');
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async () => {
    setErrorMsg(null);
    setBusy('stopping');
    try {
      await recordingApi.stop();
    } catch (e) {
      // Even on a 400 ("no recording in progress" — backend already
      // auto-stopped at duration), the right move is to clear local
      // state so the user gets out of the stuck UI.
      console.error('[Recording] stop failed:', e);
    } finally {
      recordingStop();
      setBusy(null);
    }
  };

  const progressPct = recording.duration
    ? Math.min(100, (recording.elapsedSec / recording.duration) * 100)
    : 0;

  return (
    <div className="bg-card-bg rounded-xl p-4 border border-card-border">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-status-disconnected text-lg">⏺</span>
          <span className="font-semibold text-text-primary">Recording</span>
        </div>
        {recording.active && (
          <div className="flex items-center gap-2">
            <span className="text-status-disconnected animate-pulse">●</span>
            <span className="text-sm text-text-secondary font-mono">
              {formatTime(recording.remainingSec)}
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      {!recording.active ? (
        <div className="space-y-3">
          {/* Duration input */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">
              Duration (seconds)
            </label>
            <input
              type="number"
              min={MIN_DURATION_S}
              max={MAX_DURATION_S}
              step={1}
              value={duration}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setDuration(v);
              }}
              onBlur={() => setDuration((d) => clamp(d))}
              disabled={busy !== null}
              className="w-full bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm font-mono disabled:opacity-50"
              title={`Any value from ${MIN_DURATION_S} to ${MAX_DURATION_S} seconds`}
            />
          </div>

          {/* Preset chips */}
          <div className="flex flex-wrap gap-1.5">
            {PRESETS_S.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setDuration(s)}
                disabled={busy !== null}
                className={`px-2 py-1 text-xs rounded border transition-colors disabled:opacity-50 ${
                  duration === s
                    ? 'bg-blue-500/20 border-blue-500/60 text-blue-200'
                    : 'bg-window-bg border-card-border text-text-secondary hover:border-card-border/80'
                }`}
              >
                {presetLabel(s)}
              </button>
            ))}
          </div>

          {/* Include audio toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeAudio}
              onChange={(e) => setIncludeAudio(e.target.checked)}
              disabled={busy !== null}
              className="w-4 h-4 accent-ch-audio"
            />
            <span className="text-sm text-text-secondary">Include audio</span>
          </label>

          {/* Start button */}
          <button
            onClick={handleStart}
            disabled={busy !== null}
            className="w-full bg-status-disconnected hover:bg-red-600 disabled:opacity-50 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
          >
            {busy === 'starting' ? 'Starting…' : 'Start Recording'}
          </button>

          {errorMsg && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
              {errorMsg}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Progress bar */}
          <div>
            <div className="flex justify-between text-xs text-text-muted mb-1 font-mono">
              <span>{formatTime(recording.elapsedSec)} elapsed</span>
              <span>{formatTime(recording.duration)} total</span>
            </div>
            <div className="h-2 bg-window-bg border border-card-border rounded overflow-hidden">
              <div
                className="h-full bg-status-disconnected transition-all duration-100"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Stop button */}
          <button
            onClick={handleStop}
            disabled={busy !== null}
            className="w-full bg-ch-audio hover:bg-orange-600 disabled:opacity-50 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
          >
            {busy === 'stopping' ? 'Stopping…' : 'Stop Recording'}
          </button>

          {errorMsg && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
              {errorMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
