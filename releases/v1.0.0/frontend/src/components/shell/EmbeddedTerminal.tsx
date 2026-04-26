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

// Theme palettes — kept close to our CSS var tokens so the terminal
// doesn't look grafted on. xterm.js wants concrete hex values, not CSS
// vars, so we have to pick a palette per resolved theme.
const DARK_THEME = {
  background: '#0F1419',
  foreground: '#F8FAFC',
  cursor: '#F8FAFC',
  cursorAccent: '#0F1419',
  selectionBackground: '#264F78',
  black: '#000000',
  red: '#CD3131',
  green: '#0DBC79',
  yellow: '#E5E510',
  blue: '#2472C8',
  magenta: '#BC3FBC',
  cyan: '#11A8CD',
  white: '#E5E5E5',
  brightBlack: '#666666',
  brightRed: '#F14C4C',
  brightGreen: '#23D18B',
  brightYellow: '#F5F543',
  brightBlue: '#3B8EEA',
  brightMagenta: '#D670D6',
  brightCyan: '#29B8DB',
  brightWhite: '#F8FAFC',
} as const;
const LIGHT_THEME = {
  background: '#FFFFFF',
  foreground: '#0F172A',
  cursor: '#0F172A',
  cursorAccent: '#FFFFFF',
  selectionBackground: '#ADD6FF',
  black: '#000000',
  red: '#CD3131',
  green: '#00BC00',
  yellow: '#949800',
  blue: '#0451A5',
  magenta: '#BC05BC',
  cyan: '#0598BC',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#CD3131',
  brightGreen: '#14CE14',
  brightYellow: '#B5BA00',
  brightBlue: '#0451A5',
  brightMagenta: '#BC05BC',
  brightCyan: '#0598BC',
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
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
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
              ? 'bg-green-400'
              : status === 'connecting'
              ? 'bg-amber-400 animate-pulse'
              : status === 'error'
              ? 'bg-red-400'
              : 'bg-gray-500'
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
