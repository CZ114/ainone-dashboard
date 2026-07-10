/**
 * Starfield — small static decoration: ~40 absolutely-positioned dots
 * with staggered twinkle delays. Cheaper than Canvas for this scale and
 * the positions don't need to update once placed.
 *
 * Determinism: positions are seeded from a string-hash so subsequent
 * renders don't re-shuffle. We don't actually care about cryptographic
 * quality, just that hot-reloads don't make the layout jitter.
 */

import { useMemo } from 'react';
import { useThemeColors, rgba } from '../../hooks/useThemeColors';

interface Star {
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface StarfieldProps {
  count?: number;
  className?: string;
}

export function Starfield({ count = 40, className }: StarfieldProps) {
  const colors = useThemeColors();
  const stars = useMemo<Star[]>(() => {
    const rand = mulberry32(0x5e7); // arbitrary fixed seed
    return Array.from({ length: count }, () => ({
      x: rand() * 100,
      y: rand() * 100,
      size: 1 + rand() * 2,
      delay: rand() * 4,
      duration: 3 + rand() * 4,
    }));
  }, [count]);

  // Star tint from theme. textPrimary is "the brightest readable
  // colour" in every preset, so it's the right pick for tiny dots
  // that need to be visible without dominating.
  const starColor = rgba(colors.textPrimary, 0.85);
  const starGlow = rgba(colors.accent, 0.6);

  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden ${
        className ?? ''
      }`}
      aria-hidden
    >
      {stars.map((s, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: `${s.size}px`,
            height: `${s.size}px`,
            borderRadius: '50%',
            background: starColor,
            boxShadow: `0 0 6px ${starGlow}`,
            animation: `orb-twinkle ${s.duration}s ease-in-out ${s.delay}s infinite`,
          }}
        />
      ))}
    </div>
  );
}
