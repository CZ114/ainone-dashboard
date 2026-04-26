// Settings route — currently only Extensions is implemented.
// Tab structure is set up so future features (General, About, etc.)
// can slot in without restructuring.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  extensionsApi,
  type ExtensionStatus,
} from '../../api/extensionsApi';
import { ThemeToggle } from '../ThemeToggle';
import { ExtensionCard } from './ExtensionCard';

type Tab = 'extensions' | 'about';

export function SettingsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('extensions');
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
              <span>Back</span>
            </button>
            <h1 className="text-lg font-bold text-text-primary">Settings</h1>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* Tab bar */}
      <nav className="shrink-0 border-b border-card-border bg-card-bg/50 px-6 flex gap-1">
        <TabButton active={activeTab === 'extensions'} onClick={() => setActiveTab('extensions')}>
          🔌 Extensions
        </TabButton>
        <TabButton active={activeTab === 'about'} onClick={() => setActiveTab('about')}>
          About
        </TabButton>
      </nav>

      {/* Body */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-6 py-6">
          {activeTab === 'extensions' && (
            <ExtensionsTabBody
              extensions={extensions}
              loading={loading}
              error={error}
              onRefresh={refresh}
            />
          )}
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
          ? 'text-text-primary border-blue-500'
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
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Extensions</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Install extra backend capabilities. Extensions install into the
            Python environment that runs the backend ({' '}
            <code className="text-text-secondary">sys.executable -m pip install</code>
            {' '}).
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="px-3 py-1.5 text-xs rounded text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 text-xs bg-red-500/10 border border-red-500/30 rounded text-red-400">
          <div className="font-semibold mb-1">Failed to load extensions</div>
          <div className="break-all">{error}</div>
          <div className="mt-2 text-text-muted">
            Is the Python backend running at <code>127.0.0.1:8080</code>?
          </div>
        </div>
      )}

      {!error && extensions.length === 0 && !loading && (
        <div className="text-center text-xs text-text-muted py-12">
          No extensions registered.
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
  return (
    <div className="prose prose-invert max-w-none text-sm text-text-secondary">
      <h2 className="text-base font-semibold text-text-primary">About</h2>
      <p>
        AinOne Dashboard — integrated real-time sensor UI, recording
        library, and AI chat interface powered by the Claude Agent SDK.
      </p>
      <ul className="mt-2 text-xs list-disc list-inside space-y-1">
        <li>
          Frontend: React + Vite + Zustand (
          <code className="text-text-muted">localhost:5173</code>)
        </li>
        <li>
          Python backend: FastAPI on{' '}
          <code className="text-text-muted">localhost:8080</code> — sensor /
          audio / recording pipelines + extensions
        </li>
        <li>
          Node backend: Hono on{' '}
          <code className="text-text-muted">localhost:3000</code> — Claude
          Agent SDK + embedded terminal
        </li>
      </ul>
    </div>
  );
}

export default SettingsPage;
