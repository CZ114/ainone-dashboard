// Compact ESP32 audio status + live level meter for the chat toolbar.
//
// Reuses the dashboard's existing data pipeline (wsClient + app store):
//   - wsClient.connect() is idempotent, so calling it from the chat
//     page is safe even when the user never opened the dashboard.
//   - The shared `useStore` already has `audio.connected / rmsDb /
//     peakDb` populated on `audio_level` / `connection_status` messages.
//
// The component renders nothing when ESP32 audio isn't connected so
// the toolbar stays clean; when it IS connected users see a pulsing
// green dot + a gradient level bar matching the dashboard's meter.

import { useEffect } from 'react';
import { useStore } from '../../store';
import { wsClient } from '../../api/websocket';
import type {
  WSMessage,
  AudioLevelMessage,
  ConnectionStatus,
} from '../../types';

// Maps dB to 0-100% using the same range as the dashboard's meter.
function normalizeDb(db: number): number {
  const minDb = -60;
  const maxDb = 0;
  return Math.max(0, Math.min(100, ((db - minDb) / (maxDb - minDb)) * 100));
}

export function ChatAudioStatus() {
  const audio = useStore((s) => s.audio);
  const setAudioConnected = useStore((s) => s.setAudioConnected);
  const setAudioLevel = useStore((s) => s.setAudioLevel);
  const setSerialConnected = useStore((s) => s.setSerialConnected);
  const setBleConnected = useStore((s) => s.setBleConnected);

  // Stand up the WS subscription when this widget mounts. Because
  // wsClient is a process-wide singleton, dashboards already connected
  // stay connected; dashboards never visited get brought online here.
  useEffect(() => {
    const handler = (message: WSMessage) => {
      if (message.type === 'audio_level') {
        const data = message as AudioLevelMessage;
        setAudioLevel(data.rms_db, data.peak_db);
      } else if (message.type === 'connection_status') {
        const m = message as {
          type: 'connection_status';
          serial: ConnectionStatus['serial'];
          ble: ConnectionStatus['ble'];
          audio: ConnectionStatus['audio'];
        };
        setAudioConnected(m.audio.connected);
        setSerialConnected(m.serial.connected, m.serial.port);
        setBleConnected(m.ble.connected, m.ble.device_name);
      }
    };
    const unsubscribe = wsClient.onMessage(handler);
    wsClient.connect();
    return () => {
      unsubscribe();
      // Don't disconnect — the dashboard page might still want it, and
      // the singleton auto-reconnects anyway.
    };
  }, [setAudioConnected, setAudioLevel, setSerialConnected, setBleConnected]);

  // Hidden when audio isn't connected — keeps the toolbar uncluttered
  // for users who don't use the ESP32 audio path.
  if (!audio.connected) {
    return null;
  }

  const rmsPercent = normalizeDb(audio.rmsDb);
  const clipping = audio.peakDb > -3; // within 3dB of digital max — warn

  return (
    <div
      className="flex items-center gap-1.5 h-7 px-2 rounded bg-card-border/30 select-none"
      title={
        `ESP32 UDP audio live\n` +
        `RMS: ${audio.rmsDb.toFixed(1)} dB\n` +
        `Peak: ${audio.peakDb.toFixed(1)} dB`
      }
    >
      {/* Pulsing dot: green when active, red when clipping */}
      <span className="relative flex items-center justify-center">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            clipping ? 'bg-red-400' : 'bg-emerald-400'
          }`}
        />
        {!clipping && (
          <span className="absolute w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping opacity-60" />
        )}
      </span>

      {/* Mini level bar — same gradient as the dashboard meter */}
      <div className="w-16 h-1.5 bg-window-bg rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-75 ${
            clipping
              ? 'bg-red-400'
              : 'bg-gradient-to-r from-emerald-400 to-blue-400'
          }`}
          style={{ width: `${rmsPercent}%` }}
        />
      </div>

      {/* dB readout — narrow so it doesn't crowd the toolbar */}
      <span className="text-[10px] text-text-muted font-mono tabular-nums w-10 text-right">
        {audio.rmsDb > -100 ? `${audio.rmsDb.toFixed(0)}dB` : '--'}
      </span>
    </div>
  );
}
