/**
 * ReadingDataLoader — visualises Claude consulting a list of data
 * files. Two modes share the same visual frame:
 *
 *   - phase='reading'   (during 'thinking'): files step from queued
 *                       → active (◇ pulsing) → done (✓). The last
 *                       file stays active until the parent unmounts.
 *   - phase='consulted' (after the AI bubble lands): all files
 *                       shown as done (✓), no pulsing dots in the
 *                       caption, slightly muted text. Persists with
 *                       the AI turn for the rest of the conversation
 *                       so the watcher can scroll back and see what
 *                       was read.
 *
 * The same component is used for both so that during the live
 * 'reading' phase and the persistent 'consulted' state the files
 * sit in the SAME on-screen position with the SAME layout — the
 * transition feels like the panel "settling" rather than two
 * different elements appearing in sequence.
 *
 * Tone: monospace filenames, small uppercase caption — reads as
 * a build log / data-pipeline panel rather than a chat element.
 * That's deliberate: the goal is "system at work", not "another
 * chat bubble".
 */

import { useEffect, useState } from 'react';
import { useT } from '../../contexts/LanguageContext';

export type ReadingDataPhase = 'reading' | 'consulted';

interface ReadingDataLoaderProps {
  /** Filenames to step through (or display as already-read in
   *  consulted mode). Order is the visual order. */
  files: string[];
  /** Total time the loader is on screen, in ms. Used to compute the
   *  per-file dwell during 'reading'. Ignored in 'consulted' mode. */
  durationMs?: number;
  /** Live stepping (default) or persistent all-done snapshot. */
  phase?: ReadingDataPhase;
}

export function ReadingDataLoader({
  files,
  durationMs = 0,
  phase = 'reading',
}: ReadingDataLoaderProps) {
  const t = useT();
  // In 'consulted' mode every file is past the active index, so all
  // rows render with the green check.
  const [activeIdx, setActiveIdx] = useState(
    phase === 'consulted' ? files.length : 0,
  );

  useEffect(() => {
    if (phase !== 'reading') {
      // Snap to all-done when the parent flips us into the consulted
      // state. Without this, an in-flight stepping interval could
      // briefly leave the row count behind the new mode.
      setActiveIdx(files.length);
      return;
    }
    if (files.length <= 1) return;
    // Equal time per file — the previous 0.85/(n-1) formula made the
    // first file hog 85% of the dwell on a 2-file panel, which felt
    // unreal. With `durationMs / files.length` each file gets the
    // same on-screen "reading" time, and the final file is naturally
    // still-active when the parent unmounts (the loop never advances
    // past length-1, so activeIdx stays at length-1 for the last
    // stepMs). Per-file dwell at the call demo's tunings lands at
    // ~700–900 ms, which reads as "real work" rather than a quick
    // glance.
    const stepMs = durationMs / files.length;
    let i = 0;
    const id = window.setInterval(() => {
      i++;
      if (i >= files.length) {
        window.clearInterval(id);
        return;
      }
      setActiveIdx(i);
    }, stepMs);
    return () => window.clearInterval(id);
  }, [files, durationMs, phase]);

  if (files.length === 0) return null;

  const isConsulted = phase === 'consulted';

  return (
    <div
      className={`rounded-2xl border px-4 py-3 max-w-[82%] ${
        isConsulted
          ? 'border-card-border/70 bg-card-bg/40'
          : 'border-card-border bg-card-bg/60'
      }`}
    >
      <div className="flex items-center gap-2 mb-2.5 text-[10px] uppercase tracking-[0.22em] text-text-muted">
        <span aria-hidden>📂</span>
        <span>
          {isConsulted
            ? `${t.call.readingDataDone} · ${files.length}`
            : t.call.readingData}
        </span>
        {/* Pulsing dots are a "still working" indicator — only show
            them while we're actually reading. In 'consulted' mode
            the panel is a static record, so no dots. */}
        {!isConsulted && (
          <span className="ml-1 inline-flex gap-0.5" aria-hidden>
            <Dot delay={0} />
            <Dot delay={150} />
            <Dot delay={300} />
          </span>
        )}
      </div>
      <ul className="space-y-1.5 font-mono text-xs">
        {files.map((file, i) => {
          const isDone = i < activeIdx;
          const isActive = i === activeIdx && !isConsulted;
          return (
            <li key={file} className="flex items-center gap-2">
              <span
                className={`inline-flex w-4 justify-center text-[13px] leading-none ${
                  isDone
                    ? 'text-status-connected'
                    : isActive
                      ? 'text-accent'
                      : 'text-text-muted/40'
                }`}
                aria-hidden
              >
                {isDone ? '✓' : isActive ? (
                  <span className="animate-pulse">◇</span>
                ) : (
                  '·'
                )}
              </span>
              <span
                className={
                  isActive
                    ? 'text-text-primary'
                    : isDone
                      ? isConsulted
                        ? 'text-text-muted'
                        : 'text-text-secondary'
                      : 'text-text-muted/50'
                }
              >
                {file}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  // Tailwind's `animate-pulse` is opacity 0.5 ↔ 1; we want a sharper
  // "tick" so the dots feel more like a status light than a fade.
  // Inline keyframes via boxShadow scale would need global CSS;
  // instead, lean on animate-pulse + a per-dot delay, accepting the
  // gentler curve as a tradeoff for zero new CSS.
  return (
    <span
      className="inline-block w-1 h-1 rounded-full bg-accent animate-pulse"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}
