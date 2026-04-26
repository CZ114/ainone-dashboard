// Embedded terminal WebSocket handler.
//
// Clients connect to ws://host:3000/ws/shell, send a JSON "init"
// message with { cwd, cols, rows }, and from then on exchange a
// bidirectional byte stream with a real PTY running the user's
// default shell + the Claude CLI.
//
// Wire protocol (JSON text frames):
//
//   Client → Server:
//     { type: "init",   cwd: string, cols: number, rows: number }
//     { type: "input",  data: string }                            // keystrokes
//     { type: "resize", cols: number, rows: number }              // terminal resize
//
//   Server → Client:
//     { type: "ready" }                                           // PTY spawned
//     { type: "output", data: string }                            // stdout/stderr
//     { type: "exit",   code: number }                            // PTY exited
//     { type: "error",  message: string }                         // fatal
//
// Design choices for this embedded terminal:
//   - No auth token (this server is local-only, 127.0.0.1).
//   - No reconnect / output buffering. Close = kill PTY. Simpler state
//     machine; easy to add later if users want session survival.
//   - No WebGL addon on the client — Canvas is fine.
//   - One connection = one PTY. No sharing / multiplexing.

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { existsSync, statSync } from "node:fs";
import { URL } from "node:url";

interface InitMessage {
  type: "init";
  cwd: string;
  cols: number;
  rows: number;
}
interface InputMessage {
  type: "input";
  data: string;
}
interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}
type ClientMessage = InitMessage | InputMessage | ResizeMessage;

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Work out the shell to run the Claude CLI in.
 *
 * Windows: prefer PowerShell — it handles non-ASCII paths better than
 * cmd.exe and is the default interactive shell on Win10+. Fall back
 * to cmd if pwsh/powershell isn't available (uncommon).
 *
 * Unix: honor $SHELL, else /bin/bash.
 *
 * The PTY runs the shell itself; we then feed `claude` as its first
 * command via the `-Command` (Win) or `-c` (Unix) flag. That way the
 * shell's prompt / history / env are available after `claude` exits,
 * which matches native-terminal expectations.
 */
function pickShell(): { shell: string; args: string[]; initCmd: string } {
  const initCmd = "claude";
  if (process.platform === "win32") {
    return {
      shell: "powershell.exe",
      // -NoLogo to skip banner; -NoExit keeps the PowerShell session
      // alive after `claude` exits so the user can keep using it.
      args: ["-NoLogo", "-NoExit", "-Command", initCmd],
      initCmd,
    };
  }
  return {
    shell: process.env.SHELL || "/bin/bash",
    args: ["-c", `${initCmd}; exec ${process.env.SHELL || "/bin/bash"} -l`],
    initCmd,
  };
}

function handleConnection(ws: WebSocket): void {
  let pty: IPty | null = null;
  let initReceived = false;

  const cleanup = () => {
    if (pty) {
      try {
        pty.kill();
      } catch {
        /* already dead */
      }
      pty = null;
    }
  };

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(ws, { type: "error", message: "Invalid JSON frame" });
      return;
    }

    if (msg.type === "init") {
      if (initReceived) {
        send(ws, { type: "error", message: "init already received" });
        return;
      }
      initReceived = true;

      const cwd = (msg.cwd || "").trim();
      const cols = Math.max(10, Math.floor(msg.cols) || 80);
      const rows = Math.max(5, Math.floor(msg.rows) || 24);

      if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        send(ws, { type: "error", message: `Invalid cwd: ${cwd}` });
        ws.close();
        return;
      }

      const { shell, args } = pickShell();
      try {
        pty = ptySpawn(shell, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: {
            ...(process.env as Record<string, string>),
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            // Force Claude CLI to emit full colour in the PTY even
            // though our parent process's stdout isn't itself a TTY.
            FORCE_COLOR: "3",
          },
        });
      } catch (error) {
        send(ws, {
          type: "error",
          message: `Failed to spawn PTY: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        ws.close();
        return;
      }

      pty.onData((data) => {
        send(ws, { type: "output", data });
      });
      pty.onExit(({ exitCode }) => {
        send(ws, { type: "exit", code: exitCode });
        ws.close();
      });
      send(ws, { type: "ready" });
      return;
    }

    if (!pty) {
      send(ws, { type: "error", message: "PTY not initialized yet" });
      return;
    }

    if (msg.type === "input") {
      pty.write(msg.data);
    } else if (msg.type === "resize") {
      const cols = Math.max(10, Math.floor(msg.cols) || 80);
      const rows = Math.max(5, Math.floor(msg.rows) || 24);
      try {
        pty.resize(cols, rows);
      } catch (error) {
        // resize failures are non-fatal, just log
        console.warn("[shell] resize failed:", error);
      }
    }
  });

  ws.on("close", cleanup);
  ws.on("error", (err) => {
    console.warn("[shell] ws error:", err);
    cleanup();
  });
}

/**
 * Attach a WebSocket listener to the HTTP server. Only requests whose
 * path matches /ws/shell are claimed; other WS upgrades (if any) fall
 * through. Keeping this small + single-endpoint avoids pulling in a
 * WS-routing layer we don't need.
 */
export function attachShellWebSocket(server: Server): void {
  // noServer: true → we drive the upgrade handshake ourselves so
  // unrelated paths don't confuse the WSS.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const pathname = new URL(req.url || "", "http://localhost").pathname;
    if (pathname !== "/ws/shell") return; // let other handlers see it

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws);
    });
  });

  console.log("[shell] WebSocket endpoint ready at /ws/shell");
}
