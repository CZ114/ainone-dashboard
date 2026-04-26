// AppBridge — single, app-lifetime owner of the data plane.
//
// Lives at the root of <App/> so it never unmounts during route
// changes. Two responsibilities:
//
//   1. WebSocket subscription. Mounts the singleton wsClient once,
//      routes every incoming message into the appropriate store
//      action (sensor / audio / connection / recording). The
//      previous design subscribed inside <Dashboard/>; navigating
//      to /chat tore it down, lost recording_status heartbeats,
//      and cost the user a noticeable beat on each route change
//      because the wsClient.disconnect()/reconnect dance fired
//      every time. (React StrictMode in dev made it worse — double
//      mount = double subscribe = first-recording weirdness as the
//      handler ran twice for the very first heartbeat.)
//
//   2. Recording display tick. While recording.active is true,
//      a 100 ms interval calls recordingTick so the elapsed /
//      remaining display refreshes smoothly. This must keep
//      running even when the user is on /chat — otherwise the
//      timer freezes off-screen and the auto-stop at duration
//      end never fires.
//
// Renders nothing. State only.

import { useEffect, useRef } from 'react';
import { wsClient } from '../api/websocket';
import { useStore } from '../store';
import type {
  WSMessage,
  SensorDataMessage,
  AudioLevelMessage,
} from '../types';

export function AppBridge() {
  const setSerialConnected = useStore((s) => s.setSerialConnected);
  const setBleConnected = useStore((s) => s.setBleConnected);
  const setAudioConnected = useStore((s) => s.setAudioConnected);
  const setAudioLevel = useStore((s) => s.setAudioLevel);
  const updateSensorData = useStore((s) => s.updateSensorData);
  const recordingTick = useStore((s) => s.recordingTick);
  const recordingHeartbeat = useStore((s) => s.recordingHeartbeat);
  const recordingActive = useStore((s) => s.recording.active);

  // rAF throttle for sensor_data — see WS subscription effect for why.
  const pendingSensorRef = useRef<SensorDataMessage | null>(null);
  const pendingAudioRef = useRef<AudioLevelMessage | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // ---- WS subscription (app-lifetime) ------------------------------
  useEffect(() => {
    // Apply any buffered high-rate updates on the next animation frame.
    // sensor_data arrives at the backend's poll cadence (often 50 Hz);
    // calling updateSensorData on every message used to re-render
    // ChannelGrid + N WaveformCharts 50× per second, which monopolised
    // the main thread and made user clicks (e.g. the "Claude Chat"
    // link during recording) take seconds to register. Coalescing to
    // animation-frame cadence caps re-renders at the display refresh
    // rate; visually identical, leaves CPU for input handling.
    const flush = () => {
      rafIdRef.current = null;
      const sensor = pendingSensorRef.current;
      const audio = pendingAudioRef.current;
      pendingSensorRef.current = null;
      pendingAudioRef.current = null;
      if (sensor) {
        updateSensorData(
          sensor.channels,
          sensor.values,
          sensor.waveforms,
          sensor.stats,
        );
      }
      if (audio) {
        setAudioLevel(audio.rms_db, audio.peak_db);
      }
    };
    const scheduleFlush = () => {
      if (rafIdRef.current === null) {
        rafIdRef.current = window.requestAnimationFrame(flush);
      }
    };

    const handleMessage = (message: WSMessage) => {
      switch (message.type) {
        case 'sensor_data': {
          // Keep only the most recent payload — the dashboard only
          // ever shows the latest sample/waveform anyway, so dropping
          // intermediate frames at high WS rates costs us nothing.
          pendingSensorRef.current = message as SensorDataMessage;
          scheduleFlush();
          break;
        }
        case 'audio_level': {
          pendingAudioRef.current = message as AudioLevelMessage;
          scheduleFlush();
          break;
        }
        case 'connection_status': {
          // Low-frequency events bypass the rAF batch — they should
          // land in the store immediately so UI status (Connect /
          // Disconnect button labels) reflects reality with no lag.
          setSerialConnected(message.serial.connected, message.serial.port);
          setBleConnected(message.ble.connected, message.ble.device_name);
          setAudioConnected(message.audio.connected);
          break;
        }
        case 'recording_status': {
          recordingHeartbeat(
            message.is_recording,
            message.elapsed_seconds,
            message.remaining_seconds,
          );
          break;
        }
      }
    };

    const unsubscribe = wsClient.onMessage(handleMessage);
    wsClient.connect();

    return () => {
      // Capture-and-call the unsubscribe returned by onMessage so we
      // don't leak a stale handler if React StrictMode double-mounts
      // us in dev. Crucially we do NOT call wsClient.disconnect() —
      // the singleton is shared with ChatAudioStatus and stays alive
      // for the life of the page.
      unsubscribe();
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [
    setSerialConnected,
    setBleConnected,
    setAudioConnected,
    setAudioLevel,
    updateSensorData,
    recordingHeartbeat,
  ]);

  // ---- Recording display tick (app-lifetime) -----------------------
  useEffect(() => {
    if (!recordingActive) return;
    recordingTick();
    const id = window.setInterval(recordingTick, 100);
    return () => window.clearInterval(id);
  }, [recordingActive, recordingTick]);

  return null;
}
