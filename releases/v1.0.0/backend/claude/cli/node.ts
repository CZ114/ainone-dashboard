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
import type { Server } from "node:http";


async function main(runtime: NodeRuntime) {
  // Parse CLI arguments
  const args = parseCliArgs();

  // Initialize logging system
  await setupLogger(args.debug);

  if (args.debug) {
    logger.cli.info("🐛 Debug mode enabled");
  }

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
