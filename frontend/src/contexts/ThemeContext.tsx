// Theme context — light / dark / system-follow
//
// Resolution order on first mount:
//   1. explicit localStorage override ("light" | "dark")
//   2. system preference via prefers-color-scheme
//
// The resolved theme is applied as a class on <html> so CSS variables in
// index.css switch palettes wholesale. Tailwind classes never change.
//
// `preference` is what the user *chose* ("system" means "follow OS"),
// while `resolvedTheme` is what's actually rendered (always "light" or
// "dark"). Components that want a toggle should read/write `preference`
// and render based on `resolvedTheme`.

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

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'theme-preference';

function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // localStorage might be unavailable (private mode, etc.)
  }
  return 'system';
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

function applyThemeClass(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStoredPreference(),
  );
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolve(readStoredPreference()),
  );

  // Apply class on mount and whenever resolvedTheme changes
  useEffect(() => {
    applyThemeClass(resolvedTheme);
  }, [resolvedTheme]);

  // Watch system preference changes — only affects rendering when the
  // user chose "system"; manual overrides win regardless.
  useEffect(() => {
    if (preference !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setResolvedTheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [preference]);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    setResolvedTheme(resolve(pref));
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // Ignore write failures
    }
  }, []);

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
    () => ({ preference, resolvedTheme, setPreference, toggle }),
    [preference, resolvedTheme, setPreference, toggle],
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
