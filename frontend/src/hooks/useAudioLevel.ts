/**
 * useAudioLevel — unified 0–1 normalised RMS + peak feed for the call
 * page's animations.
 *
 * Three sources, exposed as the same interface so consumers don't care:
 *   - 'esp32': read live RMS/peak from the global Zustand store (already
 *     fed by FastAPI's WebSocket fan-out at 50 Hz).
 *   - 'mic':   open getUserMedia + a Web Audio AnalyserNode and compute
 *     RMS/peak from a single time-domain frame each rAF tick.
 *   - 'synthetic': a sin-wave + jitter so the orb has something to do
 *     before any real audio is wired. Useful for visual development.
 *
 * Output is normalised to [0, 1]:
 *   - ESP32 path: dB → linear via ((dB + 60) / 60), clamped.
 *   - Mic path:   raw RMS already in [0, 1] from float32 samples.
 *   - Synthetic:  derived directly.
 *
 * Returns a *ref* (not state) so consumers reading 60× per second don't
 * trigger React re-renders. The orb sets transform.style directly from
 * the ref each rAF tick.
 */

import { useEffect, useRef } from 'react';
import { useStore } from '../store';

export type AudioSource = 'esp32' | 'mic' | 'synthetic';

export interface AudioLevel {
  /** Smoothed level for the orb body. 0–1. */
  rms: number;
  /** Snappier level for the waveform bars. 0–1. */
  peak: number;
}

export interface UseAudioLevelResult {
  levelRef: React.MutableRefObject<AudioLevel>;
  /** True when the source is producing usable values. */
  active: boolean;
  /** Non-fatal status string for the UI to show ("waiting", "blocked", …). */
  status: 'idle' | 'active' | 'blocked' | 'waiting';
}

const DB_FLOOR = -60;
const DB_RANGE = 60;

function dbToNorm(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const n = (db - DB_FLOOR) / DB_RANGE;
  return Math.max(0, Math.min(1, n));
}

export function useAudioLevel(source: AudioSource): UseAudioLevelResult {
  const levelRef = useRef<AudioLevel>({ rms: 0, peak: 0 });
  const activeRef = useRef(false);
  const statusRef = useRef<UseAudioLevelResult['status']>('idle');
  // useStore inside an effect would re-subscribe on every dep change;
  // instead we hand-roll a subscription that just writes into our ref
  // when the audio slice updates.
  const audioSlice = useStore((s) => s.audio);

  useEffect(() => {
    levelRef.current = { rms: 0, peak: 0 };
    activeRef.current = false;
    statusRef.current = 'idle';

    if (source === 'synthetic') {
      // 60 Hz sine + low-amp noise. Period ~1.6s makes it feel like
      // breathing rather than a pure tone, so the orb looks alive
      // before any real audio arrives.
      let raf = 0;
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = (now - t0) / 1000;
        const base = (Math.sin(t * Math.PI * 0.7) + 1) / 2; // 0..1
        const jitter = (Math.random() - 0.5) * 0.08;
        const peak = Math.max(0, Math.min(1, base + jitter));
        // RMS lags peak slightly for a rounder look.
        const prev = levelRef.current.rms;
        const rms = prev + (base * 0.7 - prev) * 0.15;
        levelRef.current = { rms, peak };
        raf = requestAnimationFrame(tick);
      };
      activeRef.current = true;
      statusRef.current = 'active';
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    if (source === 'esp32') {
      // The store subscription below populates levelRef directly via
      // the `audioSlice` dep below; nothing to start/stop here.
      statusRef.current = audioSlice.connected ? 'active' : 'waiting';
      activeRef.current = audioSlice.connected;
      return;
    }

    if (source === 'mic') {
      let stream: MediaStream | null = null;
      let ctx: AudioContext | null = null;
      let analyser: AnalyserNode | null = null;
      let raf = 0;
      let cancelled = false;
      statusRef.current = 'waiting';

      (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          if (!cancelled) statusRef.current = 'blocked';
          return;
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext)();
        const src = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        // 1024 samples → ~21ms at 48 kHz; small enough for snappy peaks.
        analyser.fftSize = 1024;
        src.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        activeRef.current = true;
        statusRef.current = 'active';

        const tick = () => {
          if (!analyser) return;
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = buf[i];
            sum += v * v;
            if (v > peak) peak = v;
            else if (-v > peak) peak = -v;
          }
          const rmsRaw = Math.sqrt(sum / buf.length);
          // Mic levels are tiny (≈0.01 conversational); apply a gentle
          // power curve to make the orb actually move.
          const rms = Math.min(1, Math.pow(rmsRaw * 6, 0.7));
          const prev = levelRef.current.rms;
          const smoothed = prev + (rms - prev) * 0.25;
          levelRef.current = {
            rms: smoothed,
            peak: Math.min(1, Math.pow(peak * 5, 0.7)),
          };
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      })();

      return () => {
        cancelled = true;
        if (raf) cancelAnimationFrame(raf);
        if (analyser) analyser.disconnect();
        if (ctx) void ctx.close();
        if (stream) stream.getTracks().forEach((t) => t.stop());
        activeRef.current = false;
        statusRef.current = 'idle';
      };
    }

    return;
  }, [source, audioSlice.connected]);

  // ESP32 path: pump the store's dB values into the ref each render.
  // Cheap (just two assignments) and runs on every audio update because
  // useStore subscribes us above.
  useEffect(() => {
    if (source !== 'esp32') return;
    const rms = dbToNorm(audioSlice.rmsDb);
    const peak = dbToNorm(audioSlice.peakDb);
    // Lightly smooth the RMS so the orb glides instead of jittering on
    // the 50 Hz update tick.
    const prev = levelRef.current.rms;
    const smoothed = prev + (rms - prev) * 0.4;
    levelRef.current = { rms: smoothed, peak };
  }, [source, audioSlice.rmsDb, audioSlice.peakDb]);

  return {
    levelRef,
    active: activeRef.current,
    status: statusRef.current,
  };
}
