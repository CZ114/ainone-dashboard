/**
 * ConvergingText — characters drift in from random offsets and
 * coalesce into legible text.
 *
 * V5: imperative DOM. Spans are created via `document.createElement`
 * and appended to a container <div>; React never sees them. The rAF
 * loop then mutates `style` on those handles directly. This bypasses:
 *
 *   - React reconciler (which won't touch elements it never created)
 *   - StrictMode's effect double-invocation cleanup race
 *   - any per-prop identity churn from CallPage's 50 Hz audio re-render
 *
 * Earlier attempts (history kept here so the next person doesn't go
 * in circles):
 *   - V1 @keyframes + CSS variables. Vite HMR didn't reliably pick
 *     up new keyframes; CSS-var resolution edge cases.
 *   - V2 React state-flip + `transition`. State flips occasionally
 *     batched; "before" frame never painted.
 *   - V3 per-span ref callbacks + imperative rAF. Inline ref callback
 *     identity changed every parent render → React called old(null)
 *     then new(el), the ref array was intermittently nulled.
 *   - V4 container ref + querySelectorAll. Spans rendered by React,
 *     queried imperatively. Logs showed V4 mount fired but V4
 *     complete never did. StrictMode cleanup fighting with rAF was
 *     the leading suspect.
 *
 * If V5 still doesn't animate the issue is no longer in React-land.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';

interface ConvergingTextProps {
  text: string;
  charDelayMs?: number;
  durationMs?: number;
  driftRadius?: number;
  className?: string;
}

interface CharSpec {
  ch: string;
  dx: number;
  dy: number;
  blur: number;
  delay: number;
  isNewline: boolean;
}

function pseudo(i: number, seed: number): number {
  const v = (Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1;
  return v < 0 ? v + 1 : v;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function ConvergingText({
  text,
  charDelayMs = 22,
  durationMs = 750,
  driftRadius = 70,
  className,
}: ConvergingTextProps) {
  const specs = useMemo<CharSpec[]>(() => {
    const out: CharSpec[] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const angle = pseudo(i, 1) * Math.PI * 2;
      const r = (0.3 + pseudo(i, 2) * 0.7) * driftRadius;
      out.push({
        ch,
        dx: Math.cos(angle) * r,
        dy: Math.sin(angle) * r,
        blur: 6 + pseudo(i, 3) * 8,
        delay: i * charDelayMs,
        isNewline: ch === '\n',
      });
    }
    return out;
  }, [text, charDelayMs, driftRadius]);

  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root || specs.length === 0) return;

    // eslint-disable-next-line no-console
    console.log(`[ConvergingText] V5 SETUP — ${specs.length} chars`);

    // Wipe whatever's in the container (likely from a previous reply).
    // Then build spans imperatively. React never sees these elements,
    // so re-renders of the parent don't touch them in any way.
    root.innerHTML = '';
    const spans: HTMLSpanElement[] = [];
    for (const s of specs) {
      if (s.isNewline) {
        root.appendChild(document.createElement('br'));
        spans.push(null as unknown as HTMLSpanElement);
        continue;
      }
      const span = document.createElement('span');
      span.style.display = 'inline-block';
      span.style.willChange = 'transform, opacity, filter';
      // Initial scattered/invisible state.
      span.style.transform = `translate(${s.dx}px, ${s.dy}px) scale(1.6)`;
      span.style.opacity = '0';
      span.style.filter = `blur(${s.blur}px)`;
      span.textContent = s.ch;
      root.appendChild(span);
      spans.push(span);
    }

    const startTime = performance.now();
    let raf = 0;
    let frames = 0;
    let nextLogAt = startTime + 500;
    const tick = (now: number) => {
      frames++;
      const elapsed = now - startTime;
      let allDone = true;
      for (let i = 0; i < specs.length; i++) {
        const span = spans[i];
        if (!span) continue; // newline placeholder
        const s = specs[i];
        const tRaw = (elapsed - s.delay) / durationMs;
        const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
        if (t < 1) allDone = false;
        const p = easeOutCubic(t);
        const dx = s.dx * (1 - p);
        const dy = s.dy * (1 - p);
        const scale = 1 + (1.6 - 1) * (1 - p);
        const blur = s.blur * (1 - p);
        span.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
        span.style.opacity = String(p);
        span.style.filter = `blur(${blur}px)`;
      }
      if (now >= nextLogAt) {
        // eslint-disable-next-line no-console
        console.log(
          `[ConvergingText] V5 tick @ ${elapsed.toFixed(0)}ms, frames=${frames}, allDone=${allDone}`,
        );
        nextLogAt = now + 500;
      }
      if (!allDone) {
        raf = requestAnimationFrame(tick);
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[ConvergingText] V5 COMPLETE after ${frames} frames (${elapsed.toFixed(0)} ms)`,
        );
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      // eslint-disable-next-line no-console
      console.log(`[ConvergingText] V5 CLEANUP (frames so far: ${frames})`);
      cancelAnimationFrame(raf);
    };
  }, [specs, durationMs]);

  // The container starts empty; the layout effect populates it. The
  // `key={text}` on this div forces a fresh DOM element on every new
  // reply, which guarantees the previous animation's listeners don't
  // linger.
  return (
    <div
      key={text}
      ref={containerRef}
      className={className}
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    />
  );
}
