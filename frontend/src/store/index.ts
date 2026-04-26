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
  // Derived (refreshed by recordingTick at 100 ms; also patched by
  // recordingHeartbeat from the backend WS):
  //   `recording.elapsedSec`  — Math.max(0, (now - anchor) / 1000)
  //   `recording.remainingSec` — Math.max(0, duration - elapsed)
  //
  // The display reads only the derived fields. Anchor is set ONCE per
  // session (on local Start, or on first heartbeat if some other tab
  // started the session) and never moved while we're already running,
  // unless a heartbeat reports a >1.5 s drift — that's the only path
  // that re-anchors mid-session.
  recording: {
    active: boolean;
    duration: number;
    anchorMs: number;
    elapsedSec: number;
    remainingSec: number;
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
  // WS heartbeat from backend (~1 Hz). Detects natural completion,
  // re-anchors on big drift, or seeds a session that another tab
  // started.
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
      },
    })),

  recordingTick: () =>
    set((state) => {
      if (!state.recording.active) return {};
      const elapsed = Math.max(0, (Date.now() - state.recording.anchorMs) / 1000);
      const remaining = Math.max(0, state.recording.duration - elapsed);
      return {
        recording: {
          ...state.recording,
          elapsedSec: elapsed,
          remainingSec: remaining,
        },
      };
    }),

  recordingHeartbeat: (isRecordingOnBackend, elapsed, remaining) =>
    set((state) => {
      // Backend says it's done — clear locally.
      if (!isRecordingOnBackend) {
        if (!state.recording.active) return {};
        return {
          recording: {
            active: false,
            duration: 0,
            anchorMs: 0,
            elapsedSec: 0,
            remainingSec: 0,
          },
        };
      }

      // Backend says recording, we don't have one locally → seed from
      // backend (covers "another tab started it" or "backend was
      // already recording when we connected").
      if (!state.recording.active) {
        const duration = elapsed + remaining;
        return {
          recording: {
            active: true,
            duration,
            anchorMs: Date.now() - elapsed * 1000,
            elapsedSec: elapsed,
            remainingSec: remaining,
          },
        };
      }

      // Both sides agree we're recording. Re-anchor only if our local
      // clock has drifted from the backend's elapsed by more than
      // 1.5 s — covers clock skew or a hibernated tab. Otherwise
      // leave the anchor alone so the 100 ms tick stays smooth.
      const ourElapsed = (Date.now() - state.recording.anchorMs) / 1000;
      if (Math.abs(ourElapsed - elapsed) > 1.5) {
        return {
          recording: {
            ...state.recording,
            anchorMs: Date.now() - elapsed * 1000,
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
