// Minimal toast — a transient message that fades after ~3 seconds.
// No deps, no queue; calling show() while one is visible replaces it
// (good enough for our very low notification volume).

import { useEffect, useState } from 'react';

export interface ToastMessage {
  id: number;
  text: string;
  kind?: 'info' | 'success' | 'error';
}

interface ToastProps {
  message: ToastMessage | null;
  durationMs?: number;
  onDismiss: () => void;
}

export function Toast({ message, durationMs, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!message) return;
    setVisible(true);
    // Auto-scale duration for longer messages — /help and /modes push
    // multi-line text that needs more time to read than a one-liner.
    const computedDuration =
      durationMs ??
      Math.min(9000, 2800 + Math.max(0, message.text.length - 40) * 30);
    const fadeTimer = setTimeout(() => setVisible(false), computedDuration - 200);
    const dismissTimer = setTimeout(onDismiss, computedDuration);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(dismissTimer);
    };
  }, [message, durationMs, onDismiss]);

  if (!message) return null;

  const kindClasses =
    message.kind === 'error'
      ? 'bg-red-600/90 border-red-400 text-white'
      : message.kind === 'success'
      ? 'bg-emerald-600/90 border-emerald-400 text-white'
      : 'bg-accent/90 border-accent-soft text-white';

  return (
    <div
      className={`fixed top-4 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-lg border shadow-lg text-sm transition-opacity duration-200 whitespace-pre-line max-w-[90vw] ${kindClasses} ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      role="status"
      aria-live="polite"
    >
      {message.text}
    </div>
  );
}
