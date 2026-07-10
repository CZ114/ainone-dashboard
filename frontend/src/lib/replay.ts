/**
 * CSV replay parser.
 *
 * Recording CSVs (written by `backend/app/services/recording_service.py`)
 * have the shape:
 *
 *   timestamp,channel_a,channel_b,...,channel_n
 *   2026-05-08T10:00:00.123Z,1.23,4.56,...
 *   2026-05-08T10:00:00.143Z,1.24,4.57,...
 *
 * The first column is an ISO-8601 timestamp string with millisecond
 * precision; remaining columns are floats. Inter-row spacing is
 * usually ~20 ms (the data loop runs at ~50 Hz) but we don't assume
 * a fixed cadence — every row's `tMs` is computed against the first
 * row so dropped frames don't desync replay against wall clock.
 */

import { recordingsApi } from '../api/recordingsApi';

export interface ReplayRow {
  /** ms relative to the first row in this file. */
  tMs: number;
  /** One float per channel. Length = channelNames.length. */
  values: number[];
}

export interface ReplayData {
  channelNames: string[];
  rows: ReplayRow[];
  /** Time span between the first and last rows, in ms. */
  totalMs: number;
  /** Wall-clock ms of the first row's timestamp, used so the export
   *  helper can reconstruct ISO timestamps that match the original
   *  recording's wire format. 0 if the first row's timestamp didn't
   *  parse (in which case exports fall back to ms-relative values). */
  baseMs: number;
}

function parseTimestampToMs(s: string): number {
  // `Date.parse` handles ISO-8601 with timezone; returns NaN on bad
  // input. Fallback to 0 keeps the row at "wall-clock zero" so a
  // single bad cell doesn't poison the whole file.
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

export async function loadReplay(csvFilename: string): Promise<ReplayData> {
  // Pull the WHOLE file — recordings are typically <5 MB, well under
  // the budget for a one-time replay load. `head` arg is omitted so
  // the backend doesn't truncate.
  const res = await recordingsApi.csvContent(csvFilename);
  const text = res.text || '';
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error('CSV is empty or has only a header row');
  }

  const header = lines[0].split(',');
  // First column is `timestamp`; remaining columns are channel names.
  const channelNames = header.slice(1).map((s) => s.trim());
  if (channelNames.length === 0) {
    throw new Error('CSV header has no channel columns');
  }

  const rows: ReplayRow[] = [];
  let baseMs = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 1 + channelNames.length) {
      // Truncated / malformed row — pad with zeros so the channel
      // count stays consistent across the run. Better than dropping
      // (which would create gaps in the replay timeline).
      while (cols.length < 1 + channelNames.length) cols.push('0');
    }
    const ts = parseTimestampToMs(cols[0]);
    if (i === 1) baseMs = ts;
    const tMs = ts - baseMs;
    const values: number[] = [];
    for (let c = 0; c < channelNames.length; c++) {
      const n = parseFloat(cols[1 + c]);
      values.push(Number.isFinite(n) ? n : 0);
    }
    rows.push({ tMs, values });
  }

  const totalMs = rows.length > 0 ? rows[rows.length - 1].tMs : 0;
  return { channelNames, rows, totalMs, baseMs };
}

/**
 * Build a CSV string for a sub-range of a loaded recording, in the
 * SAME wire format the FastAPI recording service writes — first
 * column is `timestamp` (ISO-8601), the rest are channel values.
 * That makes the export a drop-in replacement for the recording it
 * was cut from: re-importable for replay, comparable in third-party
 * tools, etc.
 */
export function buildClipCsv(
  data: ReplayData,
  startMs: number,
  endMs: number,
): string {
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  const lines: string[] = [];
  lines.push(['timestamp', ...data.channelNames].join(','));
  for (const row of data.rows) {
    if (row.tMs < lo || row.tMs > hi) continue;
    const ts =
      data.baseMs > 0
        ? new Date(data.baseMs + row.tMs).toISOString()
        : `${row.tMs}`;
    lines.push([ts, ...row.values.map((v) => String(v))].join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Trigger a browser download of `csv` as a file. Built without any
 * library — just Blob + an anchor click. Cleanup of the object URL
 * happens after the click; revoking immediately would race against
 * the browser's actual download handler in some browsers.
 */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // The anchor doesn't need to be in the DOM in modern browsers,
  // but Firefox historically required it; appending+removing covers
  // both cases.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke past any async download handling.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/**
 * Find the row whose `tMs` is the largest one ≤ `replayTimeMs`.
 * Linear scan from the previous index would be faster if callers
 * tracked it, but at 50 Hz × a few minutes (~10K rows) the linear
 * find here is ~tens of microseconds per frame — well below the
 * rAF budget. Kept simple.
 */
export function findRowAt(rows: ReplayRow[], replayTimeMs: number): number {
  // Binary search for the last row with tMs <= replayTimeMs.
  let lo = 0;
  let hi = rows.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].tMs <= replayTimeMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
