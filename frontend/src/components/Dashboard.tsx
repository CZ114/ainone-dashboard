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
  const recordingTick = useStore((state) => state.recordingTick);
  const recordingHeartbeat = useStore((state) => state.recordingHeartbeat);
  const recordingActive = useStore((state) => state.recording.active);

  // 100 ms display refresh while a session is active. The store action
  // recomputes elapsed/remaining from the anchor + wall clock — no
  // dependency on recordingDuration / startTimeMs in the deps array,
  // so re-anchoring (in heartbeat) doesn't restart the interval and
  // the displayed time stays smooth.
  useEffect(() => {
    if (!recordingActive) return;
    recordingTick();
    const id = setInterval(recordingTick, 100);
    return () => clearInterval(id);
  }, [recordingActive, recordingTick]);

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
          // Backend heartbeat. The store action only re-anchors if
          // (a) backend says active and we don't, (b) drift > 1.5 s,
          // or (c) backend says inactive — otherwise it's a no-op.
          recordingHeartbeat(
            message.is_recording,
            message.elapsed_seconds,
            message.remaining_seconds,
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
    recordingHeartbeat,
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
