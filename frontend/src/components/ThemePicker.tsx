// Theme picker — grid of swatches for the 8 colour presets.
//
// Lives inside Settings → Appearance. Wraps the existing ThemeToggle
// (light/dark/system) for the ORTHOGONAL light-dark axis, so users
// pick a palette here and cycle modes via the existing sun/moon
// button in the header.

import { THEMES, THEME_NAMES, useTheme, type ThemeName } from '../contexts/ThemeContext';

export function ThemePicker() {
  const { themeName, setThemeName, resolvedTheme, preference, setPreference } =
    useTheme();

  return (
    <div className="space-y-5">
      {/* Theme grid */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-1">
          Color preset
        </h3>
        <p className="text-[11px] text-text-muted mb-3">
          Each preset has a paired light + dark variant — switch
          between them with the mode picker below or the sun/moon
          button in the header.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {THEME_NAMES.map((name) => (
            <ThemeCard
              key={name}
              name={name}
              isActive={themeName === name}
              onSelect={() => setThemeName(name)}
            />
          ))}
        </div>
      </div>

      {/* Light / Dark / System mode */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-1">
          Mode
        </h3>
        <p className="text-[11px] text-text-muted mb-3">
          Choose which side of the current preset to render. "System"
          follows your OS preference.
        </p>
        <div className="inline-flex rounded-lg border border-card-border bg-window-bg p-0.5">
          {(['light', 'dark', 'system'] as const).map((m) => {
            const active = preference === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setPreference(m)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  active
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:text-text-primary hover:bg-card-border/40'
                }`}
              >
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-text-muted mt-2">
          Currently rendering: <span className="font-medium text-text-secondary">{resolvedTheme}</span>
          {preference === 'system' && ' (from OS preference)'}
        </p>
      </div>
    </div>
  );
}

function ThemeCard({
  name,
  isActive,
  onSelect,
}: {
  name: ThemeName;
  isActive: boolean;
  onSelect: () => void;
}) {
  const theme = THEMES[name];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group relative rounded-lg border-2 p-2 text-left transition-all ${
        isActive
          ? 'border-accent ring-2 ring-accent/30'
          : 'border-card-border hover:border-accent/50'
      }`}
      aria-pressed={isActive}
    >
      {/* Swatch preview — three stripes echoing bg / accent / text. */}
      <div
        className="rounded-md p-3 mb-2 border border-card-border/30"
        style={{ backgroundColor: theme.swatch.bg }}
      >
        <div
          className="h-6 rounded mb-1.5"
          style={{ backgroundColor: theme.swatch.accent }}
          aria-hidden
        />
        <div className="flex gap-1">
          <div
            className="h-1 rounded flex-[6]"
            style={{ backgroundColor: theme.swatch.text }}
            aria-hidden
          />
          <div
            className="h-1 rounded flex-[3] opacity-70"
            style={{ backgroundColor: theme.swatch.text }}
            aria-hidden
          />
        </div>
      </div>
      <div className="text-xs font-medium text-text-primary">{theme.label}</div>
      <div className="text-[10px] text-text-muted leading-snug mt-0.5">
        {theme.description}
      </div>
      {isActive && (
        <span
          className="absolute top-1.5 right-1.5 rounded-full bg-accent text-white w-5 h-5 flex items-center justify-center text-[11px] font-bold"
          aria-label="Active"
        >
          ✓
        </span>
      )}
    </button>
  );
}
