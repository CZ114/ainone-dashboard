// Dashboard component - main sensor monitoring view

import { useEffect } from 'react';
import { wsClient } from '../api/websocket';
import { useStore } from '../store';
import { Header } from './layout/Header';
import { ConnectionPanel } from './layout/ConnectionPanel';
import { ChannelGrid } from './channels/ChannelGrid';
import { AudioLevelMeter } from './audio/AudioLevelMeter';
import { RecordingControls } from './recording/RecordingControls';
import { DisplaySettings } from './settings/DisplaySettings';
import { WSMessage, SensorDataMessage, AudioLevelMessage } from '../types';

function Dashboard() {
  const setSerialConnected = useStore((state) => state.setSerialConnected);
  const setBleConnected = useStore((state) => state.setBleConnected);
  const setAudioConnected = useStore((state) => state.setAudioConnected);
  const setAudioLevel = useStore((state) => state.setAudioLevel);
  const updateSensorData = useStore((state) => state.updateSensorData);
  const setRecording = useStore((state) => state.setRecording);
  const updateRecordingTime = useStore((state) => state.updateRecordingTime);
  const isRecording = useStore((state) => state.isRecording);
  const recordingDuration = useStore((state) => state.recordingDuration);
  const recordingStartTimeMs = useStore((state) => state.recordingStartTimeMs);

  // Frontend timer — runs every 100ms, computes elapsed/remaining from clock.
  // Mirrors the old Tkinter GUI's _recording_countdown_tick() approach.
  useEffect(() => {
    if (isRecording && recordingStartTimeMs > 0) {
      updateRecordingTime(recordingDuration, 0);
      const id = setInterval(() => {
        const elapsed = (Date.now() - recordingStartTimeMs) / 1000;
        const remaining = Math.max(0, recordingDuration - elapsed);
        updateRecordingTime(remaining, elapsed);
      }, 100);
      return () => clearInterval(id);
    }
  }, [isRecording, recordingStartTimeMs, recordingDuration, updateRecordingTime]);

  useEffect(() => {
    const handleMessage = (message: WSMessage) => {
      switch (message.type) {
        case 'sensor_data': {
          const data = message as SensorDataMessage;
          updateSensorData(
            data.channels,
            data.values,
            data.waveforms,
            data.stats
          );
          break;
        }

        case 'audio_level': {
          const data = message as AudioLevelMessage;
          setAudioLevel(data.rms_db, data.peak_db);
          break;
        }

        case 'connection_status': {
          setSerialConnected(
            message.serial.connected,
            message.serial.port
          );
          setBleConnected(message.ble.connected, message.ble.device_name);
          setAudioConnected(message.audio.connected);
          break;
        }

        case 'recording_status': {
          setRecording(
            message.is_recording,
            message.remaining_seconds,
            message.elapsed_seconds
          );
          break;
        }
      }
    };

    wsClient.onMessage(handleMessage);
    wsClient.connect();

    return () => {
      wsClient.disconnect();
    };
  }, [
    setSerialConnected,
    setBleConnected,
    setAudioConnected,
    setAudioLevel,
    updateSensorData,
    setRecording,
    updateRecordingTime,
  ]);

  return (
    <div className="min-h-screen bg-window-bg flex flex-col">
      {/* Header */}
      <Header />

      {/* Main content */}
      <div className="flex-1 flex">
        {/* Left sidebar */}
        <aside className="w-80 border-r border-card-border p-4 space-y-4 overflow-y-auto">
          <ConnectionPanel />
          <RecordingControls />
          <AudioLevelMeter />
          <DisplaySettings />
        </aside>

        {/* Main area */}
        <main className="flex-1 overflow-y-auto">
          <ChannelGrid />
        </main>
      </div>

      {/* Status bar */}
      <footer className="bg-card-bg border-t border-card-border px-6 py-2">
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>AinOne Dashboard v1.0</span>
          <span>
            WebSocket: {wsClient.isConnected() ? '● Connected' : '○ Disconnected'}
          </span>
        </div>
      </footer>
    </div>
  );
}

export default Dashboard;
