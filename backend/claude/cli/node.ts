#!/usr/bin/env node
/**
 * Node.js-specific entry point
 *
 * This module handles Node.js-specific initialization including CLI argument parsing,
 * Claude CLI validation, and server startup using the NodeRuntime.
 */

import { createApp } from "../app.ts";
import { NodeRuntime } from "../runtime/node.ts";
import { parseCliArgs } from "./args.ts";
import { validateClaudeCli } from "./validation.ts";
import { setupLogger, logger } from "../utils/logger.ts";
import { exit } from "../utils/os.ts";
import { attachShellWebSocket } from "../handlers/shell.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";

/**
 * Try to load `.env` files into process.env so users can keep API keys
 * out of `backend/data/diary/agents.json`. Diary's secret resolver
 * falls back to `process.env[NAME]` when a `${NAME}` reference isn't
 * in the agents.json `secrets` block, so anything loaded here becomes
 * available to agents that reference it.
 *
 * Search order (first hit wins):
 *   1. <repo>/.env              (most common — top-level project file)
 *   2. <repo>/backend/.env      (when a user keeps backend env separate)
 *   3. <repo>/backend/claude/.env (per-Hono-process override)
 *
 * `process.loadEnvFile` is Node-native (no `dotenv` dep) since 20.6.
 * On older Node we silently skip — diary still works, users just need
 * to set env vars by other means or paste keys via the UI.
 */
function loadEnvFiles(): void {
  if (typeof process.loadEnvFile !== "function") return;
  const __filename = fileURLToPath(import.meta.url);
  // <repo>/backend/claude/cli/node.ts -> repo root is ../../../
  const repoRoot = path.resolve(__filename, "..", "..", "..", "..");
  const candidates = [
    path.join(repoRoot, ".env"),
    path.join(repoRoot, "backend", ".env"),
    path.join(repoRoot, "backend", "claude", ".env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      logger.cli.info(`🔐 Loaded env from ${file}`);
      return; // first match wins
    } catch (err) {
      logger.cli.warn(
        `⚠ failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function main(runtime: NodeRuntime) {
  // Parse CLI arguments
  const args = parseCliArgs();

  // Initialize logging system
  await setupLogger(args.debug);

  if (args.debug) {
    logger.cli.info("🐛 Debug mode enabled");
  }

  // Load .env BEFORE app creation so any module that reads process.env
  // at import-time sees the values.
  loadEnvFiles();

  // Validate Claude CLI availability and get the detected CLI path
  const cliPath = await validateClaudeCli(runtime, args.claudePath);

  // Create application - staticPath is empty since we use Vite frontend
  const app = createApp(runtime, {
    debugMode: args.debug,
    staticPath: "", // No static files - frontend is served by Vite on port 5173
    cliPath,
  });

  // Start server (only show this message when everything is ready)
  logger.cli.info(`🚀 Server starting on ${args.host}:${args.port}`);
  const server = runtime.serve(args.port, args.host, app.fetch) as Server;

  // Attach the embedded-terminal WebSocket endpoint (/ws/shell). Only
  // the Node runtime supports this today; the cast from `unknown` is
  // deliberate and asserted once at this boundary.
  attachShellWebSocket(server);
}

// Run the application
const runtime = new NodeRuntime();
main(runtime).catch((error) => {
  // Logger may not be initialized yet, so use console.error
  console.error("Failed to start server:", error);
  exit(1);
});
