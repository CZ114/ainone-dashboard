// AudioLevelMeter - displays audio level

import { useStore } from '../../store';

export function AudioLevelMeter() {
  const audio = useStore((state) => state.audio);

  // Convert dB to percentage (assuming -60dB to 0dB range)
  const normalizeDb = (db: number) => {
    const minDb = -60;
    const maxDb = 0;
    return Math.max(0, Math.min(100, ((db - minDb) / (maxDb - minDb)) * 100));
  };

  const rmsPercent = normalizeDb(audio.rmsDb);
  const peakPercent = normalizeDb(audio.peakDb);

  return (
    <div className="bg-card-bg rounded-xl p-4 border border-card-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-ch-audio text-lg">🎤</span>
          <span className="font-semibold text-text-primary">Audio</span>
        </div>
        <span
          className={`text-sm ${audio.connected ? 'text-status-connected' : 'text-text-muted'}`}
        >
          {audio.connected ? '● Connected' : '○ Disconnected'}
        </span>
      </div>

      {audio.connected && (
        <div className="space-y-2">
          {/* Level bar */}
          <div className="h-3 bg-window-bg rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-ch-audio to-status-connected transition-all duration-100"
              style={{ width: `${rmsPercent}%` }}
            />
          </div>

          {/* RMS and Peak values */}
          <div className="flex justify-between text-xs text-text-secondary font-mono">
            <span>RMS: {audio.rmsDb.toFixed(1)} dB</span>
            <span>Peak: {audio.peakDb.toFixed(1)} dB</span>
          </div>

          {/* Peak indicator */}
          <div className="h-2 bg-window-bg rounded-full overflow-hidden">
            <div
              className="h-full bg-ch-audio transition-all duration-100"
              style={{ width: `${peakPercent}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}