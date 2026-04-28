// Embedded xterm.js terminal backed by a PTY on the backend.
//
// Architecture:
//   Frontend xterm.js  ⇄  WS /ws/shell  ⇄  node-pty process  ⇄  shell + claude
//
// The component owns three disposable resources that MUST be cleaned up
// on unmount:
//   1. the Terminal instance (xterm.js) — disposed to release canvas/WebGL
//   2. the WebSocket — closed to kill the backend PTY
//   3. a ResizeObserver on the container — unsubscribed
//
// Wire protocol lives on the backend in `handlers/shell.ts`; see there
// for the exact JSON message shapes.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useTheme } from '../../contexts/ThemeContext';

interface EmbeddedTerminalProps {
  cwd: string;
  // Called when the PTY exits (or the WS errors). Parent typically
  // uses this to close the modal / swap UI state.
  onExit?: (code: number | null) => void;
}

// 50 ms debounce — frequent resizes happen during drawer / modal
// opening animations; we don't want to hammer the PTY with resize
// calls per frame.
const RESIZE_DEBOUNCE_MS = 50;

// Build WS URL that works under Vite's dev proxy and a future direct
// deployment. `location.host` resolves correctly in both cases because
// vite.config.ts routes /ws/shell to the backend.
function buildWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/shell`;
}

// Theme palettes — chrome (background / foreground / cursor / selection)
// matches our CSS var tokens so the terminal blends with the rest of
// the warm-charcoal chrome. ANSI colors stay close to VSCode defaults
// EXCEPT green, which we pull toward sage so it doesn't spike out of
// the warm palette every time `ls --color` highlights a directory or
// a build prints "OK". xterm.js wants concrete hex values, not CSS
// vars, so each value is duplicated here per resolved theme.
const DARK_THEME = {
  background: '#181614',          // matches --color-window-bg (warm charcoal)
  foreground: '#E8E4DE',          // matches --color-text-primary (soft warm white)
  cursor: '#E8E4DE',
  cursorAccent: '#181614',
  selectionBackground: '#38332E', // warm umber, matches card-border family
  black: '#000000',
  red: '#CD3131',                 // semantic — left vivid for errors
  green: '#7E9A6B',                // sage olive (muted to fit handcraft palette)
  yellow: '#C9B05A',                // mustard-amber (was #E5E510 neon)
  blue: '#5C7FA8',                 // muted slate blue (was electric #2472C8)
  magenta: '#A86BA8',               // dusty mauve (was #BC3FBC)
  cyan: '#5A95A2',                  // muted teal (was electric #11A8CD)
  white: '#E5E5E5',
  brightBlack: '#666666',
  brightRed: '#F14C4C',
  brightGreen: '#9DBC85',          // lighter sage
  brightYellow: '#D9C275',          // lifted mustard
  brightBlue: '#7A95B8',            // soft slate blue
  brightMagenta: '#C089C0',         // soft mauve
  brightCyan: '#7AAEB8',            // soft teal
  brightWhite: '#F8FAFC',
} as const;
const LIGHT_THEME = {
  background: '#FCFAF6',          // matches card-bg (cream)
  foreground: '#28221C',          // matches text-primary (sepia near-black)
  cursor: '#28221C',
  cursorAccent: '#FCFAF6',
  selectionBackground: '#E0D4BA', // warm beige, fits parchment palette
  black: '#000000',
  red: '#CD3131',
  green: '#5A7E48',                // darker sage for light bg
  yellow: '#94780E',                // ochre (was lemon #949800)
  blue: '#3D5A7A',                  // slate blue (was electric #0451A5)
  magenta: '#8E2A8E',               // deeper mauve
  cyan: '#3D6E7A',                  // muted teal
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#CD3131',
  brightGreen: '#6B8E5A',          // medium sage
  brightYellow: '#9E8418',
  brightBlue: '#5A7A9E',            // soft slate
  brightMagenta: '#8E2A8E',
  brightCyan: '#5A8E9E',
  brightWhite: '#A5A5A5',
} as const;

type Status = 'connecting' | 'ready' | 'exited' | 'error';

export function EmbeddedTerminal({ cwd, onExit }: EmbeddedTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [status, setStatus] = useState<Status>('connecting');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const { resolvedTheme } = useTheme();

  // Apply theme on every change. Safe to call xterm.options.theme = ...
  // at any time; xterm re-renders on write.
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme =
      resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME;
  }, [resolvedTheme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // --- xterm.js setup ---------------------------------------------
    // lineHeight is intentionally 1.0. Anything above 1.0 makes xterm's
    // internal cell-pixel metrics and the FitAddon's cols/rows
    // calculation drift apart, which corrupts in-place redraws like
    // Claude Code's animated spinner / mascot — the cursor returns to
    // a column that's a fraction of a cell off, and successive frames
    // wrap onto a new line. Stick to 1.0 for spinner correctness.
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.0,
      letterSpacing: 0,
      scrollback: 10000,
      theme: resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME,
      allowProposedApi: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    term.open(container);
    try {
      fit.fit();
    } catch {
      // If container hasn't laid out yet, the first ResizeObserver hit
      // will fit() properly; no need to handle.
    }

    // --- WebSocket --------------------------------------------------
    const ws = new WebSocket(buildWsUrl());
    wsRef.current = ws;

    const safeSend = (obj: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    };

    ws.onopen = () => {
      safeSend({
        type: 'init',
        cwd,
        cols: term.cols,
        rows: term.rows,
      });
    };

    ws.onmessage = (event) => {
      let msg: { type: string; data?: string; code?: number; message?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        setStatus('ready');
      } else if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        setStatus('exited');
        setStatusMessage(`Process exited (code ${msg.code ?? '?'})`);
        term.write(`\r\n\x1b[90m[exit ${msg.code ?? '?'}]\x1b[0m\r\n`);
        onExit?.(msg.code ?? null);
      } else if (msg.type === 'error') {
        setStatus('error');
        setStatusMessage(msg.message || 'Unknown error');
        term.write(`\r\n\x1b[31m[error]\x1b[0m ${msg.message || ''}\r\n`);
      }
    };

    ws.onerror = () => {
      setStatus('error');
      setStatusMessage('WebSocket connection failed');
    };

    ws.onclose = () => {
      if (status === 'connecting' || status === 'ready') {
        setStatus('exited');
      }
    };

    // --- Input (xterm → WS) ----------------------------------------
    const inputSub = term.onData((data) => {
      safeSend({ type: 'input', data });
    });

    // --- Resize (container → fit → WS) ------------------------------
    //
    // IMPORTANT: when the terminal view is hidden (display:none because
    // the user switched to chat tab), container measures 0×0. Blindly
    // calling fit.fit() at that moment would set cols=rows=0, which
    // corrupts the terminal state and forces a full redraw on next
    // show. We guard by:
    //   1. Skipping the entire resize debounce if container is 0×0.
    //   2. Re-fitting the moment the container becomes visible again
    //      (detected by the transition from 0×0 → real size in the
    //      ResizeObserver payload).
    let resizeTimer: number | null = null;
    let lastHidden = false;
    const onResize = () => {
      const hidden =
        container.clientWidth === 0 || container.clientHeight === 0;
      if (hidden) {
        // Don't even schedule — will re-run when container paints back.
        lastHidden = true;
        return;
      }
      const comingBack = lastHidden;
      lastHidden = false;

      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(
        () => {
          try {
            fit.fit();
            safeSend({
              type: 'resize',
              cols: term.cols,
              rows: term.rows,
            });
          } catch {
            /* container removed mid-resize */
          }
        },
        // Coming back from hidden: fit immediately (no debounce) so
        // the user sees a sane-sized prompt the moment they switch
        // back, rather than a 50 ms flicker.
        comingBack ? 0 : RESIZE_DEBOUNCE_MS,
      );
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);
    // Kick a first resize after the initial paint so the PTY gets
    // the real dimensions rather than xterm's default 80x24.
    window.requestAnimationFrame(onResize);

    // Focus input on mount so typing works immediately without click.
    term.focus();

    // --- Cleanup ----------------------------------------------------
    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      ro.disconnect();
      inputSub.dispose();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // cwd is a prop — if the caller passes a new one, we want to fully
    // tear down and rebuild (fresh PTY). Status / onExit aren't deps:
    // status is read lazily in onclose, and onExit captures via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  return (
    <div className="h-full flex flex-col bg-window-bg">
      {/* Status bar — tells user what phase they're in so a
          "nothing's happening" moment doesn't look like a bug. */}
      <div className="shrink-0 px-4 py-1.5 text-xs border-b border-card-border flex items-center gap-3 bg-card-bg">
        <span
          className={`w-2 h-2 rounded-full ${
            status === 'ready'
              ? 'bg-accent-soft'              // sage (themed)
              : status === 'connecting'
              ? 'bg-status-warning animate-pulse'
              : status === 'error'
              ? 'bg-status-danger'
              : 'bg-text-muted'
          }`}
        />
        <span className="text-text-secondary font-mono">
          {status === 'connecting'
            ? 'Connecting…'
            : status === 'ready'
            ? 'Terminal ready'
            : status === 'exited'
            ? statusMessage || 'Session ended'
            : statusMessage || 'Error'}
        </span>
        <span className="text-text-muted truncate" title={cwd}>
          📁 {cwd}
        </span>
      </div>
      {/* xterm.js host — flex-1 + overflow-hidden so the canvas sizes
          exactly to the parent. FitAddon reads this container's
          measured dimensions on every resize. */}
      <div ref={containerRef} className="flex-1 overflow-hidden p-2" />
    </div>
  );
}
