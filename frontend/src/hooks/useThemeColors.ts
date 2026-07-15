/**
 * useThemeColors — read live theme palette from CSS variables.
 *
 * The dashboard's theme system writes 8 colour presets × light/dark
 * onto `:root` as RGB triplets (e.g. `--color-accent: 188 123 92`).
 * Tailwind consumes these via `rgb(var(--color-accent) / <alpha>)`,
 * which is great for HTML, but Canvas2D can't read CSS variables —
 * we have to resolve them in JS.
 *
 * This hook resolves the triplets once on mount, then re-resolves when
 * the theme changes. Theme switches are detected via a MutationObserver
 * on `<html>` (the ThemeProvider toggles `class="light|dark"` and
 * `data-theme="..."` attributes), so consumers stay in sync without
 * any explicit notification.
 *
 * Returns an object of `[r, g, b]` arrays so callers can build the
 * exact alpha they want: `rgba(${r}, ${g}, ${b}, 0.4)`.
 */

import { useEffect, useState } from 'react';

export interface ThemeColors {
  windowBg: [number, number, number];
  cardBg: [number, number, number];
  cardBorder: [number, number, number];
  textPrimary: [number, number, number];
  textSecondary: [number, number, number];
  textMuted: [number, number, number];
  accent: [number, number, number];
  accentHover: [number, number, number];
  accentSoft: [number, number, number];
  accentWarm: [number, number, number];
}

const VAR_NAMES: Record<keyof ThemeColors, string> = {
  windowBg: '--color-window-bg',
  cardBg: '--color-card-bg',
  cardBorder: '--color-card-border',
  textPrimary: '--color-text-primary',
  textSecondary: '--color-text-secondary',
  textMuted: '--color-text-muted',
  accent: '--color-accent',
  accentHover: '--color-accent-hover',
  accentSoft: '--color-accent-soft',
  accentWarm: '--color-accent-warm',
};

function parseTriplet(raw: string): [number, number, number] {
  // CSS var values look like "188 123 92" — three space-separated ints.
  const m = raw.trim().match(/(\d+)\s+(\d+)\s+(\d+)/);
  if (!m) return [128, 128, 128];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function readPalette(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as ThemeColors;
  (Object.keys(VAR_NAMES) as Array<keyof ThemeColors>).forEach((k) => {
    out[k] = parseTriplet(cs.getPropertyValue(VAR_NAMES[k]));
  });
  return out;
}

export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(() => readPalette());

  useEffect(() => {
    const refresh = () => setColors(readPalette());
    // Watch for class change (light/dark flip) and data-theme change
    // (8 colour preset switch). Both happen on <html>.
    const obs = new MutationObserver(refresh);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => obs.disconnect();
  }, []);

  return colors;
}

/** Helper: build a CSS rgba string from a triplet + alpha. */
export function rgba(t: [number, number, number], a: number): string {
  return `rgba(${t[0]}, ${t[1]}, ${t[2]}, ${a})`;
}
