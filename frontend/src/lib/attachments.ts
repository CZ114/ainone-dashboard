// Pending attachments: files the user has picked but not yet sent.
//
// Lifecycle:
//   - User clicks `+` → backend spawns OS picker → returns file metadata
//     (and body content for small text files). Each returned file is
//     added to `chatStore.pendingAttachments`.
//   - ChatInput renders a pill row above the textarea.
//   - On send, `buildPromptWithAttachments(message, attachments)` is
//     called; the resulting string is the `message` field of ChatRequest.
//   - After a successful send, `clearPendingAttachments()` resets state.
//
// Design choice (vs multimodal upload):
//   - Text attachments: inline content as fenced code blocks in the
//     prompt so Claude sees the full body without needing to call Read.
//   - Image / binary / too-large-text attachments: only include the
//     absolute path. Claude's built-in Read tool reads images AND text
//     files by path; the model itself decides whether to fetch.
//   - Zero backend upload storage. The entire "attachment" is just
//     in-memory frontend state + a string built from it at send time.

export type AttachmentKind = 'text' | 'image' | 'other' | 'recording';

// Extra metadata for kind === 'recording'. Stored inline on the
// attachment so buildPromptWithAttachments can synthesize a prompt
// block without needing to re-fetch the session.
export interface RecordingAttachmentMeta {
  sessionId: string;                       // "20260424_143022"
  csvFilename?: string;
  csvRows?: number | null;
  audioFilename?: string;
  audioDurationSeconds?: number | null;
  audioSizeBytes?: number;
  channels?: string[] | null;
  audioUrl?: string;                       // served by Python backend
}

export interface PendingAttachment {
  id: string;                    // crypto.randomUUID()
  path: string;                  // absolute, forward-slash. For recordings: the CSV path (or audio path if CSV absent)
  filename: string;              // basename for display
  sizeBytes: number;
  mimeType: string;              // best-effort guess from backend
  kind: AttachmentKind;
  content?: string;              // only for text files / small CSV previews (≤ 50 KB)
  recording?: RecordingAttachmentMeta;
}

// Guardrail for one message's total inlined-text payload.
//
// IMPORTANT: this caps the bytes that actually land in the PROMPT,
// not the on-disk file size. Image / recording-audio / other-binary
// attachments only contribute a one-line path reference, so a 20 MB
// WAV counts as ~256 bytes here. See `promptBytesFor` for the
// per-kind accounting.
//
// 20 MB is the ceiling: in practice Claude's context will start
// truncating well before that for fully-inlined text, but for the
// realistic mix (one preview-capped CSV + a couple of audio URLs +
// some short text snippets) the cap is effectively a "100 × 200 KB
// text file" backstop, nothing more.
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// Drag-and-drop MIME used to shuttle a recording session payload from
// RecordingsPanel → ChatInput. Custom MIME keeps our drops distinguishable
// from arbitrary OS file drags (which arrive as `Files` + text/uri-list).
export const RECORDING_DRAG_MIME = 'application/x-esp32-recording';

// Preview cap: when a user drags a recording into the chat we fetch at
// most this many data rows of the CSV inline. Anything beyond is still
// reachable via Claude's Read tool using the path in the prompt block.
export const RECORDING_CSV_PREVIEW_ROWS = 50;
export const RECORDING_CSV_INLINE_BYTES = 50 * 1024;

// Approximate prompt cost of one attachment, in bytes. The pill UI
// still SHOWS att.sizeBytes (file size — that's what the user
// expects to see), but the cap is enforced against this effective
// figure so a multi-MB WAV doesn't get rejected when only its URL
// makes it into the prompt.
export function promptBytesFor(att: PendingAttachment): number {
  // Text attachment: full content inlined as a fenced block.
  if (att.kind === 'text' && att.content !== undefined) {
    return att.content.length;
  }
  // Recording attachment: CSV preview (already capped at
  // RECORDING_CSV_INLINE_BYTES upstream) + a few hundred bytes of
  // metadata header. Audio-only recording = pure metadata.
  if (att.kind === 'recording') {
    return (att.content?.length ?? 0) + 256;
  }
  // Image / other: only a one-liner path reference goes to the model.
  return 256;
}

export function totalAttachmentBytes(attachments: PendingAttachment[]): number {
  return attachments.reduce((sum, a) => sum + promptBytesFor(a), 0);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function iconForKind(kind: AttachmentKind): string {
  switch (kind) {
    case 'text':
      return '📄';
    case 'image':
      return '🖼️';
    case 'recording':
      return '🎙️';
    default:
      return '📎';
  }
}

// Best-effort language tag for the markdown fence. Falls back to empty
// (which renders as a plain fenced block).
const EXT_TO_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', lua: 'lua',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', html: 'html', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql', dockerfile: 'dockerfile', ino: 'cpp',
};

function langForFilename(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return EXT_TO_LANG[ext] || '';
}

/**
 * Synthesize the final prompt string from the user's typed message plus
 * any pending attachments. Text bodies are fenced; images / other paths
 * are referenced as one-liners so Claude can decide whether to Read.
 *
 * If there are no attachments, returns the message unchanged — important
 * so no attachment scenarios don't suffer from extra formatting noise.
 */
export function buildPromptWithAttachments(
  message: string,
  attachments: PendingAttachment[],
): string {
  if (attachments.length === 0) return message;

  const blocks: string[] = [];
  attachments.forEach((att, i) => {
    const header = `[Attachment ${i + 1}: ${att.filename} (${formatSize(att.sizeBytes)})]`;
    if (att.kind === 'recording') {
      blocks.push(renderRecordingBlock(header, att));
    } else if (att.kind === 'text' && att.content !== undefined) {
      const lang = langForFilename(att.filename);
      blocks.push(`${header}\n\`\`\`${lang}\n${att.content}\n\`\`\``);
    } else if (att.kind === 'image') {
      // Tell Claude the path; its Read tool handles image content.
      blocks.push(`${header}\nImage file at: ${att.path}`);
    } else {
      blocks.push(`${header}\nFile at: ${att.path}`);
    }
  });

  blocks.push(message);
  return blocks.join('\n\n');
}

// Recording prompt block. Embeds CSV preview if small; always lists
// metadata (channels, duration, row count) + absolute paths so Claude
// can Read the full file on demand.
function renderRecordingBlock(header: string, att: PendingAttachment): string {
  const rec = att.recording;
  if (!rec) {
    return `${header}\nRecording (no metadata)`;
  }

  const lines: string[] = [header];
  lines.push(`ESP32 recording session: ${rec.sessionId}`);

  if (rec.channels && rec.channels.length > 0) {
    lines.push(`Channels: ${rec.channels.join(', ')}`);
  }
  if (typeof rec.csvRows === 'number') {
    lines.push(`CSV rows: ${rec.csvRows}`);
  }
  if (typeof rec.audioDurationSeconds === 'number') {
    lines.push(`Audio duration: ${rec.audioDurationSeconds.toFixed(1)}s`);
  }

  if (att.content) {
    // content is a CSV preview (header + up to N rows). Mark explicitly
    // whether it's a full dump or just the head so Claude knows if
    // more data can be Read.
    const isPreview = rec.csvRows !== null && rec.csvRows !== undefined &&
                      att.content.split('\n').length - 1 < (rec.csvRows ?? 0);
    lines.push(isPreview ? 'CSV preview (head):' : 'CSV content:');
    lines.push('```csv');
    lines.push(att.content.trimEnd());
    lines.push('```');
  }

  // Always include paths so Claude can Read full content on demand.
  if (rec.csvFilename) {
    lines.push(`CSV file: ${att.path}`);
  }
  if (rec.audioFilename && rec.audioUrl) {
    lines.push(`Audio URL (served by Python backend): ${rec.audioUrl}`);
  }

  return lines.join('\n');
}
