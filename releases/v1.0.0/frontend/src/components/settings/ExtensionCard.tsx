// Single extension card inside SettingsPage → Extensions tab.
//
// Responsibilities:
//   - Show current state (installed / enabled / installing / error).
//   - Primary action button cycles through the install lifecycle.
//   - During install: open an EventSource against the backend's SSE
//     progress endpoint, render a progress bar + scrolling log tail.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  extensionsApi,
  type ExtensionStatus,
  type InstallProgressEvent,
} from '../../api/extensionsApi';

interface ExtensionCardProps {
  ext: ExtensionStatus;
  onChanged: () => void;
}

// How many recent log lines to keep in UI memory. Pip output can be
// hundreds of lines; old ones aren't useful once install succeeds.
const LOG_TAIL_SIZE = 200;

export function ExtensionCard({ ext, onChanged }: ExtensionCardProps) {
  const [logLines, setLogLines] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [lastResult, setLastResult] = useState<
    { success: boolean; error: string | null } | null
  >(null);
  const esRef = useRef<EventSource | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the log viewer to the bottom on each new line.
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logLines]);

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setStreaming(false);
  }, []);

  // Tear down the stream on unmount. The backend will keep the job
  // running regardless — we can reconnect later via the same endpoint.
  useEffect(() => {
    return () => closeStream();
  }, [closeStream]);

  const openStream = useCallback(() => {
    closeStream();
    setStreaming(true);
    setLogLines([]);
    setProgress(0);
    setLastResult(null);
    esRef.current = extensionsApi.openProgressStream(
      ext.id,
      (evt: InstallProgressEvent) => {
        if (evt.kind === 'log') {
          setLogLines((prev) => {
            const next = [...prev, evt.line];
            return next.length > LOG_TAIL_SIZE
              ? next.slice(-LOG_TAIL_SIZE)
              : next;
          });
        } else if (evt.kind === 'progress') {
          setProgress(evt.pct);
        } else if (evt.kind === 'done') {
          setLastResult({ success: evt.success, error: evt.error });
          closeStream();
          onChanged();
        }
      },
      () => {
        // EventSource errors fire both on network issues and on clean
        // server-side close. Backend sends "done" before closing, so
        // by the time we see onerror we usually already know the
        // outcome. Just tear down defensively.
        closeStream();
      },
    );
  }, [ext.id, closeStream, onChanged]);

  const handleInstall = async () => {
    const r = await extensionsApi.install(ext.id);
    if (!r.ok) {
      window.alert(`Install failed to start: ${r.error}`);
      return;
    }
    openStream();
    onChanged();
  };

  const handleEnable = async () => {
    const r = await extensionsApi.enable(ext.id);
    if (!r.ok) window.alert(`Enable failed: ${r.error}`);
    onChanged();
  };

  const handleDisable = async () => {
    const r = await extensionsApi.disable(ext.id);
    if (!r.ok) window.alert(`Disable failed: ${r.error}`);
    onChanged();
  };

  const handleUninstall = async () => {
    if (
      !window.confirm(
        `Uninstall ${ext.name}?\nThe Python package stays cached; only the state flag is cleared.`,
      )
    ) {
      return;
    }
    const r = await extensionsApi.uninstall(ext.id);
    if (!r.ok) window.alert(`Uninstall failed: ${r.error}`);
    onChanged();
  };

  // If the backend reports installing=true (e.g. we navigated away and
  // came back), reconnect to the progress stream automatically.
  useEffect(() => {
    if (ext.installing && !streaming && !esRef.current) {
      openStream();
    }
    // We only want this effect to react to `ext.installing` flipping,
    // not to `streaming` changing as a side-effect of our own calls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ext.installing]);

  // State badge — one of: Not installed / Installing / Enabled / Disabled / Error
  const statusBadge = (() => {
    if (streaming || ext.installing) {
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
          Installing…
        </span>
      );
    }
    if (!ext.installed) {
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-card-border text-text-muted">
          Not installed
        </span>
      );
    }
    if (ext.last_error) {
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
          Error
        </span>
      );
    }
    if (ext.enabled) {
      return (
        <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30">
          Enabled
        </span>
      );
    }
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
        Disabled
      </span>
    );
  })();

  const showProgress = streaming || ext.installing || logLines.length > 0;

  return (
    <div className="p-4 rounded-lg bg-card-bg border border-card-border">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-text-primary">{ext.name}</h3>
            <span className="text-[11px] font-mono text-text-muted">
              v{ext.version}
            </span>
            {statusBadge}
          </div>
          <p className="mt-1 text-xs text-text-secondary leading-relaxed">
            {ext.description}
          </p>
          <p className="mt-1 text-[11px] text-text-muted font-mono">
            id: {ext.id}
            {ext.installed_at && (
              <>
                {' · '}installed {new Date(ext.installed_at).toLocaleString()}
              </>
            )}
          </p>
          {ext.last_error && (
            <p className="mt-2 text-xs text-red-400">
              Last error: <code className="break-all">{ext.last_error}</code>
            </p>
          )}
        </div>

        {/* Actions — right-aligned */}
        <div className="flex flex-col gap-1.5 shrink-0">
          {!ext.installed && (
            <button
              onClick={handleInstall}
              disabled={streaming || ext.installing}
              className="px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-700 disabled:bg-card-border disabled:cursor-not-allowed text-white font-medium"
            >
              {streaming || ext.installing ? 'Installing…' : 'Install'}
            </button>
          )}
          {ext.installed && !ext.enabled && (
            <button
              onClick={handleEnable}
              className="px-3 py-1.5 text-xs rounded bg-green-600 hover:bg-green-700 text-white font-medium"
            >
              Enable
            </button>
          )}
          {ext.installed && ext.enabled && (
            <button
              onClick={handleDisable}
              className="px-3 py-1.5 text-xs rounded bg-card-border hover:bg-card-border/70 text-text-primary"
            >
              Disable
            </button>
          )}
          {ext.installed && (
            <button
              onClick={handleUninstall}
              className="px-3 py-1.5 text-xs rounded text-red-400 hover:bg-red-500/10 border border-red-500/30"
            >
              Uninstall
            </button>
          )}
        </div>
      </div>

      {/* Progress bar + log tail */}
      {showProgress && (
        <div className="mt-4 space-y-2">
          {(streaming || ext.installing) && (
            <div>
              <div className="flex items-center justify-between text-[11px] text-text-muted mb-1">
                <span>Progress</span>
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-card-border overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-200"
                  style={{ width: `${Math.max(2, progress * 100)}%` }}
                />
              </div>
            </div>
          )}
          {logLines.length > 0 && (
            <div
              ref={logBoxRef}
              className="h-32 overflow-y-auto rounded bg-black/40 text-[11px] font-mono text-text-secondary p-2 border border-card-border"
            >
              {logLines.map((line, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">
                  {line}
                </div>
              ))}
            </div>
          )}
          {lastResult && !streaming && (
            <div
              className={`text-xs ${
                lastResult.success ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {lastResult.success
                ? '✓ Install complete.'
                : `✗ Install failed: ${lastResult.error || 'unknown error'}`}
            </div>
          )}
        </div>
      )}

      {/* Runtime status (if extension is running) */}
      {ext.runtime && Object.keys(ext.runtime).length > 0 && (
        <div className="mt-3 pt-3 border-t border-card-border/50 text-[11px] text-text-muted font-mono">
          {Object.entries(ext.runtime).map(([k, v]) => (
            <span key={k} className="mr-3">
              {k}: <span className="text-text-secondary">{String(v)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
