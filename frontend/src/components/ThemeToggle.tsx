// Theme toggle — sun/moon icon that flips light↔dark.
// Long-press (right-click) reveals a "Follow system" option via the
// native context menu, but for the common case a single click is enough.

import { useTheme } from '../contexts/ThemeContext';

export function ThemeToggle() {
  const { resolvedTheme, preference, setPreference, toggle } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // Right-click cycles through preferences so users can return to
    // "follow system" without digging into settings.
    const next =
      preference === 'system'
        ? 'light'
        : preference === 'light'
        ? 'dark'
        : 'system';
    setPreference(next);
  };

  const title =
    preference === 'system'
      ? `Theme: follow system (now ${resolvedTheme}). Click to override, right-click to cycle.`
      : `Theme: ${preference}. Click to toggle, right-click to cycle (light → dark → system).`;

  return (
    <button
      onClick={toggle}
      onContextMenu={handleContextMenu}
      className="flex items-center justify-center w-9 h-9 rounded-lg text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors"
      title={title}
      aria-label="Toggle theme"
    >
      {isDark ? (
        // Sun icon (shown in dark mode → click to go light)
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        // Moon icon (shown in light mode → click to go dark)
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
      )}
      {/* Tiny indicator dot if following system */}
      {preference === 'system' && (
        <span className="absolute w-1.5 h-1.5 rounded-full bg-blue-400 -mt-4 -mr-5" />
      )}
    </button>
  );
}
