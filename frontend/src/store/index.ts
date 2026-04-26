// Zustand store for application state

import { create } from 'zustand';
import { ChannelData, DisplaySettings } from '../types';

const CHANNEL_COLORS = [
  '#FF4757', // PPG Red
  '#3B82F6', // IMU Blue
  '#22C55E', // ENV Green
  '#A855F7', // GSR Purple
  '#F97316', // Audio Orange
  '#06B6D4', // BLE Cyan
  '#EAB308', // Yellow
  '#EC4899', // Pink
  '#8B5CF6', // Violet
  '#14B8A6', // Teal
];

interface AppState {
  // Connection state
  serial: {
    connected: boolean;
    port: string | null;
    baudRate: number;
    availablePorts: Array<{ port: string; desc?: string }>;
  };
  ble: {
    connected: boolean;
    deviceName: string | null;
  };
  audio: {
    connected: boolean;
    rmsDb: number;
    peakDb: number;
  };

  // Sensor data
  channels: ChannelData[];
  channelCount: number;

  // Recording — single anchor model.
  //
  // Authoritative fields:
  //   `recording.active`   — is a session currently running?
  //   `recording.duration` — total seconds the user requested
  //   `recording.anchorMs` — wall clock corresponding to elapsed = 0
  //
  // Derived (refreshed by recordingTick at 100 ms):
  //   `recording.elapsedSec`  — Math.max(0, (now - anchor) / 1000)
  //   `recording.remainingSec` — Math.max(0, duration - elapsed)
  //
  // Heartbeat quarantine:
  //   `recording.ignoreHeartbeatsUntilMs` — wall clock; heartbeats arriving
  //   before this time are dropped. Set on every local Start / Stop so a
  //   stale `is_recording=false` WS frame can't clobber a freshly-started
  //   session, and a stale `is_recording=true` frame can't resurrect a
  //   freshly-stopped one.
  //
  // The local 100 ms tick is the single display authority. Heartbeats can
  // (a) fire the natural-completion transition, (b) seed a session that
  // started in another tab, or (c) catch us up if our local clock fell
  // behind (tab hibernation). They NEVER re-anchor backward — that was
  // the source of the visible 27→28→29→28 jumps.
  recording: {
    active: boolean;
    duration: number;
    anchorMs: number;
    elapsedSec: number;
    remainingSec: number;
    ignoreHeartbeatsUntilMs: number;
  };

  // Display settings
  settings: DisplaySettings;

  // Actions
  setSerialConnected: (connected: boolean, port?: string) => void;
  setAvailablePorts: (ports: Array<{ port: string; desc?: string }>) => void;
  setBleConnected: (connected: boolean, deviceName?: string) => void;
  setAudioConnected: (connected: boolean) => void;
  setAudioLevel: (rmsDb: number, peakDb: number) => void;

  updateSensorData: (
    channelNames: string[],
    values: number[],
    waveforms: number[][],
    stats: { min: number[]; max: number[]; avg: number[] }
  ) => void;
  toggleChannel: (index: number) => void;

  // User-initiated start (called from RecordingControls after the
  // backend POST returns 200). Anchors at "now" and trusts the
  // requested duration.
  recordingStart: (duration: number) => void;
  // User-initiated stop (or natural completion via heartbeat).
  recordingStop: () => void;
  // 100 ms display refresh — pure derivation from anchor + clock.
  recordingTick: () => void;
  // WS heartbeat from backend (~1 Hz). Used SOLELY to detect that
  // backend has stopped (natural completion at duration end, or
  // external stop) and clear local state. The elapsed/remaining
  // arguments are accepted for API compatibility but ignored —
  // local clock is the sole authority for the displayed countdown.
  recordingHeartbeat: (
    isRecordingOnBackend: boolean,
    elapsed: number,
    remaining: number,
  ) => void;

  setSettings: (settings: Partial<DisplaySettings>) => void;
}

export const useStore = create<AppState>((set) => ({
  // Initial state
  serial: {
    connected: false,
    port: null,
    baudRate: 115200,
    availablePorts: [],
  },
  ble: {
    connected: false,
    deviceName: null,
  },
  audio: {
    connected: false,
    rmsDb: -100,
    peakDb: -100,
  },

  channels: [],
  channelCount: 0,

  recording: {
    active: false,
    duration: 0,
    anchorMs: 0,
    elapsedSec: 0,
    remainingSec: 0,
    ignoreHeartbeatsUntilMs: 0,
  },

  settings: {
    points_per_channel: 100,
    cards_per_row: 4,
    card_scale: 1.0,
    wheel_zoom_sensitivity: 1.15,
  },

  // Actions
  setSerialConnected: (connected, port) =>
    set((state) => ({
      serial: {
        ...state.serial,
        connected,
        port: connected ? port || state.serial.port : null,
      },
    })),

  setAvailablePorts: (ports) =>
    set((state) => ({
      serial: { ...state.serial, availablePorts: ports },
    })),

  setBleConnected: (connected, deviceName) =>
    set(() => ({
      ble: { connected, deviceName: connected ? deviceName || 'ESP32' : null },
    })),

  setAudioConnected: (connected) =>
    set((state) => ({
      audio: { ...state.audio, connected },
    })),

  setAudioLevel: (rmsDb, peakDb) =>
    set((state) => ({
      audio: { ...state.audio, rmsDb, peakDb },
    })),

  updateSensorData: (channelNames, values, waveforms, stats) =>
    set((state) => {
      const channels: ChannelData[] = channelNames.map((name, i) => {
        const existing = state.channels[i];
        const isEnabled = existing?.enabled ?? true;

        return {
          name,
          value: values[i] ?? 0,
          waveform: waveforms[i] ?? [],
          stats: {
            min: stats.min[i] ?? 0,
            max: stats.max[i] ?? 0,
            avg: stats.avg[i] ?? 0,
          },
          enabled: isEnabled,
          color: existing?.color || CHANNEL_COLORS[i % CHANNEL_COLORS.length],
        };
      });

      return {
        channels,
        channelCount: channelNames.length,
      };
    }),

  toggleChannel: (index) =>
    set((state) => {
      const channels = [...state.channels];
      if (channels[index]) {
        channels[index] = {
          ...channels[index],
          enabled: !channels[index].enabled,
        };
      }
      return { channels };
    }),

  recordingStart: (duration) =>
    set(() => ({
      recording: {
        active: true,
        duration,
        anchorMs: Date.now(),
        elapsedSec: 0,
        remainingSec: duration,
        // Quarantine: drop any WS heartbeat for the next 3 s so a
        // stale `is_recording=false` frame in flight (broadcast just
        // before the user clicked Start) can't clobber the session
        // we just initiated. 3 s covers the data_loop's ~1 Hz cadence
        // plus the asyncio drain queue lag.
        ignoreHeartbeatsUntilMs: Date.now() + 3000,
      },
    })),

  recordingStop: () =>
    set(() => ({
      recording: {
        active: false,
        duration: 0,
        anchorMs: 0,
        elapsedSec: 0,
        remainingSec: 0,
        // Same quarantine on stop: a stale `is_recording=true` from
        // before the user clicked Stop must not resurrect the session.
        ignoreHeartbeatsUntilMs: Date.now() + 3000,
      },
    })),

  recordingTick: () =>
    set((state) => {
      if (!state.recording.active) return {};
      const elapsed = Math.max(0, (Date.now() - state.recording.anchorMs) / 1000);
      // Local end-of-duration auto-stop. The backend's _monitor_recording
      // thread also ends the session at this point, but if its WS
      // notification is lost or delayed, the dashboard would otherwise
      // keep ticking past `duration` (we saw 00:46 elapsed / 00:30 total
      // sticking on screen). Self-stopping closes that gap.
      if (elapsed >= state.recording.duration) {
        return {
          recording: {
            active: false,
            duration: 0,
            anchorMs: 0,
            elapsedSec: 0,
            remainingSec: 0,
            // Quarantine briefly: a stale `is_recording=true` heartbeat
            // in flight must not resurrect the session.
            ignoreHeartbeatsUntilMs: Date.now() + 3000,
          },
        };
      }
      const remaining = Math.max(0, state.recording.duration - elapsed);
      return {
        recording: {
          ...state.recording,
          elapsedSec: elapsed,
          remainingSec: remaining,
        },
      };
    }),

  recordingHeartbeat: (isRecordingOnBackend, _elapsed, _remaining) =>
    set((state) => {
      // Heartbeats now do exactly ONE thing: clear local state when
      // backend says it's no longer recording (natural completion /
      // external stop). We deliberately do NOT seed cross-tab sessions
      // and do NOT re-anchor on drift — both produced visible time
      // jumps in practice (back to 0 on stale seed, jumping forward
      // on catch-up). Local timer is the sole authority for the
      // displayed elapsed once recordingStart anchors it.
      if (Date.now() < state.recording.ignoreHeartbeatsUntilMs) {
        return {};
      }
      if (!isRecordingOnBackend && state.recording.active) {
        return {
          recording: {
            active: false,
            duration: 0,
            anchorMs: 0,
            elapsedSec: 0,
            remainingSec: 0,
            ignoreHeartbeatsUntilMs: 0,
          },
        };
      }
      return {};
    }),

  setSettings: (newSettings) =>
    set((state) => ({
      settings: { ...state.settings, ...newSettings },
    })),
}));
