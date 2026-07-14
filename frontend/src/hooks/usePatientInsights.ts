// usePatientInsights — derives patient-friendly, honest metrics from the
// raw sensor store for the /today page.
//
// Honesty constraints (from the data-pipeline recon):
//   - The backend does NOT pre-compute breathing rate, HRV, or an
//     activity score. We only have per-channel latest `value` and a
//     rolling-window `stats {min,max,avg}` (~2 s window).
//   - So: heart rate is a real channel value; "activity" is DERIVED
//     here as accelerometer window volatility (max-min spread), which
//     genuinely tracks movement but is NOT a calibrated 0-100 score —
//     the UI labels it qualitatively (resting / light / active), never
//     as a fake percentage of some daily goal.
//   - Everything is instantaneous ("right now"), never "today's
//     average" — there is no daily aggregation in the pipeline.
//
// When no device is streaming, `hasData` is false and numeric fields are
// null; the UI still shows the breathing-guide ring (its value doesn't
// depend on data) and a "connect your band" hint.

import { useStore } from '../store';
import type { ChannelData } from '../types';

export type ActivityLevel = 'resting' | 'light' | 'active';

export interface PatientInsights {
  hasData: boolean;
  heartRate: number | null;        // bpm, rounded
  heartRateBand: 'low' | 'normal' | 'high' | null;
  activity: { score: number; level: ActivityLevel } | null; // score 0-100 (qualitative)
  ambient: { temp: number | null; humidity: number | null } | null;
  voiceLevel: number;              // 0..1, from audio RMS dB
  device: DeviceStatus;
}

export interface DeviceStatus {
  band: { connected: boolean; name: string | null };   // BLE chest band
  hub: { connected: boolean };                          // serial hub
  mic: { connected: boolean };                          // audio capture
  channelCount: number;
  recording: { active: boolean; elapsedSec: number };
  anyConnected: boolean;
}

function findChannel(channels: ChannelData[], re: RegExp): ChannelData | undefined {
  return channels.find((c) => re.test(c.name));
}

/** Map audio RMS dB (~[-100, 0]) to a [0,1] talk-loudness bar. */
function dbToNorm(db: number): number {
  const norm = (db + 60) / 60; // -60 dB → 0, 0 dB → 1
  return Math.min(1, Math.max(0, norm));
}

export function usePatientInsights(): PatientInsights {
  const channels = useStore((s) => s.channels);
  const serial = useStore((s) => s.serial);
  const ble = useStore((s) => s.ble);
  const audio = useStore((s) => s.audio);
  const channelCount = useStore((s) => s.channelCount);
  const recording = useStore((s) => s.recording);

  const hasData = channels.length > 0;

  // Heart rate — a real firmware-derived channel value.
  const hrChannel = findChannel(channels, /\bHR\b|heart/i);
  const heartRate = hrChannel ? Math.round(hrChannel.value) : null;
  const heartRateBand =
    heartRate === null ? null : heartRate < 55 ? 'low' : heartRate > 100 ? 'high' : 'normal';

  // Activity — DERIVED from accelerometer window volatility. Sum of each
  // axis's (max - min) spread over the rolling window: still ≈ 0, moving
  // grows. Mapped to a qualitative 0-100 (≈3 g total spread = full).
  const accelChannels = channels.filter((c) => /accel/i.test(c.name));
  let activity: PatientInsights['activity'] = null;
  if (accelChannels.length > 0) {
    const spread = accelChannels.reduce(
      (sum, c) => sum + Math.max(0, c.stats.max - c.stats.min),
      0,
    );
    const score = Math.min(100, Math.round((spread / 3) * 100));
    const level: ActivityLevel = score < 12 ? 'resting' : score < 45 ? 'light' : 'active';
    activity = { score, level };
  }

  // Ambient — environmental context, latest values.
  const tempCh = findChannel(channels, /temp/i);
  const humCh = findChannel(channels, /humid/i);
  const ambient =
    tempCh || humCh
      ? { temp: tempCh ? Math.round(tempCh.value * 10) / 10 : null,
          humidity: humCh ? Math.round(humCh.value) : null }
      : null;

  const device: DeviceStatus = {
    band: { connected: ble.connected, name: ble.deviceName },
    hub: { connected: serial.connected },
    mic: { connected: audio.connected },
    channelCount,
    recording: { active: recording.active, elapsedSec: recording.elapsedSec },
    anyConnected: ble.connected || serial.connected || audio.connected,
  };

  return {
    hasData,
    heartRate,
    heartRateBand,
    activity,
    ambient,
    voiceLevel: dbToNorm(audio.rmsDb),
    device,
  };
}
