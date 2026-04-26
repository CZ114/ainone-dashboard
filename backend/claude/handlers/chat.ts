import { Context } from "hono";
import {
  query,
  type PermissionMode,
  type EffortLevel,
  type ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChatRequest, StreamResponse } from "../../shared/types.ts";
import { logger } from "../utils/logger.ts";
import { getHomeDir, getEnv } from "../utils/os.ts";
import { readTextFile } from "../utils/fs.ts";
import path from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";

/**
 * Find an absolute path to the `claude` binary. The agent SDK spawns it
 * via child_process.spawn without shell, so on Windows a bare "claude"
 * string fails (spawn doesn't auto-append .exe). We probe Anthropic's
 * standard install locations and return the first hit.
 *
 * Unicode safety: paths are built from `os.homedir()` which Node gets
 * through the Win32 W-API and preserves non-ASCII chars (e.g. Chinese
 * usernames) correctly. This avoids the mojibake the legacy
 * `validateClaudeCli` tracing path introduces when it captures child
 * process stderr on Windows.
 */
export function resolveClaudeBinary(): string {
  const overridden = process.env.CLAUDE_CLI_PATH;
  if (overridden && existsSync(overridden)) return overridden;

  const home = os.homedir();
  const isWindows = process.platform === "win32";
  const candidates = isWindows
    ? [
        path.join(home, ".local", "bin", "claude.exe"),
        path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
        path.join(home, "AppData", "Local", "Programs", "claude-code", "claude.exe"),
      ]
    : [
        path.join(home, ".local", "bin", "claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
      ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Last-ditch fallback. Will likely fail on Windows but at least produces
  // a clear error message pointing at pathToClaudeCodeExecutable.
  return isWindows ? "claude.exe" : "claude";
}

interface UserSettings {
  env?: Record<string, unknown>;
}

// Mirror the Claude CLI's own env-loading behaviour: read every string value
// from ~/.claude/settings.json's `env` block so the backend adapts whenever
// the user retargets their CLI (different model, base URL, extra vars, etc.)
// instead of forcing a fixed set of keys.
async function getUserEnvFromSettings(): Promise<Record<string, string>> {
  const homeDir = getHomeDir();
  if (!homeDir) return {};

  const settingsPath = `${homeDir}/.claude/settings.json`;
  try {
    const content = await readTextFile(settingsPath);
    const settings: UserSettings = JSON.parse(content);
    const result: Record<string, string> = {};

    if (settings.env && typeof settings.env === "object") {
      for (const [key, value] of Object.entries(settings.env)) {
        if (typeof value === "string" && value.length > 0) {
          result[key] = value;
        }
      }
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Get the Claude projects directory path
 */
function getClaudeProjectsDir(): string {
  const homeDir = getHomeDir();
  if (!homeDir) {
    throw new Error("Could not determine home directory");
  }
  return path.join(homeDir, ".claude", "projects");
}

/**
 * Read cwd from session file when not in registry
 * This handles the case where a historical session is loaded but not yet registered
 */
async function getSessionCwdFromFile(sessionId: string): Promise<string | null> {
  const projectsDir = getClaudeProjectsDir();

  try {
    // Scan all project directories for the session file
    const { readDir } = await import("../utils/fs.ts");
    const entries: Array<{ name: string; isDirectory: boolean }> = [];
    for await (const entry of readDir(projectsDir)) {
      entries.push(entry);
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;

      const sessionFile = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
      try {
        const content = await readTextFile(sessionFile);
        const lines = content.trim().split("\n").filter(l => l.trim());

        // Find the first entry with cwd
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.cwd) {
              return parsed.cwd;
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Session file doesn't exist in this project, continue
      }
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * Session registry: maps sessionId -> cwd used when session was created
 * CRITICAL: This ensures we always use the correct cwd when resuming a session
 */
const sessionRegistry: Map<string, string> = new Map();

// Lock to prevent concurrent Claude command executions
let commandLock: { released: boolean } | null = null;

function acquireLock(): { released: boolean } {
  const lock = { released: false };
  commandLock = lock;
  return lock;
}

function releaseLock(lock: { released: boolean }) {
  if (commandLock === lock) {
    lock.released = true;
    commandLock = null;
  }
}

/**
 * Resolve session path and cwd for a session.
 * Priority:
 * 1. For real sessionIds (not temp): Always get cwd from session file (contains CORRECT cwd)
 * 2. For temporary sessions (new-session-*): Use sessionRegistry if available
 * 3. Fallback to workingDirectory or process.cwd()
 */
async function resolveSessionPath(
  sessionId?: string,
  workingDirectory?: string,
): Promise<{ sessionPath: string; cwd: string }> {
  const projectsDir = getClaudeProjectsDir();

  // For real session IDs: ALWAYS try to get cwd from the session file first
  // This is because the session file contains the CORRECT cwd used by the CLI
  if (sessionId && !sessionId.startsWith("new-session-")) {
    const sessionCwd = await getSessionCwdFromFile(sessionId);
    if (sessionCwd) {
      const encodedName = sessionCwd
        .replace(/[/\\:._]/g, "-")
        .replace(/^([A-Za-z]):/, "$1--");
      const sessionPath = path.join(projectsDir, encodedName);
      // Update registry with correct cwd
      sessionRegistry.set(sessionId, sessionCwd);
      return { sessionPath, cwd: sessionCwd };
    }
  }

  // For temporary sessions or if not found in file: Check sessionRegistry
  if (sessionId && sessionRegistry.has(sessionId)) {
    const storedCwd = sessionRegistry.get(sessionId)!;
    const encodedName = storedCwd
      .replace(/[/\\:._]/g, "-")
      .replace(/^([A-Za-z]):/, "$1--");
    const sessionPath = path.join(projectsDir, encodedName);
    return { sessionPath, cwd: storedCwd };
  }

  // Fallback: Use workingDirectory if provided, otherwise use process.cwd()
  const cwd = workingDirectory || process.cwd();
  const encodedName = cwd
    .replace(/[/\\:._]/g, "-")
    .replace(/^([A-Za-z]):/, "$1--");
  const sessionPath = path.join(projectsDir, encodedName);

  return { sessionPath, cwd };
}

/**
 * Check if a session ID is a temporary one (created by frontend for new sessions)
 */
function isTemporarySession(sessionId: string | undefined | null): boolean {
  return Boolean(sessionId && sessionId.startsWith("new-session-"));
}

/**
 * Executes a Claude command using the SDK programmatic API.
 */
async function* executeClaudeCommand(
  message: string,
  requestId: string,
  requestAbortControllers: Map<string, AbortController>,
  cliPath: string,
  sessionId?: string,
  allowedTools?: string[],
  workingDirectory?: string,
  permissionMode?: PermissionMode,
  effort?: EffortLevel,
  thinking?: ThinkingConfig,
): AsyncGenerator<StreamResponse> {
  // Acquire lock - reject if another command is running
  const lock = acquireLock();
  if (commandLock !== lock) {
    yield {
      type: "error",
      error: "Another request is still in progress. Please wait and try again.",
    };
    return;
  }

  let abortController: AbortController;

  try {
    // IMPORTANT — do NOT strip leading `/` from the prompt.
    //
    // Earlier code did `message = message.substring(1)` for anything
    // starting with `/`, turning `/compact` into the literal text
    // "compact" and sending it to Claude as a normal message. That
    // disabled every real CLI slash command (/compact, /init, /clear,
    // /context, etc).
    //
    // The CLI binary recognizes slash-prefixed prompts as local slash
    // commands even in non-interactive mode (see
    // `SDKLocalCommandOutputMessage` in the SDK type defs). The SDK
    // just forwards stdin; passing the raw prompt through lets
    // /compact actually compact the session and any user-installed
    // command run at the CLI layer.
    const processedMessage = message;

    // Create and store AbortController for this request
    abortController = new AbortController();
    requestAbortControllers.set(requestId, abortController);

    // Load user env from settings.json (includes ANTHROPIC_AUTH_TOKEN, etc.)
    const userEnv = await getUserEnvFromSettings();

    // Resolve the correct session path and working directory
    const { sessionPath, cwd } = await resolveSessionPath(sessionId, workingDirectory);

    // Sanity-check the cwd exists as a directory BEFORE spawning. Without
    // this, an invalid cwd (e.g. user typed "test" in the New Project
    // prompt) causes child_process.spawn to fail with ENOENT, which the
    // agent SDK then surfaces as the deeply misleading error "Claude Code
    // native binary not found at <path>". By failing early here we give
    // the user a message that actually points at the real problem.
    try {
      const { statSync } = await import("node:fs");
      const stat = statSync(cwd);
      if (!stat.isDirectory()) {
        yield {
          type: "error",
          error: `Working directory is not a directory: ${cwd}`,
        };
        return;
      }
    } catch {
      yield {
        type: "error",
        error:
          `Working directory does not exist: "${cwd}". ` +
          `Create the folder first, or enter a valid absolute path when registering the project.`,
      };
      return;
    }

    // MCP server configuration
    //
    // The MiniMax MCP server is opt-in: set MINIMAX_API_KEY in your
    // environment (or in `~/.claude/settings.json`) to enable it. Without
    // a key, no MCP servers are registered for the chat session.
    const mcpServers: Record<string, {
      command: string;
      args: string[];
      env: Record<string, string>;
    }> = {};
    const minimaxApiKey = getEnv("MINIMAX_API_KEY");
    if (minimaxApiKey) {
      mcpServers.MiniMax = {
        command: "uvx",
        args: ["minimax-coding-plan-mcp", "-y"],
        env: {
          MINIMAX_API_HOST: getEnv("MINIMAX_API_HOST") || "https://api.minimaxi.com",
          MINIMAX_API_KEY: minimaxApiKey,
        },
      };
    }

    // Build query options
    //
    // NOTE on SDK migration (@anthropic-ai/claude-code → claude-agent-sdk):
    // The agent SDK made several previously-implicit behaviors opt-in. The
    // three preset options below restore the pre-migration behavior:
    //   - `systemPrompt: preset 'claude_code'` is REQUIRED for CLAUDE.md
    //     files to load; without it the agent starts with a bare prompt.
    //   - `settingSources: ['project', 'user', 'local']` lets the agent
    //     read ~/.claude/settings.json (env, permissions, etc) the same
    //     way the interactive CLI does.
    //   - `tools: preset 'claude_code'` enables the default Claude Code
    //     tool set (Read/Write/Bash/etc). Omitting it leaves all tools
    //     available, which is effectively the same default, but being
    //     explicit keeps forward compat clear.
    // The agent SDK also changed `--resume` semantics from fork-per-turn
    // to in-place append, which is the whole reason we upgraded.
    // CLI path resolution (post SDK 0.2.x migration):
    // - The new SDK ships no cli.js; the CLI is a prebuilt native binary
    //   (`claude.exe` on Windows, shipped via Anthropic's installer).
    // - The SDK spawns it via child_process.spawn WITHOUT shell, so a
    //   bare "claude" string fails on Windows (no PATH auto-resolution,
    //   no .exe auto-append). We need an absolute path.
    // - `resolveClaudeBinary()` probes the standard install locations
    //   using Unicode-safe `os.homedir()`, side-stepping the mojibake
    //   that the legacy `validateClaudeCli` tracing path introduces on
    //   Chinese-username Windows machines.
    // - `validateClaudeCli`'s `cliPath` is legacy from the old SDK era
    //   when cli.js location mattered; intentionally ignored now.
    void cliPath; // retained in signature for compat; no longer used
    const resolvedCliPath = resolveClaudeBinary();

    console.log("[chat] spawn diag:", {
      resolvedCliPath,
      cliExists: existsSync(resolvedCliPath),
      cwd,
      sessionIdInput: sessionId,
      isResume: Boolean(sessionId && !isTemporarySession(sessionId)),
      userEnvKeys: Object.keys(userEnv),
      permissionMode,
      effort,
      thinking,
    });

    const queryOptions: { prompt: string; options: Record<string, unknown> } = {
      prompt: processedMessage,
      options: {
        abortController,
        pathToClaudeCodeExecutable: resolvedCliPath,
        mcpServers,
        tools: { type: "preset" as const, preset: "claude_code" as const },
        systemPrompt: { type: "preset" as const, preset: "claude_code" as const },
        settingSources: ["project", "user", "local"] as Array<"project" | "user" | "local">,
        stderr: (chunk: string) => {
          // Surface whatever the child CLI writes — usually the real
          // failure reason when the SDK's post-exit error message is
          // vague ("native binary not found at X" even when X exists).
          console.log("[claude-cli stderr]", chunk.trimEnd());
        },
        env: {
          ...process.env,
          ...userEnv,
        },
        // For real sessions (not temporary), pass resume with sessionId
        // For temporary sessions, don't pass resume (let CLI create new session)
        ...(sessionId && !isTemporarySession(sessionId) ? { resume: sessionId } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        cwd: cwd,
        ...(permissionMode ? { permissionMode } : {}),
        // Only include effort/thinking when explicitly set — omitting
        // them lets the SDK/model apply its own defaults (adaptive
        // thinking on Opus 4.6+, sensible effort per model).
        ...(effort ? { effort } : {}),
        ...(thinking ? { thinking } : {}),
      },
    };

    // Ground-truth log: EXACTLY which keys are reaching the SDK. If
    // effort/thinking/permissionMode aren't here, they were never set
    // — diff against `[chat] request body` above to see which leg
    // of the pipeline dropped them.
    console.log("[chat] query options keys:", Object.keys(queryOptions.options).sort());
    if (queryOptions.options.permissionMode) {
      console.log("[chat] → permissionMode:", queryOptions.options.permissionMode);
    }
    if (queryOptions.options.effort) {
      console.log("[chat] → effort:", queryOptions.options.effort);
    }
    if (queryOptions.options.thinking) {
      console.log("[chat] → thinking:", JSON.stringify(queryOptions.options.thinking));
    }

    for await (const sdkMessage of query(queryOptions)) {
      // When a new session is created (system/init), store its session_id -> cwd mapping
      // This ensures future resume calls use the correct cwd
      if (
        sdkMessage.type === "system" &&
        (sdkMessage as { subtype?: string }).subtype === "init" &&
        (sdkMessage as { session_id?: string }).session_id
      ) {
        const incomingSessionId = (sdkMessage as { session_id: string }).session_id;
        // Only register if we don't already have this session (avoid overwriting on resume)
        if (!sessionRegistry.has(incomingSessionId)) {
          sessionRegistry.set(incomingSessionId, cwd);
        }
      }

      yield {
        type: "claude_json",
        data: sdkMessage,
      };
    }

    yield { type: "done" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      yield { type: "error", error: "Request aborted" };
    } else {
      logger.chat.error("Claude Code execution failed: {error}", { error });
      yield {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    if (requestAbortControllers.has(requestId)) {
      requestAbortControllers.delete(requestId);
    }
    releaseLock(lock);
  }
}

/**
 * Handles POST /api/chat requests with streaming responses
 */
export async function handleChatRequest(
  c: Context,
  requestAbortControllers: Map<string, AbortController>,
) {
  const chatRequest: ChatRequest = await c.req.json();
  const { cliPath } = c.var.config;

  // Full-fidelity request-body log so we can tell, at a glance, which
  // optional fields the frontend actually sent. Helpful when the user
  // reports "my mode/effort/thinking aren't taking effect" — shows
  // whether the bug is frontend (field missing from wire payload) or
  // backend (field arrives but isn't forwarded to SDK).
  console.log("[chat] request body:", {
    requestId: chatRequest.requestId,
    sessionId: chatRequest.sessionId,
    hasMessage: typeof chatRequest.message === "string",
    messageLen: chatRequest.message?.length ?? 0,
    workingDirectory: chatRequest.workingDirectory,
    permissionMode: chatRequest.permissionMode,
    effort: chatRequest.effort,
    thinking: chatRequest.thinking,
    allowedTools: chatRequest.allowedTools?.length ?? 0,
  });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of executeClaudeCommand(
          chatRequest.message,
          chatRequest.requestId,
          requestAbortControllers,
          cliPath,
          chatRequest.sessionId,
          chatRequest.allowedTools,
          chatRequest.workingDirectory,
          chatRequest.permissionMode,
          chatRequest.effort,
          chatRequest.thinking,
        )) {
          const data = JSON.stringify(chunk) + "\n";
          controller.enqueue(new TextEncoder().encode(data));
        }
        controller.close();
      } catch (error) {
        const errorResponse: StreamResponse = {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        };
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(errorResponse) + "\n"),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
