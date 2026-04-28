// One diary entry rendered as a card. Reply / Mark-read are wired in
// Phase 2 via callbacks; the parent page owns the actual handlers.

import { MessageMarkdown } from '../chat/MessageMarkdown';
import type { DiaryEntry } from '../../api/diaryApi';

interface EntryCardProps {
  entry: DiaryEntry;
  onReply?: (entry: DiaryEntry) => void;
  onMarkRead?: (entry: DiaryEntry) => void;
  onDelete?: (entry: DiaryEntry) => void;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: 'short',
    });
  } catch {
    return iso;
  }
}

function formatTokens(entry: DiaryEntry): string {
  if (entry.tokens) {
    const total = entry.tokens.input + entry.tokens.output;
    return `${total.toLocaleString()} tok`;
  }
  // Fallback estimate for entries created before we captured usage —
  // ~4 chars per token is the common heuristic.
  const estimate = Math.round(entry.body.length / 4);
  return `~${estimate.toLocaleString()} tok`;
}

export function EntryCard({ entry, onReply, onMarkRead, onDelete }: EntryCardProps) {
  const triggerLabel =
    entry.trigger === 'cron'
      ? 'daily'
      : entry.trigger === 'event'
      ? 'event'
      : 'manual';

  return (
    <article className="rounded-lg border border-card-border bg-card-bg/60 p-4 shadow-sm">
      <header className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text-secondary">
            {formatTime(entry.created_at)}
          </span>
          <span aria-hidden>·</span>
          <span>{entry.agent_id}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{entry.model}</span>
          <span className="rounded bg-card-border/40 px-1.5 py-0.5">
            {triggerLabel}
          </span>
          {entry.delayed && (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-400">
              delayed
            </span>
          )}
          {!entry.read && (
            <span className="rounded bg-accent/20 px-1.5 py-0.5 text-accent">
              new
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px]">
          {entry.duration_ms != null && (
            <span>{(entry.duration_ms / 1000).toFixed(1)}s</span>
          )}
          <span title="Tokens consumed (input + output)">
            {formatTokens(entry)}
          </span>
        </div>
      </header>

      <div className="text-sm text-text-primary">
        <MessageMarkdown content={entry.body} variant="assistant" />
      </div>

      <footer className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onReply?.(entry)}
          disabled={!onReply}
          className="rounded border border-card-border bg-accent/10 px-3 py-1 text-xs text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Reply
        </button>
        <button
          type="button"
          onClick={() => onMarkRead?.(entry)}
          disabled={entry.read || !onMarkRead}
          className="rounded border border-card-border px-3 py-1 text-xs text-text-secondary hover:bg-card-border/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {entry.read ? 'Read' : 'Mark read'}
        </button>
        <button
          type="button"
          onClick={() => onDelete?.(entry)}
          disabled={!entry.read || !onDelete}
          title={
            entry.read
              ? 'Delete this entry permanently'
              : 'Mark the entry as read first'
          }
          className="rounded border border-card-border px-3 py-1 text-xs text-text-muted hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-card-border disabled:hover:bg-transparent disabled:hover:text-text-muted"
        >
          Delete
        </button>
        {entry.context_refs.recordings.length > 0 && (
          <span className="ml-auto truncate text-[11px] text-text-muted" title={entry.context_refs.recordings.join(', ')}>
            refs: {entry.context_refs.recordings.length}
          </span>
        )}
      </footer>
    </article>
  );
}
