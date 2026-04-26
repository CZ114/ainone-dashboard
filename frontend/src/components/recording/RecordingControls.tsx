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

  const handleStart = async () => {
    setLoading(true);
    try {
      await recordingApi.start(duration, includeAudio);
      setRecording(true, duration, 0);
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
          {/* Duration setting */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-text-secondary">Duration:</label>
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm"
            >
              <option value={30}>30 seconds</option>
              <option value={60}>1 minute</option>
              <option value={120}>2 minutes</option>
              <option value={300}>5 minutes</option>
              <option value={600}>10 minutes</option>
            </select>
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
