/**
 * ThinkingLoader — placeholder shadow blobs while Claude is composing.
 *
 * Three soft, blurred dots that pulse out of phase. Reads as
 * "thoughts gathering" — not characters yet, just shadow shapes
 * that'll soon coalesce into words via ConvergingText.
 *
 * Uses theme-aware accent colour so the loader fits into whatever
 * preset is active.
 */

import { useT } from '../../contexts/LanguageContext';

interface ThinkingLoaderProps {
  /** Optional caption rendered below the dots. */
  caption?: string;
  className?: string;
}

const DOT_COUNT = 3;
const DOT_DELAY_MS = 200; // stagger between dots
const PULSE_DURATION_MS = 1400;

export function ThinkingLoader({ caption, className }: ThinkingLoaderProps) {
  const t = useT();
  const label = caption ?? t.call.transcribing;

  return (
    <div
      className={`flex flex-col items-center gap-3 ${className ?? ''}`}
      aria-live="polite"
      aria-busy
    >
      <div className="flex items-center gap-3">
        {Array.from({ length: DOT_COUNT }, (_, i) => (
          <span
            key={i}
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: 'rgb(var(--color-accent))',
              boxShadow: '0 0 18px rgb(var(--color-accent) / 0.6)',
              animation: `call-think-pulse ${PULSE_DURATION_MS}ms ease-in-out ${
                i * DOT_DELAY_MS
              }ms infinite`,
              willChange: 'transform, opacity, filter',
            }}
          />
        ))}
      </div>
      <span className="text-[10px] uppercase tracking-[0.22em] text-text-muted">
        {label}
      </span>
    </div>
  );
}
