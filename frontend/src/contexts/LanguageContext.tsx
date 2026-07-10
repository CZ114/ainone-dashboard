// Language context — UI locale switch (English / 中文).
//
// Mirrors ThemeContext's shape: localStorage-persisted preference,
// React context for downstream consumers, single hook (`useLang` for
// raw lang + setter, `useT` for the translated string table). Default
// is English on first load (per product decision); user toggle is the
// only way to switch.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en, zh, type Strings } from '../i18n/strings';

export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'ui-lang';

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggle: () => void;
  t: Strings;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

const TABLES: Record<Lang, Strings> = { en, zh };

function readStoredLang(): Lang {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'en' || raw === 'zh') return raw;
  } catch {
    /* localStorage unavailable */
  }
  return 'en';
}

function writeStoredLang(lang: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore quota / private mode */
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);

  // Reflect on <html lang="..."> so screen readers / browser features
  // (font shaping, hyphenation) pick the right rules without having to
  // sniff React state.
  useEffect(() => {
    document.documentElement.setAttribute('lang', lang);
  }, [lang]);

  // Best-effort sync to the diary backend so scheduled runs (which the
  // UI never actively triggers) also pick up the user's language for
  // the built-in `diary_observer` system prompt. Manual triggers send
  // `lang` per-call from the diary store and don't depend on this.
  // Failure is silent — the backend default is 'en' which matches our
  // own default, so a missed PATCH degrades gracefully.
  useEffect(() => {
    fetch('/api/diary/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang }),
    }).catch(() => {
      /* backend unavailable / not yet running — ignore */
    });
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    writeStoredLang(next);
  }, []);

  const toggle = useCallback(() => {
    setLang(lang === 'en' ? 'zh' : 'en');
  }, [lang, setLang]);

  const value = useMemo<LanguageContextValue>(
    () => ({ lang, setLang, toggle, t: TABLES[lang] }),
    [lang, setLang, toggle],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return ctx;
}

/** Lightweight hook returning just the translated string table. */
export function useT(): Strings {
  return useLanguage().t;
}

/** Hook for components that need the lang code or to switch it. */
export function useLang() {
  const { lang, setLang, toggle } = useLanguage();
  return { lang, setLang, toggle };
}
