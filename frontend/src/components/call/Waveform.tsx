/**
 * Waveform — iOS9-style multi-curve audio visualization.
 *
 * Replaces the original "30 vertical bars" implementation. Bars are
 * accurate but feel utilitarian; what voice-AI products actually ship
 * (Siri, ChatGPT voice, ElevenLabs, Vapi) is a stack of soft sine
 * blobs blended additively so peaks look like a glowing energy field.
 *
 * Math (faithful port of kopiro/siriwave's iOS9 curve):
 *
 *   For each curve c with random offset/width/speed/phase:
 *     For each x in [-GRAPH_X, +GRAPH_X]:
 *       t = 4 * (-1 + (c / (N-1)) * 2) + offset[c]
 *       k = 1 / width[c]
 *       u = x * k - t
 *       att(u) = (4 / (4 + u²))^4         ← Gaussian-ish bell envelope
 *       y_local += |amp[c] * sin(verse[c]*u - phase[c]) * att(u)|
 *     y_local /= N                         ← keep within [0,1]
 *
 *     y(x) = AMP * heightMax * audioLevel * y_local * att((x/GRAPH_X)*2)
 *
 *   Each curve is filled twice (sign=+1 mirrored to sign=-1) so the
 *   shape is a closed blob, not a single line.
 *   `globalCompositeOperation = 'lighter'` turns overlapping fills
 *   additive — colour and intensity stack where curves intersect,
 *   which is the source of the glow.
 *
 * Layered rendering:
 *   - Curve 0: support gradient (subtle horizontal tint, theme cardBg)
 *   - Curves 1..3: each with a distinct colour pulled from the theme
 *     (accent / accent-warm / accent-soft), 0.55–0.7 alpha
 *
 * Audio level couples in two ways:
 *   - Drives `audioLevel` (overall amplitude scaling)
 *   - Drives a slow respawn cadence — each curve's amp also grows /
 *     shrinks over its own despawn timer for natural variation
 */

import { useEffect, useRef } from 'react';
import type { AudioLevel } from '../../hooks/useAudioLevel';
import { useThemeColors, rgba } from '../../hooks/useThemeColors';

interface WaveformProps {
  levelRef: React.MutableRefObject<AudioLevel>;
  /**
   * Number of curve groups (excluding the support tint). Each group
   * itself contains 2–4 sub-curves that respawn over time, so visual
   * complexity is much higher than the count alone suggests.
   */
  groups?: number;
  className?: string;
}

const GRAPH_X = 25;
const AMP_FACTOR = 0.85;
const ATT = 4;
// Tuning notes: the original siriwave constants worked for an
// "iPhone bottom of the screen" assistant — short, snappy, mostly
// active. For our full-page ambient call surface those defaults
// produce visible jitter (the waveform never settles between
// breaths). Slowed everything down ~3× and stretched the despawn
// window so curves persist long enough to feel like a single living
// shape rather than a churn of separate pulses.
const NO_OF_SUBCURVES_RANGE: [number, number] = [2, 5];
const AMP_RANGE: [number, number] = [0.3, 1];
const OFFSET_RANGE: [number, number] = [-3, 3];
const WIDTH_RANGE: [number, number] = [1.5, 3.5];
const SPEED_RANGE: [number, number] = [0.18, 0.45];     // was [0.5, 1]
const DESPAWN_MS_RANGE: [number, number] = [1800, 4500]; // was [600, 2200]
const DESPAWN_DELTA = 0.011;                              // was 0.022 — gentler grow/shrink
const PIXEL_STEP = 0.1;

interface SubCurve {
  phase: number;
  amp: number;
  finalAmp: number;
  offset: number;
  width: number;
  speed: number;
  verse: number;
  despawnAt: number;
}

interface CurveGroup {
  /** RGB triplet for this group's colour. */
  color: [number, number, number];
  alpha: number;
  /** Independent set of sub-curves, with their own respawn cadence. */
  subs: SubCurve[];
  spawnAt: number;
}

function rand(range: [number, number]): number {
  return range[0] + Math.random() * (range[1] - range[0]);
}

function spawnSubCurves(): SubCurve[] {
  const n = Math.max(2, Math.floor(rand(NO_OF_SUBCURVES_RANGE)));
  const subs: SubCurve[] = [];
  const now = performance.now();
  for (let i = 0; i < n; i++) {
    subs.push({
      phase: 0,
      amp: 0,
      finalAmp: rand(AMP_RANGE),
      offset: rand(OFFSET_RANGE),
      width: rand(WIDTH_RANGE),
      speed: rand(SPEED_RANGE),
      verse: Math.random() < 0.5 ? -1 : 1,
      despawnAt: now + rand(DESPAWN_MS_RANGE),
    });
  }
  return subs;
}

function attFn(x: number): number {
  return Math.pow(ATT / (ATT + x * x), ATT);
}

export function Waveform({ levelRef, groups = 3, className }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colors = useThemeColors();

  // Build the curve groups. Re-runs only when theme palette changes
  // (different group colours) — not every frame.
  const groupsRef = useRef<CurveGroup[]>([]);
  useEffect(() => {
    const baseColors: Array<[number, number, number]> = [
      colors.accent,
      colors.accentWarm,
      colors.accentSoft,
      colors.accentHover,
    ];
    const list: CurveGroup[] = [];
    for (let i = 0; i < groups; i++) {
      list.push({
        color: baseColors[i % baseColors.length],
        // Front-most curve gets the most opacity; back ones fade.
        alpha: 0.7 - i * 0.15,
        subs: spawnSubCurves(),
        spawnAt: performance.now(),
      });
    }
    groupsRef.current = list;
  }, [groups, colors]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let cssW = 0;
    let cssH = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      cssW = rect.width;
      cssH = rect.height;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Audio-level low-pass. Coefficient deliberately small (0.04 ≈
    // ~25-frame time constant at 60 fps) so the waveform glides
    // through level changes rather than tracking every micro-spike
    // — the previous 0.12 felt jittery especially on a chatty
    // synthetic source. We keep this local (not in useAudioLevel)
    // because the orb wants a different smoothing curve.
    //
    // We also keep a SECOND, even slower channel (`ambientLevel`)
    // that drifts toward the smoothed value but with a hard floor —
    // this is what scales the waveform's visual amplitude. The
    // floor (0.06) means even total silence keeps the membrane
    // breathing, which reads as "alive" rather than "frozen".
    let smoothLevel = 0;
    let ambientLevel = 0.1;

    const tick = () => {
      const target = levelRef.current.rms;
      smoothLevel += (target - smoothLevel) * 0.04;
      // Ambient is even lazier — it's the visual amplitude target.
      const ambientTarget = Math.max(0.06, smoothLevel);
      ambientLevel += (ambientTarget - ambientLevel) * 0.025;

      ctx.clearRect(0, 0, cssW, cssH);
      // Subtle horizontal support gradient — gives the waveform a
      // baseline so silent moments still feel anchored.
      const supportColor = rgba(colors.textMuted, 0.18);
      const supportFade = rgba(colors.textMuted, 0);
      const supGrad = ctx.createLinearGradient(0, 0, cssW, 0);
      supGrad.addColorStop(0, supportFade);
      supGrad.addColorStop(0.15, supportColor);
      supGrad.addColorStop(0.85, supportColor);
      supGrad.addColorStop(1, supportFade);
      ctx.fillStyle = supGrad;
      ctx.fillRect(0, cssH / 2 - 0.5, cssW, 1);

      ctx.globalCompositeOperation = 'lighter';

      const heightMax = cssH / 2;
      const now = performance.now();

      for (const grp of groupsRef.current) {
        // Update each sub-curve's amp + phase. Amps grow toward
        // finalAmp until despawn time, then shrink to zero — once at
        // zero, that whole group respawns with new random params.
        let allDead = true;
        for (const sc of grp.subs) {
          if (now >= sc.despawnAt) {
            sc.amp = Math.max(0, sc.amp - DESPAWN_DELTA);
          } else {
            sc.amp = Math.min(sc.finalAmp, sc.amp + DESPAWN_DELTA);
          }
          if (sc.amp > 0.001) allDead = false;
          // Speed is global * per-curve. We tie global speed to audio
          // level too so loud moments feel faster, not just bigger.
          // Both terms are roughly 1/3 of the original — the previous
          // values produced visible vibration even at idle.
          const globalSpeed = 0.06 + smoothLevel * 0.18;
          sc.phase = (sc.phase + globalSpeed * sc.speed) % (Math.PI * 2);
        }
        if (allDead) {
          grp.subs = spawnSubCurves();
          grp.spawnAt = now;
        }

        // Render this group's blob: walk x from -GRAPH_X to +GRAPH_X
        // computing y via the layered sin sum, then mirror top/bottom
        // so the shape closes.
        ctx.globalAlpha = grp.alpha;
        ctx.fillStyle = rgba(grp.color, 1);

        for (const sign of [1, -1]) {
          ctx.beginPath();
          for (let i = -GRAPH_X; i <= GRAPH_X; i += PIXEL_STEP) {
            const x = cssW * ((i + GRAPH_X) / (GRAPH_X * 2));
            // y_relative
            let yRel = 0;
            const N = grp.subs.length;
            for (let ci = 0; ci < N; ci++) {
              const sc = grp.subs[ci];
              const t = 4 * (-1 + (ci / Math.max(1, N - 1)) * 2) + sc.offset;
              const k = 1 / sc.width;
              const u = i * k - t;
              yRel += Math.abs(
                sc.amp * Math.sin(sc.verse * u - sc.phase) * attFn(u),
              );
            }
            yRel /= N;
            const yEnv = attFn((i / GRAPH_X) * 2);
            // Use the deeply-smoothed `ambientLevel` (not `smoothLevel`
            // directly) so the rendered amplitude eases — instantaneous
            // spikes in `smoothLevel` still affect curve speed, but
            // visual height drifts more slowly which reads as "settled".
            const y = AMP_FACTOR * heightMax * ambientLevel * yRel * yEnv;

            if (i === -GRAPH_X) {
              ctx.moveTo(x, heightMax - sign * y);
            } else {
              ctx.lineTo(x, heightMax - sign * y);
            }
          }
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [levelRef, colors]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}
