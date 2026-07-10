// Language toggle — EN ↔ 中. Single click flips, persists via
// LanguageContext's localStorage. Same 36×36 footprint as ThemeToggle
// so they sit nicely side-by-side in the Header.
//
// Visual: shows the CURRENT language as a 2-character pill ("EN" or
// "中"), not the target. Title attribute reveals the target language
// so users understand it's a toggle.

import { useT, useLang } from '../contexts/LanguageContext';

export function LanguageToggle() {
  const t = useT();
  const { lang, toggle } = useLang();
  const next = lang === 'en' ? 'zh' : 'en';

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex items-center justify-center w-9 h-9 rounded-lg text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors text-sm font-semibold tracking-wide"
      title={t.header.languageToggleTitle(next)}
      aria-label={t.header.languageToggleAria}
    >
      {lang === 'en' ? 'EN' : '中'}
    </button>
  );
}
