/**
 * Orb — Canvas2D, 2D-noise polar membrane.
 *
 * What changed from the previous pass and why:
 *
 *   1) Topology actually evolves over time, instead of a fixed 1D
 *      pattern sliding around the circle. Now every shell samples
 *      `polarNoise(theta, freq, tx, ty)` — the (tx, ty) drift walks
 *      through a 2D noise field, so each angular position's radius
 *      varies independently of its neighbours over time. No more
 *      "the same lobe always appears at the same place".
 *
 *   2) Domain warping. Before sampling the radius noise we perturb
 *      the angle with another, slower noise field. This breaks any
 *      remaining radial symmetry — bumps stretch and curl rather than
 *      just rising and falling. It's the classic technique for
 *      turbulent / cellular looks.
 *
 *   3) Per-shell asynchronous expansion. Inner shells run on faster,
 *      stiffer springs; outer shells run on slower, softer springs.
 *      When audio level rises the inner core surges first, the outer
 *      halo follows ~150–250 ms later. Visually this reads as
 *      "energy radiating outward" — the EXPANSION the user asked for.
 *
 *   4) Asymmetric envelope (attack vs. release). Audio peaks pull the
 *      springs UP fast and DOWN slow, so loud moments expand quickly
 *      and then settle gradually. Combined with high damping (0.93)
 *      there is no overshoot — no bounce.
 *
 *   5) Overall scale is intentionally small (≤ ~7%). Most of the
 *      visible motion now comes from edge deformation, not from
 *      raw scaling — which is what kills the "simple bouncing ball"
 *      feel.
 *
 *   6) Per-shell time offsets so the four membranes don't share a
 *      master clock — they breathe independently.
 *
 * Colour, theme integration, and chromatic-aberration shimmer carry
 * over from the previous pass unchanged.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { AudioLevel } from '../../hooks/useAudioLevel';
import { useThemeColors, rgba } from '../../hooks/useThemeColors';
import { polarNoise3D } from '../../lib/noise';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface OrbProps {
  state: OrbState;
  levelRef: React.MutableRefObject<AudioLevel>;
  /**
   * "Excited" mode — used when something is being dragged over the
   * orb. Speeds up the inner conic sweep dramatically and adds an
   * outer rotating ring tinted with accent-warm so the user gets
   * unmistakable feedback that the orb is a drop target.
   */
  excited?: boolean;
  /**
   * Brief absorption pulse — fired when a successful drop completes.
   * The whole orb scales up briefly then settles back. We treat this
   * as a transient signal (parent sets true for ~500 ms then false).
   */
  absorbing?: boolean;
}

/**
 * Per-shell config.
 *
 * Temporal model: the noise field is 3D, with time on its own
 * orthogonal axis. `noiseTimeFreq` is *how fast* a fixed angular
 * slot's value cycles — higher value = bumps appear and disappear
 * more often. Crucially this is *not* a drift velocity, so bumps
 * don't slide; they fade in and out at random angular positions.
 *
 * Each shell has its own `seedZ` so they live at totally unrelated
 * z-slices of the noise field — no shared topology.
 *
 * Domain warp uses its own (warpFreq, warpTimeFreq) pair, slower
 * than the radial noise so the warp itself drifts gently underneath.
 */
interface Shell {
  radiusFrac: number;
  baseAlpha: number;
  noiseAmpBase: number;     // edge wobble at silence
  noiseAmpAudio: number;    // additional wobble per audio level
  noiseFreqRadius: number;  // spatial — how many lobes around circle
  noiseTimeFreq: number;    // temporal — how fast bumps fade in/out
  warpFreq: number;
  warpTimeFreq: number;
  warpStrength: number;
  springStiffness: number;
  springDamping: number;
  /** Asymmetric attack/release multiplier. */
  decayMultiplier: number;
  /** Z-axis seed: each shell parks at a different noise slice. */
  seedZ: number;
  colorSlot: 'inner' | 'outer' | 'halo';
  chromatic?: boolean;
}

const SHELLS: Shell[] = [
  // ── Outermost halo: huge, very translucent. Slow temporal freq
  //    means a single bubble lingers ~5s before the noise-field z
  //    advances enough to dissolve it.
  {
    radiusFrac: 0.92,
    baseAlpha: 0.16,
    noiseAmpBase: 0.11,
    noiseAmpAudio: 0.32,
    noiseFreqRadius: 1.3,
    noiseTimeFreq: 0.20,
    warpFreq: 0.5,
    warpTimeFreq: 0.08,
    warpStrength: 1.2,
    springStiffness: 0.018,
    springDamping: 0.94,
    decayMultiplier: 0.45,
    seedZ: 113.7,
    colorSlot: 'halo',
  },
  // ── Mid-outer iridescent shell with chromatic shimmer.
  {
    radiusFrac: 0.74,
    baseAlpha: 0.28,
    noiseAmpBase: 0.09,
    noiseAmpAudio: 0.28,
    noiseFreqRadius: 1.9,
    noiseTimeFreq: 0.32,
    warpFreq: 0.8,
    warpTimeFreq: 0.12,
    warpStrength: 0.9,
    springStiffness: 0.030,
    springDamping: 0.93,
    decayMultiplier: 0.50,
    seedZ: 47.7,
    colorSlot: 'outer',
    chromatic: true,
  },
  // ── Mid-inner body: denser bumps, faster temporal evolution.
  {
    radiusFrac: 0.55,
    baseAlpha: 0.42,
    noiseAmpBase: 0.08,
    noiseAmpAudio: 0.24,
    noiseFreqRadius: 2.6,
    noiseTimeFreq: 0.48,
    warpFreq: 1.3,
    warpTimeFreq: 0.20,
    warpStrength: 0.6,
    springStiffness: 0.055,
    springDamping: 0.91,
    decayMultiplier: 0.55,
    seedZ: 7.21,
    colorSlot: 'inner',
  },
  // ── Hot core: fastest, sharpest bumps. Reads as "internal
  //    turbulence" — bubbles emerge and pop at ~1Hz.
  {
    radiusFrac: 0.36,
    baseAlpha: 0.55,
    noiseAmpBase: 0.06,
    noiseAmpAudio: 0.18,
    noiseFreqRadius: 3.6,
    noiseTimeFreq: 0.72,
    warpFreq: 2.0,
    warpTimeFreq: 0.32,
    warpStrength: 0.4,
    springStiffness: 0.090,
    springDamping: 0.88,
    decayMultiplier: 0.65,
    seedZ: 161.8,
    colorSlot: 'inner',
  },
];

const POINTS_PER_SHELL = 140; // outline smoothness
const TWO_PI = Math.PI * 2;

interface SpringState {
  value: number;
  velocity: number;
  /** Time offset (seconds) so each shell's noise drift is unique. */
  tOffset: number;
}

export function Orb({ state, levelRef, excited, absorbing }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colors = useThemeColors();

  // Target colour for the current state. The rAF loop lerps a
  // separate "current" colour toward this one each frame, which is
  // what makes state changes (idle→listening, listening→thinking…)
  // dissolve into each other instead of snapping. Without the lerp
  // the canvas redraws with the new palette on the very next frame
  // and the user sees a colour pop.
  const targetBase = useMemo<[number, number, number]>(() => {
    const map: Record<OrbState, [number, number, number]> = {
      idle: colors.accentSoft,
      listening: colors.accent,
      thinking: colors.accentWarm,
      speaking: colors.accentHover,
    };
    return map[state];
  }, [state, colors]);

  // Refs for the lerp. `targetRef` is updated on every targetBase
  // change; `currentRef` is what we actually paint each frame and
  // glides from old colour → new over ~12 frames.
  const targetRef = useRef<[number, number, number]>(targetBase);
  const currentRef = useRef<[number, number, number]>([...targetBase] as [number, number, number]);
  useEffect(() => {
    targetRef.current = targetBase;
  }, [targetBase]);

  // Light-theme detection — switches the canvas composite from
  // `'lighter'` (additive glow, perfect on dark BG) to `'multiply'`
  // (saturated tint, clean on light BG). Additive blending on a
  // light background just clamps everything toward white and the
  // chromatic-channel passes pile up into a muddy yellow-green;
  // multiply produces crisp coloured tint and skips the dirt. The
  // ref is read inside the rAF so a theme switch picks up on the
  // very next frame without re-creating the loop.
  const isLightTheme = useMemo(() => {
    const [r, g, b] = colors.windowBg;
    // Rec. 601 luminance — fast, fine for a binary light/dark gate.
    return 0.299 * r + 0.587 * g + 0.114 * b > 160;
  }, [colors.windowBg]);
  const isLightRef = useRef(isLightTheme);
  useEffect(() => {
    isLightRef.current = isLightTheme;
  }, [isLightTheme]);

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

    // One spring per shell. Each shell expands on its own timetable;
    // outer shells lag behind inner ones, producing the radiating-
    // outward expansion.
    const springs: SpringState[] = SHELLS.map((_, i) => ({
      value: 0,
      velocity: 0,
      // Stagger each shell's noise time offset by a non-rational
      // amount so their drift never resyncs.
      tOffset: i * 17.43,
    }));

    const t0 = performance.now();

    const tick = () => {
      const target = levelRef.current.rms;
      const t = (performance.now() - t0) / 1000;

      // Step every spring forward one frame. Asymmetric envelope:
      // when audio is rising, springs use their normal stiffness; when
      // it's falling we multiply stiffness by `decayMultiplier` < 1
      // so the shell deflates more slowly than it inflated. Result:
      // expansion feels like releasing energy that lingers, not a
      // bouncing pulse.
      for (let i = 0; i < springs.length; i++) {
        const s = springs[i];
        const cfg = SHELLS[i];
        const rising = target > s.value;
        const stiffness =
          cfg.springStiffness * (rising ? 1 : cfg.decayMultiplier);
        s.velocity += (target - s.value) * stiffness;
        s.velocity *= cfg.springDamping;
        s.value += s.velocity;
        // Hard clamp negative — overshoot can drag value below 0
        // briefly, which would invert the noise amp. We don't want
        // that.
        if (s.value < 0) s.value = 0;
      }

      // Lerp the rendered colour toward the per-state target each
      // frame. Factor 0.06 ≈ 17-frame time constant ≈ 280 ms at
      // 60 fps — fast enough to feel responsive but slow enough that
      // state transitions read as a colour wash, not a step change.
      const tgt = targetRef.current;
      const cur = currentRef.current;
      cur[0] += (tgt[0] - cur[0]) * 0.06;
      cur[1] += (tgt[1] - cur[1]) * 0.06;
      cur[2] += (tgt[2] - cur[2]) * 0.06;
      const liveColor: [number, number, number] = [
        Math.round(cur[0]),
        Math.round(cur[1]),
        Math.round(cur[2]),
      ];

      ctx.clearRect(0, 0, cssW, cssH);

      const cx = cssW / 2;
      const cy = cssH / 2;
      const halfMin = Math.min(cssW, cssH) / 2;

      // Composite mode follows theme — see isLightTheme comment above.
      // Dark BG gets additive glow; light BG gets multiplied tint.
      const lightTheme = isLightRef.current;
      ctx.globalCompositeOperation = lightTheme ? 'multiply' : 'lighter';

      for (let s = 0; s < SHELLS.length; s++) {
        const shell = SHELLS[s];
        const spring = springs[s];

        // Per-shell scale comes from its own spring. Capped at +7%
        // so most visible motion is edge deformation, not size.
        const sizeScale = 1 + spring.value * 0.07;
        const baseR = halfMin * shell.radiusFrac * sizeScale;

        // Edge wobble amplitude — base level + audio-driven term.
        // The audio multiplier is large (×0.32) so the *shape*
        // changes a lot when the user speaks even though scale
        // barely moves.
        const noiseAmp =
          shell.noiseAmpBase + spring.value * shell.noiseAmpAudio;

        // Each shell parks at its own z-slice in the 3D noise field.
        // The rAF clock advances along z so every angular slot's
        // value evolves independently — bumps appear and dissolve
        // at random angles instead of the same lobes pulsing in
        // place. Adding spring.tOffset makes shells never share a
        // noise slice even at identical times.
        const shellTime = t + spring.tOffset + shell.seedZ;

        const points: Array<{ x: number; y: number }> = [];
        for (let i = 0; i <= POINTS_PER_SHELL; i++) {
          const theta = (i / POINTS_PER_SHELL) * TWO_PI;

          // Domain warp: a slower, lower-frequency 3D noise field
          // that perturbs the sampling angle. Without warp, bumps
          // sit at angular slots and just rise/fall; with warp,
          // they curl and stretch into surrounding angles.
          const warp =
            (polarNoise3D(
              theta,
              shell.warpFreq,
              shellTime,
              shell.warpTimeFreq,
              2,
            ) -
              0.5) *
            shell.warpStrength;

          const n = polarNoise3D(
            theta + warp,
            shell.noiseFreqRadius,
            shellTime,
            shell.noiseTimeFreq,
            3,
          );
          const r = baseR * (1 + (n - 0.5) * 2 * noiseAmp);

          points.push({
            x: cx + Math.cos(theta) * r,
            y: cy + Math.sin(theta) * r,
          });
        }

        // All four shells share the lerped live colour now (the
        // colorSlot field is kept for future per-shell tinting but
        // currently every slot resolves to the same triplet, just
        // smoothly transitioning between states).
        void shell.colorSlot;
        const baseColor = liveColor;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR * 1.1);
        grad.addColorStop(0, rgba(baseColor, shell.baseAlpha * 1.1));
        grad.addColorStop(0.6, rgba(baseColor, shell.baseAlpha * 0.6));
        grad.addColorStop(1, rgba(baseColor, 0));

        if (shell.chromatic && !lightTheme) {
          // Chromatic offset scales with audio so loud peaks "shatter"
          // the membrane edge into prismatic colours — the Annihilation
          // shimmer reference. Disabled on light theme: pure-channel
          // colours like [r,0,0] look great as additive over a dark
          // background but turn into solid red blobs under multiply
          // on a light background, which is uglier than the shimmer
          // it's meant to evoke.
          const offset = 1.5 + spring.value * 6;
          drawShellOffset(ctx, points, [baseColor[0], 0, 0], shell.baseAlpha * 0.5, -offset, 0);
          drawShellOffset(ctx, points, [0, baseColor[1], 0], shell.baseAlpha * 0.5, 0, offset);
          drawShellOffset(ctx, points, [0, 0, baseColor[2]], shell.baseAlpha * 0.5, offset, 0);
        }

        ctx.fillStyle = grad;
        ctx.beginPath();
        traceSmooth(ctx, points);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // We deliberately don't list `targetBase` in deps: state changes
    // should NOT tear down + rebuild the rAF (which would cancel the
    // colour lerp mid-flight and snap to the new value). Instead the
    // separate effect above writes `targetRef.current`, and the
    // single long-lived rAF below picks the new target up on its
    // next tick and lerps toward it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelRef]);

  return (
    <div
      // Size-agnostic: the parent sets the box size via its own
      // width/height (so the morph container can shrink the orb from
      // "fills the circle" to "small avatar at top of the card"
      // smoothly). We just fill 100% of whatever space we get.
      className="relative w-full h-full transition-transform duration-500 ease-out"
      style={{
        // `absorbing` triggers a brief whole-orb scale-up on a
        // successful drop. Parent toggles this true for ~500 ms then
        // back to false; the CSS transition handles both directions.
        transform: absorbing ? 'scale(1.12)' : 'scale(1)',
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
      {/* Excited ring — appears only while a draggable is hovering
          over the orb. A thick conic gradient that rotates ~3 s, with
          the active accent showing through; reads as "the orb is
          listening for the drop". CSS-only, no canvas mutation, so
          it composites cleanly on top of the existing render. */}
      {excited && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-[-6%] rounded-full"
          style={{
            background: `conic-gradient(from 0deg, transparent 0%, rgb(var(--color-accent-warm) / 0.55) 25%, transparent 50%, rgb(var(--color-accent) / 0.65) 75%, transparent 100%)`,
            filter: 'blur(14px)',
            mixBlendMode: 'screen',
            animation: 'orb-spin 3s linear infinite',
          }}
        />
      )}
    </div>
  );
}

function traceSmooth(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
): void {
  if (points.length < 2) return;
  const first = midpoint(points[0], points[1]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length - 1; i++) {
    const mid = midpoint(points[i], points[i + 1]);
    ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
  }
  ctx.closePath();
}

function midpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function drawShellOffset(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
  color: [number, number, number],
  alpha: number,
  dx: number,
  dy: number,
): void {
  ctx.save();
  ctx.translate(dx, dy);
  ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
  ctx.beginPath();
  traceSmooth(ctx, points);
  ctx.fill();
  ctx.restore();
}
