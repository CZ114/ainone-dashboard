// BackendGate — block the app shell until both backends respond.
//
// First-run boot order (start.bat / start.sh) is:
//   [1/3] Python backend  :8080   ← may take ~10 s while pip installs
//   [2/3] Claude (Hono)   :3000   ← may take ~10 s while npm installs
//   [3/3] Vite frontend   :5173   ← ready in ~1 s, opens browser
//
// Without this gate, the user lands on /dashboard before Python is
// listening: the WS proxy throws ECONNREFUSED, REST calls 502, and
// the channel grid sits empty with no obvious diagnosis.
//
// What we do instead: cover the screen with a loading splash that
// shows a status row per tier and polls /api/health (Python) and
// /api/projects (Hono — cheap, always 200 once the SDK probe is
// done). Both green → un-render the gate, the actual app mounts
// on the freshly-warm backends.
//
// Escape hatches:
//   - 8 s after first paint, a "Continue anyway" button appears so
//     the user can bypass the gate when one backend is intentionally
//     off (dev-only, prod-only, etc.).
//   - Each tier stops polling once it returns OK, so a slow second
//     tier doesn't keep hammering the first.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface BackendGateProps {
  children: ReactNode;
}

type Status = 'pending' | 'ready' | 'error';

// Probe the given URL until it returns 2xx. AbortSignal.timeout caps
// each individual request so a hanging socket can't stall the loop.
async function probeUntilReady(
  url: string,
  cancelledRef: { current: boolean },
  onStatus: (s: Status) => void,
): Promise<void> {
  let attempts = 0;
  while (!cancelledRef.current) {
    attempts += 1;
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(2000),
        cache: 'no-store',
      });
      if (r.ok) {
        if (!cancelledRef.current) onStatus('ready');
        return;
      }
      // Non-2xx: keep retrying (Hono responds 200 with [] when it has
      // no projects yet, so a 4xx/5xx really is "not ready").
    } catch {
      // Network / timeout / abort — backend not up yet. Mark error
      // (turns the row red so the user knows something's pending),
      // then keep polling.
      if (!cancelledRef.current && attempts > 1) onStatus('error');
    }
    // Linear backoff: first tries are tight, later tries spaced out.
    const delay = Math.min(2000, 200 + attempts * 100);
    await new Promise((r) => setTimeout(r, delay));
  }
}

export function BackendGate({ children }: BackendGateProps) {
  const [pythonStatus, setPythonStatus] = useState<Status>('pending');
  const [honoStatus, setHonoStatus] = useState<Status>('pending');
  const [allowSkip, setAllowSkip] = useState(false);
  const [skipped, setSkipped] = useState(false);

  // Held in a ref so the cleanup function can flip it without
  // re-creating the closures inside probeUntilReady.
  const cancelledRef = useRef({ current: false });

  useEffect(() => {
    cancelledRef.current = { current: false };
    void probeUntilReady('/api/health', cancelledRef.current, setPythonStatus);
    void probeUntilReady(
      '/api/projects',
      cancelledRef.current,
      setHonoStatus,
    );
    // After 8 s, expose the bypass — by then a healthy boot would
    // be done; if we're still waiting, the user probably wants out.
    const skipTimer = window.setTimeout(() => setAllowSkip(true), 8000);
    return () => {
      cancelledRef.current.current = true;
      window.clearTimeout(skipTimer);
    };
  }, []);

  const bothReady = pythonStatus === 'ready' && honoStatus === 'ready';
  if (bothReady || skipped) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-window-bg flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-card-bg border border-card-border rounded-xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-3xl">📊</span>
          <div>
            <h1 className="text-lg font-bold text-text-primary">
              AinOne Dashboard
            </h1>
            <p className="text-xs text-text-muted">
              Waiting for backends to come online…
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <StatusRow
            label="Sensor backend (FastAPI)"
            port={8080}
            status={pythonStatus}
          />
          <StatusRow
            label="Claude backend (Hono)"
            port={3000}
            status={honoStatus}
          />
        </div>

        <p className="mt-4 text-[11px] text-text-muted leading-relaxed">
          First launch may take ~30 s while <code>pip install</code> and{' '}
          <code>npm install</code> finish. Subsequent launches start
          instantly.
        </p>

        {allowSkip && (
          <button
            type="button"
            onClick={() => setSkipped(true)}
            className="mt-4 w-full text-xs text-text-secondary hover:text-text-primary px-3 py-1.5 rounded border border-card-border hover:border-card-border/80 transition-colors"
          >
            Continue anyway
          </button>
        )}
      </div>
    </div>
  );
}

function StatusRow({
  label,
  port,
  status,
}: {
  label: string;
  port: number;
  status: Status;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-window-bg border border-card-border/60">
      <div className="flex items-center gap-2 min-w-0">
        <StatusIcon status={status} />
        <span className="text-sm text-text-primary truncate">{label}</span>
      </div>
      <span className="text-xs text-text-muted font-mono shrink-0">
        :{port}
      </span>
    </div>
  );
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'ready') {
    return <span className="text-status-connected text-base">✓</span>;
  }
  if (status === 'error') {
    return <span className="text-status-disconnected text-base">⏳</span>;
  }
  return (
    <span className="inline-block w-3 h-3 border-2 border-text-muted border-t-blue-500 rounded-full animate-spin" />
  );
}
