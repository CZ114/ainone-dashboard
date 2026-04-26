/**
 * Runtime-agnostic Hono application
 *
 * This module creates the Hono application with all routes and middleware,
 * but doesn't include runtime-specific code like CLI parsing or server startup.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Runtime } from "./runtime/types.ts";
import {
  type ConfigContext,
  createConfigMiddleware,
} from "./middleware/config.ts";
import { handleProjectsRequest } from "./handlers/projects.ts";
import { handleHistoriesRequest } from "./handlers/histories.ts";
import { handleConversationRequest } from "./handlers/conversations.ts";
import { handleChatRequest } from "./handlers/chat.ts";
import { handlePermissionResponse } from "./handlers/permission.ts";
import { handleAbortRequest } from "./handlers/abort.ts";
import {
  handleSessionList,
  handleDeleteSession,
  handleSessionMessages,
  handleCreateProject,
  handleDeleteProject,
  handlePickFolder,
  handlePickFile,
  handleListSlashCommands,
  handleExpandSlashCommand,
} from "./handlers/sessions.ts";

export interface AppConfig {
  debugMode: boolean;
  staticPath: string;
  cliPath: string; // Actual CLI script path detected by validateClaudeCli
}

export function createApp(
  runtime: Runtime,
  config: AppConfig,
): Hono<ConfigContext> {
  const app = new Hono<ConfigContext>();

  // Store AbortControllers for each request (shared with chat handler)
  const requestAbortControllers = new Map<string, AbortController>();

  // CORS middleware
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  // Configuration middleware - makes app settings available to all handlers
  app.use(
    "*",
    createConfigMiddleware({
      debugMode: config.debugMode,
      runtime,
      cliPath: config.cliPath,
    }),
  );

  // API routes
  app.get("/api/projects", (c) => handleProjectsRequest(c));

  app.get("/api/projects/:encodedProjectName/histories", (c) =>
    handleHistoriesRequest(c),
  );

  app.get("/api/projects/:encodedProjectName/histories/:sessionId", (c) =>
    handleConversationRequest(c),
  );

  app.post("/api/abort/:requestId", (c) =>
    handleAbortRequest(c, requestAbortControllers),
  );

  app.post("/api/chat", (c) => handleChatRequest(c, requestAbortControllers));
  app.post("/api/chat/permission", (c) => handlePermissionResponse(c));

  app.get("/api/sessions", (c) => handleSessionList(c));
  app.get("/api/sessions/:sessionId/messages", (c) => handleSessionMessages(c));
  app.delete("/api/sessions/:sessionId", (c) => handleDeleteSession(c));

  app.post("/api/projects/create", (c) => handleCreateProject(c));
  app.delete("/api/projects", (c) => handleDeleteProject(c));
  app.post("/api/system/pick-folder", (c) => handlePickFolder(c));
  app.post("/api/system/pick-file", (c) => handlePickFile(c));
  // Terminal launch is now an embedded xterm.js + PTY via WebSocket,
  // not a REST endpoint. See handlers/shell.ts and the /ws/shell
  // upgrade attached in cli/node.ts.

  app.get("/api/slash-commands", (c) => handleListSlashCommands(c));
  app.post("/api/slash-commands/expand", (c) => handleExpandSlashCommand(c));

  // Static file serving with SPA fallback (only if staticPath is provided)
  // Note: We don't check if path exists since createApp is sync
  if (config.staticPath) {
    // Serve static assets (CSS, JS, images, etc.)
    const serveStatic = runtime.createStaticFileMiddleware({
      root: config.staticPath,
    });
    app.use("/assets/*", serveStatic);

    // SPA fallback - serve index.html for all unmatched routes (except API routes)
    app.get("*", async (c) => {
      const path = c.req.path;

      // Skip API routes
      if (path.startsWith("/api/")) {
        return c.text("Not found", 404);
      }

      try {
        const indexPath = `${config.staticPath}/index.html`;
        const { readFileSync } = await import("node:fs");
        const indexFile = readFileSync(indexPath);
        return c.html(new TextDecoder().decode(indexFile));
      } catch {
        return c.text("Not found", 404);
      }
    });
  } else {
    // No static files configured - just return a message for non-API routes
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.text("Not found", 404);
      }
      return c.text("Claude API Backend - API endpoints: /api/chat, /api/projects, /api/abort/:requestId", 200);
    });
  }

  return app;
}
