// Header component with navigation

import { startTransition, useState } from 'react';
import { useStore } from '../../store';
import { useDiaryStore } from '../../store/diaryStore';
import { useLocation, useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../ThemeToggle';
import { LanguageToggle } from '../LanguageToggle';
import { useT } from '../../contexts/LanguageContext';
import { useAuth, useCan, isLensTab, openLensTab } from '../../contexts/RoleContext';
import type { FeatureKey, Role } from '../../lib/rolePolicy';
import { isDemoMode } from '../../lib/demoMode';

// Nav entries are data, not hand-written buttons — each one is gated
// by its rolePolicy feature key, so what a patient vs. doctor sees is
// decided by the policy table, never by ad-hoc role checks here.
interface NavItem {
  path: string;
  feature: FeatureKey;
  label: string;
  ariaLabel?: string;
}

// Role → icon shorthand for the identity badge on the right edge.
const ROLE_ICONS: Record<Role, string> = {
  patient: '🌿',
  doctor: '🩺',
  developer: '🔧',
};

// RoleBadge — current identity (icon + display name) with a tiny
// dropdown holding the single "sign out" action. Plain useState
// toggle; closes when focus leaves the badge subtree (onBlur), so no
// document-level click listener is needed.
function RoleBadge() {
  const { auth, logout } = useAuth();
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div
      className="relative"
      onBlur={(e) => {
        // Close only when focus moves outside the badge (button + menu).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors"
        title={t.header.roleBadge[auth.role]}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span aria-hidden="true">{ROLE_ICONS[auth.role]}</span>
        <span>{auth.name}</span>
        {isLensTab() && (
          <span
            className="ml-0.5 px-1 rounded bg-accent/20 text-accent text-[9px] font-bold"
            title="独立身份调试标签（本标签登录只存在于此标签，不影响其它标签）（Isolated identity debug tab — its login exists only in this tab and does not affect other tabs）"
          >
            镜 Lens
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 min-w-[8rem] py-1 rounded-lg border border-card-border bg-card-bg shadow-lg z-50"
          // Keep focus on the toggle button so the blur handler above
          // doesn't close the menu before the click lands.
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* Developer multi-view: open a new tab whose login is isolated to
              that tab (sessionStorage), so dev / doctor / patient can run side
              by side in one browser, each with a real token + real data scope. */}
          {auth.role === 'developer' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                openLensTab();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-card-border/50 transition-colors border-b border-card-border"
              title="新开一个独立登录的标签，可在同一浏览器里并排查看不同角色（真实数据隔离）（Open a new tab with an isolated login to view different roles side by side in one browser, with real data isolation）"
            >
              🔍 开调试镜标签 Open lens tab
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={logout}
            className="w-full text-left px-3 py-2 text-sm text-status-danger hover:bg-card-border/50 transition-colors"
          >
            {t.header.roleBadge.logout}
          </button>
        </div>
      )}
    </div>
  );
}

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
  const can = useCan();

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

  // Declared inside the component because labels come from the live
  // i18n table. Filtered through can() below — hidden routes simply
  // don't render for roles the policy table excludes.
  const NAV_ITEMS: NavItem[] = [
    { path: '/today', feature: 'route.today', label: t.header.nav.today },
    // 监测台平铺 tab 仅开发者可见 (nav.dashboardTab); 医生经患者列表进入。
    { path: '/dashboard', feature: 'nav.dashboardTab', label: t.header.nav.dashboard },
    // The voice-call walkthrough is deliberately a demo-only entry.
    // Its route remains available for direct links in realtime mode, but
    // exposing it there would make scripted playback look like live hardware.
    ...(demo
      ? [{ path: '/call', feature: 'route.call' as const, label: t.header.nav.callDemo }]
      : []),
    { path: '/patients', feature: 'route.patients', label: t.header.nav.patients },
    { path: '/doctor-evaluation', feature: 'route.patients', label: t.header.nav.doctorEvaluation },
    { path: '/diary', feature: 'route.diary', label: t.header.nav.diary },
    {
      path: '/settings',
      feature: 'route.settings',
      label: t.header.nav.settings,
      ariaLabel: t.header.settingsAria,
    },
  ];

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
            in startTransition. Rendered from NAV_ITEMS after the
            role-policy filter; /diary keeps its unread badge and
            /settings keeps its prefix-match highlight. */}
        <nav className="flex items-center gap-2">
          {NAV_ITEMS.filter((item) => can(item.feature)).map((item) => {
            const isDiary = item.path === '/diary';
            const isActive =
              item.path === '/settings'
                ? location.pathname.startsWith('/settings')
                : location.pathname === item.path;
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => goTo(item.path)}
                className={`${isDiary ? 'relative ' : ''}px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:text-text-primary hover:bg-card-border/50'
                }`}
                aria-label={item.ariaLabel}
              >
                {item.label}
                {isDiary && diaryUnread > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-status-disconnected text-white text-[10px] font-bold flex items-center justify-center"
                    aria-label={t.header.diaryUnreadAria(diaryUnread)}
                  >
                    {diaryUnread > 99 ? '99+' : diaryUnread}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Status indicators */}
        <div className="flex items-center gap-6">
          {/* Hardware telemetry (connection lights, recording pulse,
              channel count) is staff-facing — hidden for patients via
              the same policy table as the nav. */}
          {can('nav.statusLights') && (
            <>
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
            </>
          )}

          <LanguageToggle />
          <ThemeToggle />
          <RoleBadge />
        </div>
      </div>
    </header>
  );
}
