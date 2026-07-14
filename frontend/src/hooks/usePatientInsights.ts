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
//     the UI labels it qualitatively (resting / light / active).
//   - Everything is instantaneous ("right now"), never "today's
//     average" — there is no daily aggregation in the pipeline.
//
// Demo mode: when VITE_DEMO_MODE=1 and no real device is streaming, we
// synthesise a gently-drifting glove feed so the full page can be seen
// (heart rate ticks, activity/voice breathe). This is clearly demo data,
// only used when there is nothing real to show.
//
// When neither real nor demo data exists, `hasData` is false and the UI
// degrades gracefully (breathing-guide ring only, "connect" hints).

import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { isDemoMode } from '../lib/demoMode';
import type { ChannelData } from '../types';

export type ActivityLevel = 'resting' | 'light' | 'active';

export interface PatientInsights {
  hasData: boolean;
  isDemo: boolean;                 // true when the shown numbers are synthetic
  heartRate: number | null;        // bpm, rounded
  heartRateBand: 'low' | 'normal' | 'high' | null;
  activity: { score: number; level: ActivityLevel } | null;
  ambient: { temp: number | null; humidity: number | null } | null;
  voiceLevel: number;              // 0..1, from audio RMS dB
  device: DeviceStatus;
}

export interface DeviceStatus {
  glove: { connected: boolean; name: string | null };  // the smart glove (BLE)
  hub: { connected: boolean };                          // wired/USB data link
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
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

// Synthetic, gently-drifting insights for demo mode so the whole page is
// visible without a physical glove. Driven by a slow tick.
function buildDemoInsights(tick: number): PatientInsights {
  const hr = 72 + Math.round(4 * Math.sin(tick / 2.4));           // 68–76 bpm
  const actScore = 16 + Math.round(14 * (0.5 + 0.5 * Math.sin(tick / 3.1)));
  const voice = 0.08 + 0.16 * (0.5 + 0.5 * Math.sin(tick / 1.7));
  return {
    hasData: true,
    isDemo: true,
    heartRate: hr,
    heartRateBand: 'normal',
    activity: { score: actScore, level: actScore < 12 ? 'resting' : actScore < 45 ? 'light' : 'active' },
    ambient: { temp: 26.8, humidity: 45 },
    voiceLevel: voice,
    device: {
      glove: { connected: true, name: 'ESP32-S3-Glove' },
      hub: { connected: true },
      mic: { connected: true },
      channelCount: 12,
      recording: { active: false, elapsedSec: 0 },
      anyConnected: true,
    },
  };
}

export function usePatientInsights(): PatientInsights {
  const channels = useStore((s) => s.channels);
  const serial = useStore((s) => s.serial);
  const ble = useStore((s) => s.ble);
  const audio = useStore((s) => s.audio);
  const channelCount = useStore((s) => s.channelCount);
  const recording = useStore((s) => s.recording);

  // Demo drift tick — only runs when demo mode is on and nothing real
  // is streaming, so real deployments pay nothing.
  const [demoTick, setDemoTick] = useState(0);
  const demoActive = channels.length === 0 && isDemoMode();
  useEffect(() => {
    if (!demoActive) return;
    const id = setInterval(() => setDemoTick((t) => t + 1), 1500);
    return () => clearInterval(id);
  }, [demoActive]);

  if (demoActive) return buildDemoInsights(demoTick);

  const hasData = channels.length > 0;

  const hrChannel = findChannel(channels, /\bHR\b|heart/i);
  const heartRate = hrChannel ? Math.round(hrChannel.value) : null;
  const heartRateBand =
    heartRate === null ? null : heartRate < 55 ? 'low' : heartRate > 100 ? 'high' : 'normal';

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

  const tempCh = findChannel(channels, /temp/i);
  const humCh = findChannel(channels, /humid/i);
  const ambient =
    tempCh || humCh
      ? { temp: tempCh ? Math.round(tempCh.value * 10) / 10 : null,
          humidity: humCh ? Math.round(humCh.value) : null }
      : null;

  const device: DeviceStatus = {
    glove: { connected: ble.connected, name: ble.deviceName },
    hub: { connected: serial.connected },
    mic: { connected: audio.connected },
    channelCount,
    recording: { active: recording.active, elapsedSec: recording.elapsedSec },
    anyConnected: ble.connected || serial.connected || audio.connected,
  };

  return {
    hasData,
    isDemo: false,
    heartRate,
    heartRateBand,
    activity,
    ambient,
    voiceLevel: dbToNorm(audio.rmsDb),
    device,
  };
}
