// Header component with navigation

import { startTransition } from 'react';
import { useStore } from '../../store';
import { useDiaryStore } from '../../store/diaryStore';
import { useLocation, useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../ThemeToggle';

export function Header() {
  const serial = useStore((state) => state.serial);
  const ble = useStore((state) => state.ble);
  const audio = useStore((state) => state.audio);
  const channelCount = useStore((state) => state.channelCount);
  const isRecording = useStore((state) => state.recording.active);
  const diaryUnread = useDiaryStore((s) => s.unread);
  const location = useLocation();
  const navigate = useNavigate();

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
        {/* Logo — i-Thread Lab horizontal mark, served from
            frontend/public/logo-horizontal.svg. SVG so it stays crisp
            at any retina scale and the dashboard's dark/light themes
            both work without a second asset. */}
        <a
          href="/dashboard"
          onClick={(e) => {
            e.preventDefault();
            goTo('/dashboard');
          }}
          className="flex items-center gap-3 shrink-0"
          aria-label="i-Thread Lab — Dashboard home"
        >
          <img
            src="/logo-horizontal.svg"
            alt="i-Thread Lab"
            className="h-14 w-auto select-none md:h-16"
            draggable={false}
          />
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
            Dashboard
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
            Claude Chat
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
            Diary
            {diaryUnread > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-status-disconnected text-white text-[10px] font-bold flex items-center justify-center"
                aria-label={`${diaryUnread} unread diary entries`}
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
            aria-label="Open settings"
          >
            Settings
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
                Serial {serial.connected ? serial.port : 'Disconnected'}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  ble.connected ? 'bg-status-connected' : 'bg-status-disconnected'
                }`}
              />
              <span className="text-text-secondary">
                BLE {ble.connected ? ble.deviceName : 'Disconnected'}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  audio.connected ? 'bg-status-connected' : 'bg-status-disconnected'
                }`}
              />
              <span className="text-text-secondary">
                Audio {audio.connected ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>

          {/* Recording indicator */}
          {isRecording && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-status-disconnected/20 rounded-lg">
              <span className="w-2 h-2 rounded-full bg-status-disconnected animate-pulse" />
              <span className="text-status-disconnected text-sm font-medium">Recording</span>
            </div>
          )}

          {/* Channel count */}
          <div className="text-sm text-text-secondary">
            <span className="font-mono">{channelCount}</span> channels
          </div>

          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}