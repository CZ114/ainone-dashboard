// One diary entry rendered as a card. Reply / Mark-read are wired in
// Phase 2 via callbacks; the parent page owns the actual handlers.

import { MessageMarkdown } from '../chat/MessageMarkdown';
import type { DiaryEntry } from '../../api/diaryApi';
import { useT } from '../../contexts/LanguageContext';

interface EntryCardProps {
  entry: DiaryEntry;
  onReply?: (entry: DiaryEntry) => void;
  onMarkRead?: (entry: DiaryEntry) => void;
  onDelete?: (entry: DiaryEntry) => void;
  display?: 'timeline' | 'embedded';
  embeddedLabel?: string;
  /** Frozen research output shown in the patient report timeline. */
  readOnly?: boolean;
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

export function EntryCard({
  entry,
  onReply,
  onMarkRead,
  onDelete,
  display = 'timeline',
  embeddedLabel,
  readOnly = false,
}: EntryCardProps) {
  const t = useT();
  const triggerLabel =
    entry.trigger === 'cron'
      ? t.diary.entryCard.trigger.daily
      : entry.trigger === 'event'
      ? t.diary.entryCard.trigger.event
      : t.diary.entryCard.trigger.manual;

  // Embedded mode lets other clinical surfaces reuse the Diary renderer
  // without timeline-only metadata and reply/read/delete controls.
  if (display === 'embedded') {
    return (
      <article className="h-full bg-card-bg/60 p-4">
        <header className="mb-3 flex items-start justify-between gap-3 border-b border-card-border pb-3">
          <div>
            {embeddedLabel && (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                {embeddedLabel}
              </span>
            )}
            <h3 className="mt-1 text-sm font-semibold text-text-primary">{entry.title}</h3>
          </div>
          <span className="max-w-28 truncate font-mono text-[10px] text-text-muted" title={entry.model}>
            {entry.model}
          </span>
        </header>
        <div className="text-sm text-text-primary"><MessageMarkdown content={entry.body} variant="assistant" /></div>
      </article>
    );
  }

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
              {t.diary.entryCard.delayed}
            </span>
          )}
          {!entry.read && (
            <span className="rounded bg-accent/20 px-1.5 py-0.5 text-accent">
              {t.diary.entryCard.newBadge}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px]">
          {entry.duration_ms != null && (
            <span>{(entry.duration_ms / 1000).toFixed(1)}s</span>
          )}
          <span title={t.diary.entryCard.tokensTooltip}>
            {formatTokens(entry)}
          </span>
        </div>
      </header>

      <div className="text-sm text-text-primary">
        <MessageMarkdown content={entry.body} variant="assistant" />
      </div>

      {readOnly ? (
        <footer className="mt-3 border-t border-card-border pt-3 text-[11px] text-text-muted">
          冻结研究输出 · 当前为前端硬编码演示，不会写入或修改后端 Diary。（Frozen research output — a hard-coded front-end demo; nothing is written to or modified in the backend Diary.）
        </footer>
      ) : (
        <footer className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onReply?.(entry)}
            disabled={!onReply}
            className="rounded border border-card-border bg-accent/10 px-3 py-1 text-xs text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t.diary.entryCard.reply}
          </button>
          <button
            type="button"
            onClick={() => onMarkRead?.(entry)}
            disabled={entry.read || !onMarkRead}
            className="rounded border border-card-border px-3 py-1 text-xs text-text-secondary hover:bg-card-border/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {entry.read ? t.diary.entryCard.read : t.diary.entryCard.markRead}
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(entry)}
              disabled={!entry.read}
              title={
                entry.read
                  ? t.diary.entryCard.deleteEnabledTitle
                  : t.diary.entryCard.deleteDisabledTitle
              }
              className="rounded border border-card-border px-3 py-1 text-xs text-text-muted hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-card-border disabled:hover:bg-transparent disabled:hover:text-text-muted"
            >
              {t.diary.entryCard.delete}
            </button>
          )}
          {entry.context_refs.recordings.length > 0 && (
            <span className="ml-auto truncate text-[11px] text-text-muted" title={entry.context_refs.recordings.join(', ')}>
              {t.diary.entryCard.refs} {entry.context_refs.recordings.length}
            </span>
          )}
        </footer>
      )}
    </article>
  );
}
