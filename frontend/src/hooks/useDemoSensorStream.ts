/**
 * useDemoSensorStream — synthesise a 12-channel sensor feed that
 * looks like the real recordings in `backend/recordings/csv/`,
 * looped on a 3-minute cycle. Used in DEMO mode so the dashboard's
 * channel grid has something to render without a live ESP32.
 *
 * Gating (all four must hold before the stream emits):
 *   - `isDemoMode()` (VITE_DEMO_MODE=1)
 *   - serial NOT connected — real serial frames would fight ours
 *   - BLE NOT connected — same reason
 *   - replayActive === false — CSV replay owns the grid when on
 *
 * Wire format: synth frames go through the SAME `updateSensorData`
 * action the live WS uses (AppBridge.tsx fan-out). The channel
 * grid is source-agnostic — it just reads the store.
 *
 * Channel profiles are calibrated against the dynamics observed in
 * the saved recordings (`sensor_20260421_153925.csv` and others).
 * Per-channel mean / std / oscillation period were chosen so each
 * channel "feels" like its real counterpart:
 *
 *   CH1   — PPG IR raw (~448k ± 9k, ~1 Hz pulse + slow drift)
 *   CH2   — slow drift around 1212 (raw counter)
 *   CH3   — slow drift around 85k (raw counter)
 *   CH4   — HR BPM (72–77)
 *   CH5   — accel-Z (gravity-dominated, ~9 g)
 *   CH6   — accel-X (~1.8 g, ±0.8)
 *   CH7   — accel-Y (~3.4 g, ±1.5)
 *   CH8   — constant 27 (matches real recording — likely a status)
 *   CH9   — temperature (~27.08 °C)
 *   CH10  — humidity (~45 %)
 *   CH11  — atmospheric pressure (~102132 Pa)
 *   CH12  — RSSI / signal (~-69.8 dB)
 *
 * The loop is NOT exactly periodic in every signal — body channels
 * (CH5/6/7) use periods that don't divide 180s, so a small jump at
 * the loop boundary is masked by their natural noise. Atmospheric /
 * slow channels use divisor periods so they cycle cleanly.
 *
 * rAF-driven, capped at ~50 Hz emission rate; the channel grid
 * itself runs through the existing AppBridge throttle, so per-frame
 * cost stays at one store update.
 */

import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { isDemoMode } from '../lib/demoMode';

const LOOP_SEC = 180;            // 3-minute loop
const FRAME_MS = 1000 / 50;      // emit at ~50 Hz, matches real recordings

// Friendly channel names. The recorded CSVs use generic CH1..CH12
// headers because the firmware that wrote them doesn't emit a labelled
// header — the data-processor falls back to numbered labels at
// `data_processor.py:107`. For the demo we override with names that
// match each synth's underlying signal so the dashboard reads as a
// real wearable instead of a debug bench. Order is locked to the
// `frameValues()` order below — don't reshuffle one without the other.
const CHANNEL_NAMES = [
  'PPG-IR',     // CH1 — pulse-rate raw
  'PPG-G',      // CH2 — secondary PPG
  'PPG-R',      // CH3 — tertiary PPG
  'HR',         // CH4 — heart rate (bpm)
  'Accel-Z',    // CH5 — gravity-dominated
  'Accel-X',    // CH6
  'Accel-Y',    // CH7
  // CH8 — step counter. Looks constant in the recorded CSVs because
  // the user wasn't moving during the capture; we mirror that here
  // (synth value is locked at 27 — see frameValues()).
  'Steps',
  'Temp',       // CH9 — ambient temperature
  'Humidity',   // CH10
  'Pressure',   // CH11 — atmospheric Pa
  // CH12 — sea-level altitude derived from CH11 pressure (typically
  // negative inside London when pressure runs a bit above 1013 hPa,
  // which matches the ~-70 m baseline observed in the recordings).
  'Altitude',
];

// Uniform jitter in ±std. Math.random() suffices — these are visual
// channels, not signal-processing benchmarks, so no need for a proper
// gaussian.
function jitter(std: number): number {
  return (Math.random() - 0.5) * 2 * std;
}

// `tSec` is wallclock time modulo LOOP_SEC, so all sinusoids cycle
// against the same clock.
function frameValues(tSec: number): number[] {
  const sin = (period: number, phase = 0) =>
    Math.sin((tSec / period) * Math.PI * 2 + phase);
  return [
    // CH1: PPG IR raw — two close periods superimpose to look like a
    // pulsatile waveform, big jitter for the "noisy raw counter" look.
    Math.round(447734 + 5000 * sin(0.9) + 8000 * sin(1.1, 0.5) + jitter(1500)),
    // CH2: slow drift, small jitter.
    Math.round(1212 + 30 * sin(60) + jitter(5)),
    // CH3: slow drift, tight spread.
    Math.round(85278 + 100 * sin(45) + jitter(50)),
    // CH4: HR BPM, small int. ~72 bpm baseline with breathing-rate drift.
    Math.round(72 + 2 * sin(30) + jitter(0.5)),
    // CH5: accel-Z, gravity-dominated (~9.0 g), motion adds ±0.3.
    9.0 + 0.3 * sin(4) + jitter(0.2),
    // CH6: accel-X, smaller magnitude with faster motion.
    1.8 + 0.8 * sin(3) + jitter(0.4),
    // CH7: accel-Y, biggest swings of the three axes.
    3.4 + 1.4 * sin(5) + jitter(0.7),
    // CH8: constant. The real recording has zero variance here too.
    27,
    // CH9: body / ambient temperature, very slow drift.
    27.08 + 0.05 * sin(90) + jitter(0.02),
    // CH10: humidity %, very slow drift.
    45.16 + 0.2 * sin(120) + jitter(0.05),
    // CH11: atmospheric pressure Pa, very slow drift.
    102132 + 1.5 * sin(180) + jitter(0.5),
    // CH12: barometric altitude (m), QNH-calibrated to Imperial
    // College's ~24 m elevation. The raw recorded values land near
    // -70 m because they're computed against the ISA standard
    // 1013.25 hPa instead of the day's actual sea-level pressure —
    // see comment block above frameValues(). We bake in the
    // calibration offset here so the demo reads as a properly-set
    // altimeter rather than a raw barometric formula output.
    24.2 + 0.12 * sin(60) + jitter(0.07),
  ];
}

export function useDemoSensorStream(): void {
  const updateSensorData = useStore((s) => s.updateSensorData);
  const pointsPerChannel = useStore((s) => s.settings.points_per_channel);
  const serialConnected = useStore((s) => s.serial.connected);
  const bleConnected = useStore((s) => s.ble.connected);
  const replayActive = useStore((s) => s.replayActive);
  // User-controlled play flag — flipped by the header's ▶ button.
  // Stays false until clicked, so the dashboard cold-boots empty
  // rather than spamming synthetic data the moment demo mode opens.
  const demoStreamRunning = useStore((s) => s.demoStreamRunning);

  // Per-channel rolling window. Mutated in-place each frame; React
  // never reads it directly so a ref is the right shape.
  const buffersRef = useRef<number[][]>([]);

  // Keep the window-size setting fresh inside the rAF closure without
  // re-creating the effect (which would also wipe the buffers and
  // make the user's slider adjustment look like a glitch).
  const pointsRef = useRef(pointsPerChannel);
  useEffect(() => {
    pointsRef.current = pointsPerChannel;
  }, [pointsPerChannel]);

  useEffect(() => {
    if (!isDemoMode()) return;
    // Don't fight real data. The check covers both "actually using a
    // live device" and "CSV replay is driving the grid".
    if (serialConnected || bleConnected || replayActive) return;
    // Don't run until the user clicks ▶ in the header.
    if (!demoStreamRunning) return;

    // Fresh buffers each time the effect starts — gating changes
    // (e.g. user connects a device) tear down and restart, so we
    // shouldn't carry stale samples across.
    buffersRef.current = Array.from(
      { length: CHANNEL_NAMES.length },
      () => [],
    );

    let raf = 0;
    const t0 = performance.now();
    let lastEmit = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastEmit < FRAME_MS) return;
      lastEmit = now;

      const tSec = ((now - t0) / 1000) % LOOP_SEC;
      const values = frameValues(tSec);

      const cap = Math.max(1, pointsRef.current);
      const bufs = buffersRef.current;
      for (let i = 0; i < values.length; i++) {
        bufs[i].push(values[i]);
        // shift() is O(n) on the ring; at cap=100 it's a 100-int
        // memmove per frame per channel — fine at 50 Hz.
        while (bufs[i].length > cap) bufs[i].shift();
      }

      // Stats over the rolling window (same shape AppBridge expects
      // from the live WS). Hand-rolled instead of Array.reduce so we
      // can compute min / max / sum in a single pass per channel.
      const min: number[] = new Array(bufs.length);
      const max: number[] = new Array(bufs.length);
      const avg: number[] = new Array(bufs.length);
      for (let i = 0; i < bufs.length; i++) {
        const arr = bufs[i];
        let mn = Infinity;
        let mx = -Infinity;
        let sum = 0;
        for (let j = 0; j < arr.length; j++) {
          const v = arr[j];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          sum += v;
        }
        min[i] = mn === Infinity ? 0 : mn;
        max[i] = mx === -Infinity ? 0 : mx;
        avg[i] = arr.length > 0 ? sum / arr.length : 0;
      }

      // Send a shallow copy of each buffer so the consumer can hold
      // it without us mutating it on the next tick (the ring buffer
      // is mutated in place).
      updateSensorData(
        CHANNEL_NAMES,
        values,
        bufs.map((b) => b.slice()),
        { min, max, avg },
      );
    };

    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [
    updateSensorData,
    serialConnected,
    bleConnected,
    replayActive,
    demoStreamRunning,
  ]);
}
