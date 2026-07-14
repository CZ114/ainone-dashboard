// Settings route — currently only Extensions is implemented.
// Tab structure is set up so future features (General, About, etc.)
// can slot in without restructuring.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  extensionsApi,
  type ExtensionStatus,
} from '../../api/extensionsApi';
import { ThemeToggle } from '../ThemeToggle';
import { ThemePicker } from '../ThemePicker';
import { ExtensionCard } from './ExtensionCard';
import { ModelRoutingPanel } from './ModelRoutingPanel';
import { KnowledgePanel } from './KnowledgePanel';
import { OrchestrationPanel } from './OrchestrationPanel';
import { DiarySettingsPanel } from '../diary/DiarySettingsPanel';
import { useT } from '../../contexts/LanguageContext';
import { useCan } from '../../contexts/RoleContext';

type Tab =
  | 'extensions'
  | 'model'
  | 'orchestration'
  | 'knowledge'
  | 'diary'
  | 'appearance'
  | 'about';

const TAB_IDS: readonly Tab[] = [
  'extensions',
  'model',
  'orchestration',
  'knowledge',
  'diary',
  'appearance',
  'about',
];

// Emoji prefix per tab ('' = label only, e.g. About).
const TAB_ICONS: Record<Tab, string> = {
  extensions: '🔌',
  model: '🧠',
  orchestration: '🎭',
  knowledge: '📚',
  diary: '📓',
  appearance: '🎨',
  about: '',
};

export function SettingsPage() {
  const navigate = useNavigate();
  const t = useT();
  const can = useCan();
  const [searchParams] = useSearchParams();
  // Role-filtered tab list — same order as TAB_IDS, filter only.
  const visibleTabs = TAB_IDS.filter((id) => can(`settings.tab.${id}`));
  const initialTab: Tab = (() => {
    const q = searchParams.get('tab');
    // 向后兼容：旧的 ?tab=agents / ?tab=workflows 都归入合并后的「编排」tab。
    const requested = q === 'agents' || q === 'workflows' ? 'orchestration' : q;
    if (requested && (visibleTabs as readonly string[]).includes(requested)) {
      return requested as Tab;
    }
    // Deep links to hidden/unknown tabs fall back to the first visible
    // tab, so e.g. ?tab=orchestration cannot leak a dev-only panel.
    return visibleTabs[0] ?? 'appearance';
  })();
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [extensions, setExtensions] = useState<ExtensionStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await extensionsApi.list();
    if (r.error) {
      setError(r.error);
      setExtensions([]);
    } else {
      setExtensions(r.extensions);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while any extension is installing — SSE drives the card's
  // own log+progress, but the list-level "installing" flag only
  // refreshes on full reload. Short poll (2s) is cheap.
  useEffect(() => {
    const anyInstalling = extensions.some((e) => e.installing);
    if (!anyInstalling) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [extensions, refresh]);

  return (
    <div className="h-screen bg-window-bg flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-card-bg border-b border-card-border px-6 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate(-1)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-card-border/50 rounded-lg transition-colors"
            >
              <span>←</span>
              <span>{t.settings.back}</span>
            </button>
            <h1 className="text-lg font-bold text-text-primary">{t.settings.title}</h1>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* Tab bar — only the tabs the current role can see */}
      <nav className="shrink-0 border-b border-card-border bg-card-bg/50 px-6 flex gap-1">
        {visibleTabs.map((id) => (
          <TabButton key={id} active={activeTab === id} onClick={() => setActiveTab(id)}>
            {TAB_ICONS[id] ? `${TAB_ICONS[id]} ${t.settings.tabs[id]}` : t.settings.tabs[id]}
          </TabButton>
        ))}
      </nav>

      {/* Body — 编排 tab 的可视化画布需要并排的 JSON 侧栏, 给更宽的容器 */}
      <main className="flex-1 overflow-y-auto">
        <div
          className={`${
            activeTab === 'orchestration' ? 'max-w-7xl' : 'max-w-3xl'
          } mx-auto w-full px-6 py-6`}
        >
          {activeTab === 'extensions' && (
            <ExtensionsTabBody
              extensions={extensions}
              loading={loading}
              error={error}
              onRefresh={refresh}
            />
          )}
          {activeTab === 'model' && <ModelRoutingPanel />}
          {activeTab === 'orchestration' && (
            <OrchestrationPanel onGoToKnowledge={() => setActiveTab('knowledge')} />
          )}
          {activeTab === 'knowledge' && <KnowledgePanel />}
          {activeTab === 'diary' && <DiarySettingsPanel />}
          {activeTab === 'appearance' && <ThemePicker />}
          {activeTab === 'about' && <AboutTabBody />}
        </div>
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
        active
          ? 'text-text-primary border-accent'
          : 'text-text-muted hover:text-text-primary border-transparent'
      }`}
    >
      {children}
    </button>
  );
}

function ExtensionsTabBody({
  extensions,
  loading,
  error,
  onRefresh,
}: {
  extensions: ExtensionStatus[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const t = useT();
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">{t.settings.extensions.heading}</h2>
          <p className="text-xs text-text-muted mt-0.5">
            {t.settings.extensions.descriptionBefore}
            <code className="text-text-secondary">sys.executable -m pip install</code>
            {t.settings.extensions.descriptionAfter}
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="px-3 py-1.5 text-xs rounded text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors disabled:opacity-50"
        >
          {loading ? t.settings.extensions.refreshing : t.settings.extensions.refresh}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 text-xs bg-status-danger/10 border border-status-danger/30 rounded text-status-danger">
          <div className="font-semibold mb-1">{t.settings.extensions.loadFailed}</div>
          <div className="break-all">{error}</div>
          <div className="mt-2 text-text-muted">
            {t.settings.extensions.backendHint} <code>127.0.0.1:8080</code>?
          </div>
        </div>
      )}

      {!error && extensions.length === 0 && !loading && (
        <div className="text-center text-xs text-text-muted py-12">
          {t.settings.extensions.empty}
        </div>
      )}

      <div className="space-y-3">
        {extensions.map((ext) => (
          <ExtensionCard key={ext.id} ext={ext} onChanged={onRefresh} />
        ))}
      </div>
    </div>
  );
}

function AboutTabBody() {
  const t = useT();
  return (
    <div className="prose prose-invert max-w-none text-sm text-text-secondary">
      <h2 className="text-base font-semibold text-text-primary">{t.settings.about.heading}</h2>
      <p>{t.settings.about.tagline}</p>
      <ul className="mt-2 text-xs list-disc list-inside space-y-1">
        <li>
          {t.settings.about.frontendLabel}: React + Vite + Zustand (
          <code className="text-text-muted">localhost:5173</code>)
        </li>
        <li>
          {t.settings.about.pythonBackendLabel}: FastAPI on{' '}
          <code className="text-text-muted">localhost:8080</code> — {t.settings.about.pythonBackendDesc}
        </li>
        <li>
          {t.settings.about.nodeBackendLabel}: Hono on{' '}
          <code className="text-text-muted">localhost:3000</code> — {t.settings.about.nodeBackendDesc}
        </li>
      </ul>
    </div>
  );
}

export default SettingsPage;
