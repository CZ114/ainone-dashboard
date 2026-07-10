// Header component with navigation

import { startTransition } from 'react';
import { useStore } from '../../store';
import { useDiaryStore } from '../../store/diaryStore';
import { useLocation, useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../ThemeToggle';
import { LanguageToggle } from '../LanguageToggle';
import { useT } from '../../contexts/LanguageContext';
import { isDemoMode } from '../../lib/demoMode';

export function Header() {
  const serial = useStore((state) => state.serial);
  const ble = useStore((state) => state.ble);
  const audio = useStore((state) => state.audio);
  const channelCount = useStore((state) => state.channelCount);
  const isRecording = useStore((state) => state.recording.active);
  const diaryUnread = useDiaryStore((s) => s.unread);
  const location = useLocation();
  const navigate = useNavigate();
  const demo = isDemoMode();
  const t = useT();

  // Wrap route changes in startTransition so React 18 treats the
  // unmount/mount work as a non-urgent update — meaning sensor-data
  // re-renders that would otherwise hog the main thread can no
  // longer block the navigation. Without this, clicking "Claude
  // Chat" while recording felt like it had a multi-second latency
  // because each pending re-render had to land before the navigation
  // update could be committed.
  const goTo = (path: string) => {
    if (location.pathname === path) return;
    startTransition(() => {
      // navigate in v7 returns Promise<void> | void; the transition
      // callback expects void, so swallow the promise explicitly.
      void navigate(path);
    });
  };

  return (
    <header className="bg-card-bg border-b border-card-border px-6 py-2">
      <div className="flex items-center justify-between">
        {/* Logo — i-Thread Lab horizontal mark. Clicking opens the
            lab's homepage at imperial.ac.uk in a new tab; this is the
            BRAND link, not a navigation control. The nav buttons to
            the right handle in-app routing.
            target="_blank" + rel="noopener noreferrer" so the new
            tab can't reach back into our window via window.opener.
            Asset served from frontend/public/logo-horizontal.svg —
            SVG stays crisp at any retina scale and works on every
            theme without a second asset. */}
        <a
          href="https://www.imperial.ac.uk/hamlyn-centre/research/research-groups/i-thread-lab/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 shrink-0"
          aria-label={t.header.logoAria}
          title={t.header.logoTitle}
        >
          <img
            src="/logo-horizontal.svg"
            alt="i-Thread Lab"
            className="h-20 w-auto select-none md:h-24"
            draggable={false}
            width={720}
            height={240}
          />
          {/* DEMO badge — visible only when start.bat picked the demo
              entry (VITE_DEMO_MODE=1). Sits next to the logo so it's
              obvious which entry the user came in through. The actual
              data wiring is unchanged for now; this is the entry-point
              marker, not a data-source indicator. */}
          {demo && (
            <span
              className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider bg-accent/15 text-accent border border-accent/40 select-none"
              title={t.header.demoBadgeTitle}
              aria-label={t.header.demoBadge}
            >
              {t.header.demoBadge}
            </span>
          )}
        </a>

        {/* Navigation — buttons (not <Link>) so we can wrap navigate
            in startTransition. */}
        <nav className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => goTo('/dashboard')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              location.pathname === '/dashboard'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary hover:bg-card-border/50'
            }`}
          >
            {t.header.nav.dashboard}
          </button>
          <button
            type="button"
            onClick={() => goTo('/chat')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              location.pathname === '/chat'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary hover:bg-card-border/50'
            }`}
          >
            {t.header.nav.chat}
          </button>
          <button
            type="button"
            onClick={() => goTo('/call')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              location.pathname === '/call'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary hover:bg-card-border/50'
            }`}
          >
            {t.header.nav.call}
          </button>
          <button
            type="button"
            onClick={() => goTo('/diary')}
            className={`relative px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              location.pathname === '/diary'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary hover:bg-card-border/50'
            }`}
          >
            {t.header.nav.diary}
            {diaryUnread > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-status-disconnected text-white text-[10px] font-bold flex items-center justify-center"
                aria-label={t.header.diaryUnreadAria(diaryUnread)}
              >
                {diaryUnread > 99 ? '99+' : diaryUnread}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => goTo('/settings')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              location.pathname.startsWith('/settings')
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary hover:bg-card-border/50'
            }`}
            aria-label={t.header.settingsAria}
          >
            {t.header.nav.settings}
          </button>
        </nav>

        {/* Status indicators */}
        <div className="flex items-center gap-6">
          {/* Connection status */}
          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  serial.connected ? 'bg-status-connected' : 'bg-status-disconnected'
                }`}
              />
              <span className="text-text-secondary">
                {t.header.status.serial}{' '}
                {serial.connected ? serial.port : t.header.status.disconnected}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  ble.connected ? 'bg-status-connected' : 'bg-status-disconnected'
                }`}
              />
              <span className="text-text-secondary">
                {t.header.status.ble}{' '}
                {ble.connected ? ble.deviceName : t.header.status.disconnected}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  audio.connected ? 'bg-status-connected' : 'bg-status-disconnected'
                }`}
              />
              <span className="text-text-secondary">
                {t.header.status.audio}{' '}
                {audio.connected ? t.header.status.active : t.header.status.inactive}
              </span>
            </div>
          </div>

          {/* Recording indicator */}
          {isRecording && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-status-disconnected/20 rounded-lg">
              <span className="w-2 h-2 rounded-full bg-status-disconnected animate-pulse" />
              <span className="text-status-disconnected text-sm font-medium">{t.header.status.recording}</span>
            </div>
          )}

          {/* Channel count */}
          <div className="text-sm text-text-secondary">
            <span className="font-mono">{channelCount}</span> {t.header.status.channels}
          </div>

          <LanguageToggle />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}