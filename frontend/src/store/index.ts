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

  // Recording
  isRecording: boolean;
  recordingRemaining: number;
  recordingElapsed: number;
  recordingDuration: number;     // original duration set at start
  recordingStartTimeMs: number;  // frontend clock when recording began

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

  setRecording: (isRecording: boolean, remaining?: number, elapsed?: number) => void;
  updateRecordingTime: (remaining: number, elapsed: number) => void;

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

  isRecording: false,
  recordingRemaining: 0,
  recordingElapsed: 0,
  recordingDuration: 0,
  recordingStartTimeMs: 0,

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

  setRecording: (isRecording, remaining = 0, elapsed = 0) =>
    set(() => ({
      isRecording,
      recordingDuration: isRecording ? remaining : 0,
      recordingStartTimeMs: isRecording ? Date.now() : 0,
      recordingRemaining: remaining,
      recordingElapsed: elapsed,
    })),

  updateRecordingTime: (remaining, elapsed) =>
    set((state) => {
      const computedElapsed = state.recordingStartTimeMs
        ? (Date.now() - state.recordingStartTimeMs) / 1000
        : elapsed;
      const computedRemaining = state.recordingDuration
        ? Math.max(0, state.recordingDuration - computedElapsed)
        : remaining;
      return {
        recordingRemaining: computedRemaining,
        recordingElapsed: computedElapsed,
      };
    }),

  setSettings: (newSettings) =>
    set((state) => ({
      settings: { ...state.settings, ...newSettings },
    })),
}));
