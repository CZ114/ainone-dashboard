import { Context } from "hono";
import {
  query,
  type PermissionMode,
  type EffortLevel,
  type ThinkingConfig,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  StreamResponse,
  PermissionDecisionWire,
  PermissionRequestPayload,
  PermissionSuggestion,
} from "../../shared/types.ts";
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
export async function getUserEnvFromSettings(): Promise<Record<string, string>> {
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

/**
 * Pending permission requests awaiting a user decision.
 *
 * Lifecycle:
 *   - canUseTool callback creates a permission_id, registers a resolver
 *     here, pushes a `permission_request` chunk to the chat stream, and
 *     awaits the resolver.
 *   - POST /api/chat/permission resolves the matching entry with the
 *     user's PermissionResult.
 *   - Request abort resolves any orphans with a deny so the SDK doesn't
 *     hang forever.
 */
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  // requestId of the chat call this permission belongs to — used so
  // aborts only deny their own pending requests, not other concurrent
  // chats. (Today we lock to one at a time, but cleanup is cheap.)
  requestId: string;
  // The tool's original input. Carried alongside the resolver because
  // the SDK's PermissionResult Zod schema requires `updatedInput` to be
  // present (as a record) on every `allow` reply — even when the user
  // didn't change anything. We default updatedInput to this on allow.
  originalInput: Record<string, unknown>;
}
const pendingPermissions = new Map<string, PendingPermission>();

/**
 * Resolve a pending tool-permission request with the user's wire-level
 * decision. Returns false when the id is unknown or already resolved.
 *
 * Lives here (not in permission.ts) because we need access to the
 * stored `originalInput` to satisfy the SDK schema for `allow`.
 */
export function resolvePendingPermission(
  id: string,
  decision: PermissionDecisionWire,
): boolean {
  const entry = pendingPermissions.get(id);
  if (!entry) return false;
  pendingPermissions.delete(id);

  if (decision.behavior === "allow") {
    // SDK Zod requires updatedInput to be a record on `allow` even
    // when unchanged. Default to the original tool input.
    const updatedPermissions = decision.acceptedSuggestions
      ?.map((s) => s.raw)
      .filter((raw): raw is PermissionUpdate => Boolean(raw));
    entry.resolve({
      behavior: "allow",
      updatedInput: decision.updatedInput ?? entry.originalInput,
      ...(updatedPermissions && updatedPermissions.length > 0
        ? { updatedPermissions }
        : {}),
    });
  } else {
    entry.resolve({
      behavior: "deny",
      message: decision.message || "Denied by user.",
    });
  }
  return true;
}

function abortPendingPermissionsForRequest(requestId: string) {
  for (const [id, entry] of pendingPermissions.entries()) {
    if (entry.requestId !== requestId) continue;
    pendingPermissions.delete(id);
    entry.resolve({
      behavior: "deny",
      message: "Request aborted before permission decision.",
    });
  }
}

/**
 * Convert SDK PermissionUpdate suggestions to a wire-friendly summary.
 * The `raw` field round-trips so the frontend can hand the original
 * blob back unmodified when the user picks "Allow always".
 */
function suggestionsToWire(
  suggestions: PermissionUpdate[] | undefined,
): PermissionSuggestion[] | undefined {
  if (!suggestions || suggestions.length === 0) return undefined;
  return suggestions.map((s) => {
    const wire: PermissionSuggestion = { type: s.type, raw: s };
    if ("behavior" in s && typeof s.behavior === "string") {
      wire.behavior = s.behavior;
    }
    if ("destination" in s && typeof s.destination === "string") {
      wire.destination = s.destination;
    }
    return wire;
  });
}

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
  // DEAD CODE — see docs/specs/diary.md "Dead code / debt".
  additionalSystemPrompt?: string,
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
    const mcpServers = {
      MiniMax: {
        command: "uvx",
        args: ["minimax-coding-plan-mcp", "-y"],
        env: {
          MINIMAX_API_HOST: getEnv("MINIMAX_API_HOST") || "https://api.minimaxi.com",
          MINIMAX_API_KEY: getEnv("MINIMAX_API_KEY") || "",
        },
      },
    };

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
        // DEAD CODE — see docs/specs/diary.md "Dead code / debt".
        // The SDK's `claude_code` preset apparently doesn't surface
        // appendSystemPrompt to the model, so no live caller sets
        // additionalSystemPrompt. Kept so Phase 3 can probe a working
        // path (e.g. via a different preset) without rebuilding wire.
        ...(additionalSystemPrompt ? { appendSystemPrompt: additionalSystemPrompt } : {}),
      },
    };

    // --- Manual async queue ------------------------------------------
    // The SDK loop and the canUseTool callback both produce stream
    // chunks, but the latter runs *inside* the for-await iteration —
    // it can't `yield` directly. We run the SDK loop in the background
    // and have both producers `push()` into a queue that the outer
    // generator drains.
    const queue: StreamResponse[] = [];
    let waker: (() => void) | null = null;
    let producerDone = false;
    let producerError: unknown = null;

    const wake = () => {
      const w = waker;
      waker = null;
      if (w) w();
    };
    const push = (chunk: StreamResponse) => {
      queue.push(chunk);
      wake();
    };

    // canUseTool: pause the SDK on every tool call, surface a
    // permission_request chunk on the stream, await the user's reply
    // posted via /api/chat/permission. If the request is aborted while
    // a decision is pending we resolve with a synthetic deny so the
    // SDK can unwind cleanly instead of hanging.
    const canUseTool: CanUseTool = (toolName, input, opts) => {
      return new Promise<PermissionResult>((resolve) => {
        const id = randomUUID();
        pendingPermissions.set(id, {
          resolve,
          requestId,
          originalInput: input,
        });

        const payload: PermissionRequestPayload = {
          id,
          toolName,
          input,
          toolUseId: opts.toolUseID,
          title: opts.title,
          displayName: opts.displayName,
          description: opts.description,
          decisionReason: opts.decisionReason,
          blockedPath: opts.blockedPath,
          suggestions: suggestionsToWire(opts.suggestions),
        };
        push({ type: "permission_request", permission: payload });

        const onAbort = () => {
          if (pendingPermissions.delete(id)) {
            resolve({
              behavior: "deny",
              message: "Request aborted before permission decision.",
            });
          }
        };
        if (opts.signal.aborted) {
          onAbort();
        } else {
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    };

    queryOptions.options.canUseTool = canUseTool;
    // canUseTool only fires under the SDK's prompting modes (`default`
    // and `plan`). `acceptEdits`/`bypassPermissions` skip the prompt
    // path; `auto` runs its own classifier. We leave canUseTool wired
    // in either way — it simply never gets called for the silent modes.
    void permissionMode;

    // Ground-truth log: EXACTLY which keys are reaching the SDK.
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

    // Background SDK loop.
    const sdkLoop = (async () => {
      try {
        for await (const sdkMessage of query(queryOptions)) {
          // Register session_id -> cwd on first system/init so future
          // --resume calls find the right working directory.
          if (
            sdkMessage.type === "system" &&
            (sdkMessage as { subtype?: string }).subtype === "init" &&
            (sdkMessage as { session_id?: string }).session_id
          ) {
            const incomingSessionId = (sdkMessage as { session_id: string }).session_id;
            if (!sessionRegistry.has(incomingSessionId)) {
              sessionRegistry.set(incomingSessionId, cwd);
            }
          }
          push({ type: "claude_json", data: sdkMessage });
        }
      } catch (err) {
        producerError = err;
      } finally {
        producerDone = true;
        // Any permission requests still outstanding now would block
        // forever; release them as denies.
        abortPendingPermissionsForRequest(requestId);
        wake();
      }
    })();

    // Drain.
    while (!producerDone || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((r) => {
        waker = r;
      });
    }
    await sdkLoop; // surface any unhandled rejection

    if (producerError) throw producerError;

    yield { type: "done" };
  } catch (error) {
    abortPendingPermissionsForRequest(requestId);
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
    abortPendingPermissionsForRequest(requestId);
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
    // DEAD CODE — see docs/specs/diary.md "Dead code / debt".
    hasAdditionalSystemPrompt: typeof chatRequest.additionalSystemPrompt === "string",
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
          chatRequest.additionalSystemPrompt,
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
