// Theme context — colour preset + light/dark resolution
//
// Two orthogonal axes:
//
//   1. `themeName` — which COLOUR PRESET ("archival", "nord",
//      "dracula", ...). Drives <html data-theme="..."> attribute.
//   2. `preference` (mode) — light / dark / system. Drives
//      <html class="light"> | <html class="dark"> as before.
//
// Each preset block in index.css defines BOTH light and dark
// variants for the same 13 surface/text/accent CSS variables, so
// the two axes compose: <html data-theme="nord" class="dark"> picks
// nord's dark palette.
//
// Persistence: a single localStorage entry "theme-config" stores
// `{name, mode}`. The legacy "theme-preference" key (used before
// presets existed) is migrated on first read so users don't lose
// their light/dark preference when this lands.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export type ThemeName =
  | 'archival'
  | 'carbon'
  | 'nord'
  | 'solarized'
  | 'dracula'
  | 'tokyo-night'
  | 'catppuccin'
  | 'codex-black';

export const THEME_NAMES: ThemeName[] = [
  'archival',
  'carbon',
  'nord',
  'solarized',
  'dracula',
  'tokyo-night',
  'catppuccin',
  'codex-black',
];

export interface ThemeMeta {
  name: ThemeName;
  label: string;
  description: string;
  /** Three colours rendered in the picker swatch — bg / accent / text. */
  swatch: { bg: string; accent: string; text: string };
}

/**
 * Picker metadata. Swatch colours are the canonical bg / accent / text
 * triple from each theme's DARK variant — picker thumbnails always
 * render the dark side because that's where each palette is most
 * distinctive.
 */
export const THEMES: Record<ThemeName, ThemeMeta> = {
  archival: {
    name: 'archival',
    label: 'Archival',
    description: 'Warm charcoal · sienna accent · the original dashboard look',
    swatch: { bg: '#181614', accent: '#BC7B5C', text: '#E8E4DE' },
  },
  carbon: {
    name: 'carbon',
    label: 'Carbon',
    description: 'High-contrast neutral grey · cyan accent · best readability',
    swatch: { bg: '#121212', accent: '#00BCD4', text: '#F0F0F0' },
  },
  nord: {
    name: 'nord',
    label: 'Nord',
    description: 'Arctic blue-grey · frosty cyan accents (Sven Greb)',
    swatch: { bg: '#2E3440', accent: '#88C0D0', text: '#ECEFF4' },
  },
  solarized: {
    name: 'solarized',
    label: 'Solarized',
    description: "Beige + cyan/blue · Ethan Schoonover's precision palette",
    swatch: { bg: '#002B36', accent: '#268BD2', text: '#FDF6E3' },
  },
  dracula: {
    name: 'dracula',
    label: 'Dracula',
    description: 'Purple/pink/cyan on near-black · classic dev theme',
    swatch: { bg: '#282A36', accent: '#BD93F9', text: '#F8F8F2' },
  },
  'tokyo-night': {
    name: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Deep navy · soft blue + magenta · Enkia',
    swatch: { bg: '#1A1B26', accent: '#7AA2F7', text: '#C0CAF5' },
  },
  catppuccin: {
    name: 'catppuccin',
    label: 'Catppuccin',
    description: 'Mocha (dark) + Latte (light) · pastel modern',
    swatch: { bg: '#1E1E2E', accent: '#F5C2E7', text: '#CDD6F4' },
  },
  'codex-black': {
    name: 'codex-black',
    label: 'Codex Black',
    description: 'Pure black + neon green · terminal-grade contrast',
    swatch: { bg: '#000000', accent: '#6EE7B7', text: '#F0F6FC' },
  },
};

interface ThemeContextValue {
  themeName: ThemeName;
  setThemeName: (name: ThemeName) => void;

  // Light/dark axis (kept on its own keys for backward-compat with the
  // existing ThemeToggle component's API).
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'theme-config';
const LEGACY_PREF_KEY = 'theme-preference';

interface StoredConfig {
  name: ThemeName;
  mode: ThemePreference;
}

function readStoredConfig(): StoredConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredConfig>;
      const name =
        parsed.name && THEMES[parsed.name as ThemeName]
          ? (parsed.name as ThemeName)
          : 'archival';
      const mode =
        parsed.mode === 'light' ||
        parsed.mode === 'dark' ||
        parsed.mode === 'system'
          ? parsed.mode
          : 'system';
      return { name, mode };
    }
    // Migrate legacy single-key preference if present.
    const legacy = localStorage.getItem(LEGACY_PREF_KEY);
    if (legacy === 'light' || legacy === 'dark' || legacy === 'system') {
      return { name: 'archival', mode: legacy };
    }
  } catch {
    /* localStorage unavailable */
  }
  return { name: 'archival', mode: 'system' };
}

function writeStoredConfig(cfg: StoredConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore quota / private mode */
  }
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function resolve(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? getSystemTheme() : pref;
}

function applyDom(name: ThemeName, mode: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(mode);
  root.setAttribute('data-theme', name);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const initial = readStoredConfig();
  const [themeName, setThemeNameState] = useState<ThemeName>(initial.name);
  const [preference, setPreferenceState] = useState<ThemePreference>(
    initial.mode,
  );
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolve(initial.mode),
  );

  // Apply DOM on mount and whenever any axis changes.
  useEffect(() => {
    applyDom(themeName, resolvedTheme);
  }, [themeName, resolvedTheme]);

  // Watch system preference changes — only matters when mode === 'system'.
  useEffect(() => {
    if (preference !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setResolvedTheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [preference]);

  const setPreference = useCallback(
    (pref: ThemePreference) => {
      setPreferenceState(pref);
      setResolvedTheme(resolve(pref));
      writeStoredConfig({ name: themeName, mode: pref });
    },
    [themeName],
  );

  const setThemeName = useCallback(
    (name: ThemeName) => {
      setThemeNameState(name);
      writeStoredConfig({ name, mode: preference });
    },
    [preference],
  );

  // Toggle flips resolved light↔dark. If the user was following system,
  // the toggle commits them to an explicit override (the opposite of
  // whatever system currently shows) — that's what they almost always
  // mean by clicking a toggle.
  const toggle = useCallback(() => {
    const nextResolved: ResolvedTheme =
      resolvedTheme === 'dark' ? 'light' : 'dark';
    setPreference(nextResolved);
  }, [resolvedTheme, setPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeName,
      setThemeName,
      preference,
      resolvedTheme,
      setPreference,
      toggle,
    }),
    [themeName, setThemeName, preference, resolvedTheme, setPreference, toggle],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
