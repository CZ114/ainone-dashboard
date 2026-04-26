// API and WebSocket types

export interface SerialPort {
  port: string;
  desc?: string;
}

export interface ConnectionStatus {
  serial: {
    connected: boolean;
    port?: string;
    baud_rate?: number;
  };
  ble: {
    connected: boolean;
    device_name?: string;
  };
  audio: {
    connected: boolean;
    port?: number;
  };
}

export interface SensorDataMessage {
  type: 'sensor_data';
  timestamp: string;
  channels: string[];
  values: number[];
  waveforms: number[][];
  stats: {
    min: number[];
    max: number[];
    avg: number[];
  };
}

export interface AudioLevelMessage {
  type: 'audio_level';
  rms_db: number;
  peak_db: number;
  is_recording: boolean;
}

export interface RecordingStatusMessage {
  type: 'recording_status';
  is_recording: boolean;
  elapsed_seconds: number;
  remaining_seconds: number;
  csv_path?: string;
  audio_path?: string;
}

export interface DisplaySettings {
  points_per_channel: number;
  cards_per_row: number;
  // Uniform multiplier for card vertical dimensions (padding, font size,
  // waveform chart height). Snap points in the UI slider at 0.7, 0.85,
  // 1.0, 1.25, 1.5, 2.0 give a "tactile" feel without arbitrary values.
  card_scale: number;
  // Per-tick zoom factor for the chart's wheel zoom. Stored as the
  // raw multiplier (e.g. 1.15 = 15% change per wheel notch). The UI
  // exposes it as a percentage (value - 1) * 100.
  wheel_zoom_sensitivity: number;
}

export interface ChannelInfo {
  index: number;
  name: string;
  enabled: boolean;
  color: string;
}

export type WSMessage =
  | SensorDataMessage
  | AudioLevelMessage
  | RecordingStatusMessage
  | { type: 'connection_status'; serial: ConnectionStatus['serial']; ble: ConnectionStatus['ble']; audio: ConnectionStatus['audio'] }
  | { type: 'channel_config'; channels: ChannelInfo[] };

export interface ChannelData {
  name: string;
  value: number;
  waveform: number[];
  stats: {
    min: number;
    max: number;
    avg: number;
  };
  enabled: boolean;
  color: string;
}