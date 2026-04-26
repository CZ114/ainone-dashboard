// Pill row for pending file attachments. Rendered directly above the
// chat textarea. Each pill shows type icon + filename + dismiss X.
// Hovering the filename reveals full path + size via tooltip.

import type { PendingAttachment } from '../../lib/attachments';
import {
  formatSize,
  iconForKind,
  totalAttachmentBytes,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from '../../lib/attachments';

interface AttachmentPillsProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentPills({ attachments, onRemove }: AttachmentPillsProps) {
  if (attachments.length === 0) return null;

  const total = totalAttachmentBytes(attachments);
  const overLimit = total > MAX_TOTAL_ATTACHMENT_BYTES;

  return (
    <div className="px-4 pt-3 pb-1 flex flex-wrap gap-1.5 items-center">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md bg-card-border/50 border border-card-border text-xs text-text-primary max-w-[18rem]"
          title={`${att.path}\n${formatSize(att.sizeBytes)}${
            att.kind === 'text' && att.content !== undefined
              ? ' — inlined'
              : ' — path reference only'
          }`}
        >
          <span className="shrink-0" aria-hidden="true">
            {iconForKind(att.kind)}
          </span>
          <span className="truncate">{att.filename}</span>
          <span className="text-text-muted shrink-0">
            · {formatSize(att.sizeBytes)}
          </span>
          <button
            onClick={() => onRemove(att.id)}
            className="shrink-0 ml-0.5 w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/30 hover:text-red-300 text-text-muted transition-colors"
            aria-label={`Remove ${att.filename}`}
            title="Remove attachment"
          >
            ×
          </button>
        </div>
      ))}
      {overLimit && (
        <div
          className="text-[10px] text-red-400 ml-1"
          title={`Total ${formatSize(total)} exceeds ${formatSize(MAX_TOTAL_ATTACHMENT_BYTES)}`}
        >
          ⚠ too large ({formatSize(total)})
        </div>
      )}
    </div>
  );
}
