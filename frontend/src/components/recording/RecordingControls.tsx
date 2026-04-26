// RecordingControls - recording start/stop and duration settings

import { useState } from 'react';
import { useStore } from '../../store';
import { recordingApi } from '../../api/client';

export function RecordingControls() {
  const isRecording = useStore((state) => state.isRecording);
  const recordingRemaining = useStore((state) => state.recordingRemaining);
  const setRecording = useStore((state) => state.setRecording);

  const [duration, setDuration] = useState(60);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [loading, setLoading] = useState(false);

  // Clamp to a sane range so a fat-fingered "10000000" doesn't pin the
  // backend on a multi-day session. 86400 s = 24 h, plenty for any
  // realistic ESP32 capture.
  const MIN_DURATION_S = 1;
  const MAX_DURATION_S = 86400;
  const clampDuration = (n: number) =>
    Math.max(MIN_DURATION_S, Math.min(MAX_DURATION_S, Math.round(n)));

  const handleStart = async () => {
    const d = clampDuration(duration);
    setDuration(d);
    setLoading(true);
    try {
      await recordingApi.start(d, includeAudio);
      setRecording(true, d, 0);
    } catch (e) {
      console.error('Failed to start recording:', e);
    }
    setLoading(false);
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await recordingApi.stop();
      setRecording(false);
    } catch (e) {
      console.error('Failed to stop recording:', e);
    }
    setLoading(false);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-card-bg rounded-xl p-4 border border-card-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-status-disconnected text-lg">⏺</span>
          <span className="font-semibold text-text-primary">Recording</span>
        </div>

        {isRecording && (
          <div className="flex items-center gap-2">
            <span className="text-status-disconnected animate-pulse">●</span>
            <span className="text-sm text-text-secondary font-mono">
              {formatTime(recordingRemaining)}
            </span>
          </div>
        )}
      </div>

      {!isRecording ? (
        <div className="space-y-3">
          {/* Duration setting — preset dropdown + custom number input.
              The preset picker is kept for one-tap common durations;
              the number field lets the user dial in any 1 s ↔ 24 h
              value, which the old hard-coded options blocked. */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-sm text-text-secondary">Duration:</label>
            <select
              value={[30, 60, 120, 300, 600].includes(duration) ? duration : 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v > 0) setDuration(v);
              }}
              className="bg-window-bg border border-card-border rounded px-2 py-1.5 text-text-primary text-sm"
              title="Pick a preset or use the field on the right for a custom value"
            >
              <option value={0} disabled>
                Custom
              </option>
              <option value={30}>30 s</option>
              <option value={60}>1 min</option>
              <option value={120}>2 min</option>
              <option value={300}>5 min</option>
              <option value={600}>10 min</option>
            </select>
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
              onBlur={() => setDuration((d) => clampDuration(d))}
              className="w-20 bg-window-bg border border-card-border rounded px-2 py-1.5 text-text-primary text-sm font-mono"
              title="Custom duration in seconds (1 – 86400)"
            />
            <span className="text-xs text-text-muted">sec</span>
          </div>

          {/* Include audio toggle */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-text-secondary">Include audio:</label>
            <input
              type="checkbox"
              checked={includeAudio}
              onChange={(e) => setIncludeAudio(e.target.checked)}
              className="w-4 h-4 accent-ch-audio"
            />
          </div>

          {/* Start button */}
          <button
            onClick={handleStart}
            disabled={loading}
            className="w-full bg-status-disconnected hover:bg-red-600 disabled:opacity-50 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
          >
            {loading ? 'Starting...' : 'Start Recording'}
          </button>
        </div>
      ) : (
        <button
          onClick={handleStop}
          disabled={loading}
          className="w-full bg-ch-audio hover:bg-orange-600 disabled:opacity-50 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
        >
          {loading ? 'Stopping...' : 'Stop Recording'}
        </button>
      )}
    </div>
  );
}
