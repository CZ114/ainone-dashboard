// Disk cache management UI for an extension that exposes
// runtime.cached_models. Renders one row per cached entry with size
// and a delete button; the active entry's button is disabled with a
// hint that the user must switch first.
//
// Generic on cached_models shape — any extension that returns the same
// list structure under runtime gets this UI for free. Currently only
// whisper-local uses it, but the contract is documented in
// backend/app/extensions/base.py.

import { useState } from 'react';
import {
  extensionsApi,
  type ExtensionCacheEntry,
} from '../../api/extensionsApi';

interface ExtensionCachePanelProps {
  extensionId: string;
  entries: ExtensionCacheEntry[];
  onChanged: () => void;
}

export function ExtensionCachePanel({
  extensionId,
  entries,
  onChanged,
}: ExtensionCachePanelProps) {
  // Track per-row deletion state so multiple deletes don't clobber
  // each other's spinners. `pending` is a Set of keys currently
  // mid-request.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [lastFreed, setLastFreed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const totalBytes = entries.reduce((sum, e) => sum + e.size_bytes, 0);
  const totalHuman = formatBytes(totalBytes);

  const handleDelete = async (key: string) => {
    if (
      !window.confirm(
        `Delete cached model '${key}'?\nIt will need to be re-downloaded next time you switch to it.`,
      )
    ) {
      return;
    }
    setPending((prev) => new Set(prev).add(key));
    setError(null);
    const r = await extensionsApi.deleteCache(extensionId, key);
    setPending((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (r.error) {
      setError(`${key}: ${r.error}`);
      return;
    }
    setLastFreed(r.freed_human ?? null);
    onChanged();
  };

  if (entries.length === 0) {
    return (
      <div className="text-[11px] text-text-muted">
        No models cached on disk yet. They'll be downloaded the first
        time you switch to them.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          Cached models
        </h4>
        <span className="text-[11px] text-text-muted font-mono">
          {entries.length} on disk · {totalHuman}
        </span>
      </div>

      <div className="rounded border border-card-border divide-y divide-card-border">
        {entries.map((entry) => (
          <div
            key={entry.name}
            className="flex items-center gap-3 px-3 py-2"
          >
            <span className="text-xs font-mono text-text-primary flex-1 min-w-0 truncate">
              {entry.name}
              {entry.is_active && (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30">
                  active
                </span>
              )}
            </span>
            <span className="text-[11px] text-text-muted font-mono tabular-nums shrink-0">
              {entry.size_human}
            </span>
            <button
              onClick={() => handleDelete(entry.name)}
              disabled={entry.is_active || pending.has(entry.name)}
              title={
                entry.is_active
                  ? 'Switch to another model first, then delete this one'
                  : `Delete cached '${entry.name}' (${entry.size_human})`
              }
              className="px-2 py-0.5 text-[11px] rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {pending.has(entry.name) ? '…' : 'Delete'}
            </button>
          </div>
        ))}
      </div>

      {lastFreed && !error && (
        <p className="text-[11px] text-green-400">
          ✓ Freed {lastFreed}
        </p>
      )}
      {error && (
        <p className="text-[11px] text-red-400">
          Delete failed — <code className="break-all">{error}</code>
        </p>
      )}
    </div>
  );
}

// Same byte formatter as the backend's _human_size, kept local so we
// can render the *total* (which the backend doesn't compute) without
// a round-trip.
function formatBytes(n: number): string {
  let size = n;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (size < 1024) return `${size.toFixed(1)} ${unit}`;
    size /= 1024;
  }
  return `${size.toFixed(1)} TB`;
}
