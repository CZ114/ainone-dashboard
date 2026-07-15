import { Context } from "hono";
import { getHomeDir } from "../utils/os.ts";
import { readTextFile, exists, readDir, type DirectoryEntry } from "../utils/fs.ts";
import path from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

interface SessionSummary {
  sessionId: string;
  cwd: string;
  firstMessage: string;
  lastMessage: string;
  // Claude's first substantive reply in the conversation. Used as a
  // second line in the sidebar so the user can see "topic + Claude's
  // take" at a glance rather than just their own opening line. Empty
  // string when the conversation only has user turns (rare, but
  // defensive: don't render undefined into the DOM).
  firstAssistantMessage: string;
  messageCount: number;
  updatedAt: string;
  isGrouped?: boolean;
  groupSize?: number;
  groupSessions?: string[];
}

interface RawHistoryLine {
  type: "user" | "assistant" | "system" | "result";
  message?: {
    role?: "user" | "assistant";
    content?: string | Array<{ type: string; text?: string }>;
  };
  sessionId: string;
  timestamp: string;
  uuid: string;
  parentUuid?: string | null;
  cwd?: string;
}

/**
 * Get the Claude projects directory
 */
function getClaudeProjectsDir(): string {
  // Unicode-safe; use node's os.homedir directly (always defined on
  // modern Node) instead of utils/getHomeDir which may return undefined.
  const homeDir = homedir();
  if (!homeDir) {
    throw new Error("Could not determine home directory");
  }
  return path.join(homeDir, ".claude", "projects");
}

/**
 * Extract human-readable text from a Claude message's content field.
 *
 * Claude content is a discriminated union:
 *   - string: plain user-typed text
 *   - array of blocks: each block is {type: "text"|"tool_use"|"tool_result", ...}
 *
 * Naively returning the first block-with-a-text-field loses everything
 * after a tool call. A typical Claude turn looks like:
 *
 *   [
 *     {type: "text", text: "Let me check the file…"},
 *     {type: "tool_use", name: "Read", input: {...}},
 *     {type: "text", text: "Found it. Here's the answer: …"}
 *   ]
 *
 * If we only return blocks[0].text, the actual answer is dropped and
 * the chat history looks like Claude only said one short sentence.
 *
 * This implementation:
 *   - Concatenates ALL `text` blocks (joined with newlines)
 *   - Surfaces tool_use as a `[tool: <name>]` marker so the reader
 *     knows there was a tool step (without dumping JSON params)
 *   - Recurses into tool_result.content (which is itself a list of
 *     blocks for the tool's output)
 */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.text === "string") {
      parts.push(obj.text);
    } else if (obj.type === "tool_use" && typeof obj.name === "string") {
      parts.push(`[tool: ${obj.name}]`);
    } else if (obj.type === "tool_result") {
      const inner = extractText(obj.content);
      if (inner) parts.push(inner);
    }
  }
  return parts.join("\n").trim();
}

/**
 * List all project directories in Claude's projects folder
 */
async function listProjectDirs(): Promise<string[]> {
  const projectsDir = getClaudeProjectsDir();
  try {
    const entries: DirectoryEntry[] = [];
    for await (const entry of readDir(projectsDir)) {
      entries.push(entry);
    }
    return entries
      .filter(e => e.isDirectory)
      .map(e => path.join(projectsDir, e.name));
  } catch {
    return [];
  }
}

/**
 * List all .jsonl files in a directory
 */
async function listJsonlFiles(dirPath: string): Promise<string[]> {
  try {
    const entries: DirectoryEntry[] = [];
    for await (const entry of readDir(dirPath)) {
      entries.push(entry);
    }
    return entries
      .filter(e => e.isFile && e.name.endsWith(".jsonl"))
      .map(e => path.join(dirPath, e.name));
  } catch {
    return [];
  }
}

/**
 * Parse a single JSONL file and extract session info
 */
async function parseSessionFile(
  filePath: string,
): Promise<{
  sessionId: string;
  cwd: string;
  firstUserMsgId: string | null;
  firstMessage: string;
  lastMessage: string;
  firstAssistantMessage: string;
  messageCount: number;
  updatedAt: string;
  entries: RawHistoryLine[];
} | null> {
  try {
    const content = await readTextFile(filePath);
    const lines = content.trim().split("\n").filter(l => l.trim());

    if (lines.length === 0) {
      return null;
    }

    const entries: RawHistoryLine[] = [];
    let cwd = "";
    let firstUserMsgId: string | null = null;
    let firstMessage = "";
    let lastMessage = "";
    let firstAssistantMessage = "";
    let lastTime = "";
    let messageCount = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RawHistoryLine;
        entries.push(parsed);

        // Track cwd from first entry that has it
        if (!cwd && parsed.cwd) {
          cwd = parsed.cwd;
        }

        // Track first user message's uuid (for session grouping)
        if (
          parsed.type === "user" &&
          parsed.parentUuid === null &&
          parsed.uuid &&
          firstUserMsgId === null
        ) {
          firstUserMsgId = parsed.uuid;
        }

        // Track messages
        if (parsed.type === "user" && parsed.message?.content) {
          if (!firstMessage) {
            firstMessage = extractText(parsed.message.content);
          }
          lastMessage = extractText(parsed.message.content);
          lastTime = parsed.timestamp || lastTime;
          messageCount++;
        }
        // Track Claude's first SUBSTANTIVE reply — used as a 2nd line
        // in the sidebar so the user sees both their question and
        // Claude's take without opening the session. We require the
        // extracted text to be non-empty so a tool-only first turn
        // doesn't lock in `[tool: Read]` as the summary.
        if (
          !firstAssistantMessage &&
          parsed.type === "assistant" &&
          parsed.message?.content
        ) {
          const text = extractText(parsed.message.content);
          if (text) firstAssistantMessage = text;
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (messageCount === 0) {
      return null;
    }

    // Extract session ID from filename
    const fileName = filePath.split(/[/\\]/).pop() || "";
    const sessionId = fileName.replace(".jsonl", "");

    return {
      sessionId,
      cwd,
      firstUserMsgId,
      firstMessage: firstMessage.substring(0, 100),
      lastMessage: lastMessage.substring(0, 100),
      firstAssistantMessage: firstAssistantMessage.substring(0, 140),
      messageCount,
      updatedAt: lastTime,
      entries,
    };
  } catch {
    return null;
  }
}

/**
 * Group sessions by their first user message ID (same conversation thread)
 * This is the CloudCLI approach - sessions with the same firstUserMsgId
 * are considered part of the same conversation
 */
function groupSessions(
  sessions: Array<{
    sessionId: string;
    cwd: string;
    firstUserMsgId: string | null;
    firstMessage: string;
    lastMessage: string;
    firstAssistantMessage: string;
    messageCount: number;
    updatedAt: string;
  }>,
): SessionSummary[] {
  // Group by firstUserMsgId
  const groups = new Map<
    string,
    {
      latestSession: (typeof sessions)[0];
      allSessions: (typeof sessions)[0][];
    }
  >();

  for (const session of sessions) {
    const key = session.firstUserMsgId || session.sessionId;

    if (!groups.has(key)) {
      groups.set(key, {
        latestSession: session,
        allSessions: [session],
      });
    } else {
      const group = groups.get(key)!;
      group.allSessions.push(session);

      // Update latest session if this one is more recent
      if (
        new Date(session.updatedAt) > new Date(group.latestSession.updatedAt)
      ) {
        group.latestSession = session;
      }
    }
  }

  // Convert to SessionSummary array
  const result: SessionSummary[] = [];

  for (const [, group] of groups) {
    const latest = group.latestSession;
    const isGrouped = group.allSessions.length > 1;

    // Calculate total message count across all sessions in the group
    const totalMessageCount = group.allSessions.reduce(
      (sum, s) => sum + s.messageCount,
      0,
    );

    result.push({
      sessionId: latest.sessionId,
      cwd: latest.cwd,
      firstMessage: latest.firstMessage,
      lastMessage: latest.lastMessage,
      firstAssistantMessage: latest.firstAssistantMessage,
      messageCount: totalMessageCount,
      updatedAt: latest.updatedAt,
      ...(isGrouped
        ? {
            isGrouped: true,
            groupSize: group.allSessions.length,
            groupSessions: group.allSessions.map(s => s.sessionId),
          }
        : {}),
    });
  }

  // Sort by updated time, newest first
  result.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return result;
}

/**
 * GET /api/sessions - List all sessions with grouping
 */
export async function handleSessionList(c: Context) {
  try {
    const projectDirs = await listProjectDirs();
    const allSessions: Array<{
      sessionId: string;
      cwd: string;
      firstUserMsgId: string | null;
      firstMessage: string;
      lastMessage: string;
      firstAssistantMessage: string;
      messageCount: number;
      updatedAt: string;
    }> = [];

    // Scan each project directory
    for (const projectDir of projectDirs) {
      const jsonlFiles = await listJsonlFiles(projectDir);

      for (const filePath of jsonlFiles) {
        const parsed = await parseSessionFile(filePath);
        if (parsed) {
          allSessions.push({
            sessionId: parsed.sessionId,
            cwd: parsed.cwd,
            firstUserMsgId: parsed.firstUserMsgId,
            firstMessage: parsed.firstMessage,
            lastMessage: parsed.lastMessage,
            firstAssistantMessage: parsed.firstAssistantMessage,
            messageCount: parsed.messageCount,
            updatedAt: parsed.updatedAt,
          });
        }
      }
    }

    // Group sessions by firstUserMsgId
    const groupedSessions = groupSessions(allSessions);

    console.log(`[sessions] Found ${groupedSessions.length} session groups`);
    return c.json({ sessions: groupedSessions });
  } catch (error) {
    console.error(`[sessions] Error:`, error);
    return c.json({ sessions: [] });
  }
}

/**
 * GET /api/sessions/search?q=<query>&limit=<number>
 *
 * Brute-force substring search across every message in every .jsonl
 * under ~/.claude/projects. Adequate up to ~10k messages; switch to
 * SQLite FTS5 when this gets slow.
 *
 * Response shape mirrors what the frontend's claudeApi.searchSessions
 * + ChatHistorySearchPanel expect — don't reshape without updating
 * those.
 */

export async function handleSessionSearch(c: Context) {
  const q = (c.req.query("q") || "").trim();
  const limitRaw = Number(c.req.query("limit"));
  const limit = Math.min(
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw :50,
    200,
  );

  if (q.length < 2) {
    return c.json({ hits: [], total: 0, took_ms: 0 });
  }

  const t0 = Date.now();
  const lowerQ = q.toLowerCase();
  const SNIPPET_PAD = 150;
  type Hit = {
    sessionId: string;
    cwd: string;
    messageRole: "user" | "assistant";
    snippet: string;
    matchStart: number;
    matchEnd: number;
    timestamp: string;
  };
  const hits: Hit[] = [];

  outer: for (const projectDir of await listProjectDirs()) {
    const jsonlFiles = await listJsonlFiles(projectDir);
    for (const filePath of jsonlFiles) {
      const fileName = filePath.split(/[/\\]/).pop() || "";
      const sessionId = fileName.replace(".jsonl", "");
      let content: string;
      try {
        content = await readTextFile(filePath);
      } catch {
        continue;
      }
      let cwd = "";
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let parsed: RawHistoryLine;
        try {
          parsed = JSON.parse(line) as RawHistoryLine;
        } catch {
          continue;
        }
        if (!cwd && parsed.cwd) cwd = parsed.cwd;
        if (parsed.type !== "user" && parsed.type !== "assistant") continue;
        const text = extractText(parsed.message?.content);
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(lowerQ);
        if (idx === -1) continue;

        const sliceStart = Math.max(0, idx - SNIPPET_PAD);
        const sliceEnd = Math.min(text.length, idx + q.length + SNIPPET_PAD);
        const truncL = sliceStart > 0;
        const truncR = sliceEnd < text.length;
        const snippet =
          (truncL ? "…" : "") +
          text.slice(sliceStart, sliceEnd) +
          (truncR ? "…" : "");
        const matchStart = idx - sliceStart + (truncL ? 1 : 0);
        const matchEnd = matchStart + q.length;

        hits.push({
          sessionId,
          cwd,
          messageRole: parsed.type as "user" | "assistant",
          snippet,
          matchStart,
          matchEnd,
          timestamp: parsed.timestamp,
        });
        if (hits.length >= limit) break outer;
      }
    }
  }

  hits.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return c.json({
    hits,
    total: hits.length,
    took_ms: Date.now() - t0,
  });
  
}

/**
 * DELETE /api/sessions/:sessionId - Delete a session AND all its fork siblings.
 *
 * Because `--resume` in SDK print mode forks on every turn, a single logical
 * conversation is spread across multiple .jsonl files sharing the same
 * firstUserMsgId. Deleting one fork alone would just expose the next-latest
 * fork in the sidebar. Delete the whole group to match the user's mental
 * model of "delete this chat".
 */
export async function handleDeleteSession(c: Context) {
  const sessionId = c.req.param("sessionId");

  if (!sessionId) {
    return c.json({ error: "Session ID is required" }, 400);
  }

  const projectDirs = await listProjectDirs();

  // Locate the target file and its project dir
  let targetFile: string | null = null;
  let targetProjectDir: string | null = null;
  for (const projectDir of projectDirs) {
    const candidate = path.join(projectDir, `${sessionId}.jsonl`);
    if (await exists(candidate)) {
      targetFile = candidate;
      targetProjectDir = projectDir;
      break;
    }
  }

  if (!targetFile || !targetProjectDir) {
    return c.json({ error: "Session not found" }, 404);
  }

  const firstUserMsgId = await getSessionFirstUserMsgId(targetFile);
  const filesToDelete = new Set<string>([targetFile]);

  // If we know the conversation root, collect all forks from the same project
  if (firstUserMsgId) {
    const siblings = await listJsonlFiles(targetProjectDir);
    for (const sibling of siblings) {
      if (filesToDelete.has(sibling)) continue;
      const siblingRoot = await getSessionFirstUserMsgId(sibling);
      if (siblingRoot === firstUserMsgId) {
        filesToDelete.add(sibling);
      }
    }
  }

  const { unlink } = await import("node:fs/promises");
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const file of filesToDelete) {
    try {
      await unlink(file);
      const name = file.split(/[/\\]/).pop() || "";
      deleted.push(name.replace(".jsonl", ""));
    } catch (error) {
      console.error(`[sessions] Failed to delete ${file}:`, error);
      failed.push(file);
    }
  }

  console.log(
    `[sessions] Deleted ${deleted.length} fork(s) for conversation ${firstUserMsgId || sessionId}:`,
    deleted,
  );

  if (failed.length > 0 && deleted.length === 0) {
    return c.json({ error: "Failed to delete session" }, 500);
  }

  return c.json({ success: true, sessionId, deletedSessionIds: deleted });
}

/**
 * Find the first user message ID for a session (for grouping)
 */
async function getSessionFirstUserMsgId(sessionFile: string): Promise<string | null> {
  try {
    const content = await readTextFile(sessionFile);
    const lines = content.trim().split("\n").filter(l => l.trim());

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "user" && parsed.parentUuid === null && parsed.uuid) {
          return parsed.uuid;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * GET /api/sessions/:sessionId/messages - Get all messages for a session and its grouped sessions
 */
export async function handleSessionMessages(c: Context) {
  const sessionId = c.req.param("sessionId");

  if (!sessionId) {
    return c.json({ error: "Session ID is required" }, 400);
  }

  // Find the session file
  const projectsDir = getClaudeProjectsDir();
  const projectDirs = await listProjectDirs();

  let foundSessionFile: string | null = null;
  let firstUserMsgId: string | null = null;
  let foundProjectDir: string | null = null;

  // First, find the session file and its firstUserMsgId
  for (const projectDir of projectDirs) {
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
    if (await exists(sessionFile)) {
      foundSessionFile = sessionFile;
      foundProjectDir = projectDir;
      firstUserMsgId = await getSessionFirstUserMsgId(sessionFile);
      break;
    }
  }

  if (!foundSessionFile) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Collect all session files in the same project directory
  const allSessionFiles = await listJsonlFiles(foundProjectDir!);

  // If this session has a firstUserMsgId, find all sessions with the same firstUserMsgId
  // These are all part of the same conversation (from resume chain)
  const sessionFilesToLoad: string[] = [foundSessionFile];

  if (firstUserMsgId) {
    for (const filePath of allSessionFiles) {
      if (filePath === foundSessionFile) continue;

      const otherFirstUserMsgId = await getSessionFirstUserMsgId(filePath);
      if (otherFirstUserMsgId === firstUserMsgId) {
        sessionFilesToLoad.push(filePath);
      }
    }
  }

  // Load messages from all related session files
  const messages: Array<{
    type: string;
    role: string;
    content: string;
    timestamp: string;
    sessionId?: string;
  }> = [];

  for (const sessionFile of sessionFilesToLoad) {
    try {
      const content = await readTextFile(sessionFile);
      const lines = content.trim().split("\n").filter(l => l.trim());

      // Extract session ID from filename
      const fileName = sessionFile.split(/[/\\]/).pop() || "";
      const fileSessionId = fileName.replace(".jsonl", "");

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "user" || parsed.type === "assistant") {
            messages.push({
              type: parsed.type,
              role: parsed.type === "user" ? "user" : "assistant",
              content: extractText(parsed.message?.content) || "",
              timestamp: parsed.timestamp || "",
              sessionId: fileSessionId,
            });
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  // Sort messages by timestamp
  messages.sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Extract cwd from the first message entry (if available)
  let cwd = "";
  if (messages.length > 0) {
    // Try to get cwd from session file directly
    try {
      const content = await readTextFile(foundSessionFile!);
      const lines = content.trim().split("\n").filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.cwd) {
            cwd = parsed.cwd;
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Ignore errors reading cwd
    }
  }

  return c.json({ sessionId, messages, cwd });
}

/**
 * POST /api/system/pick-folder — spawn the OS native folder-picker
 * dialog on the machine running this server and return the chosen path.
 *
 * The browser can't show a folder picker that returns an absolute path
 * (for privacy, `showDirectoryPicker()` returns only a sandboxed handle
 * with no full path). Since this backend is always local-only
 * (127.0.0.1) and the user is sitting at the same machine, we can cheat
 * and use the native OS picker via a tiny platform-specific shell
 * snippet. Blocks the request thread until the user picks or cancels.
 *
 * Response: { path: string | null, error?: string }
 *   - path: selected absolute path, or null if cancelled
 */
export async function handlePickFolder(c: Context) {
  let initialDir = "";
  try {
    const body = await c.req.json();
    if (body && typeof body.initialDir === "string") {
      initialDir = body.initialDir.trim();
    }
  } catch {
    // Empty body is fine — initialDir is optional
  }

  const platform = process.platform;
  const { spawnSync } = await import("node:child_process");

  let result: { stdout: string; status: number | null; stderr: string };

  try {
    if (platform === "win32") {
      // PowerShell's FolderBrowserDialog. Force STA threading so the
      // dialog actually renders (default MTA hangs the call).
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog;",
        "$dlg.Description = 'Choose a project folder';",
        initialDir
          ? `$dlg.SelectedPath = '${initialDir.replace(/'/g, "''")}';`
          : "",
        "$dlg.ShowNewFolderButton = $true;",
        "if ($dlg.ShowDialog() -eq 'OK') { Write-Output $dlg.SelectedPath }",
      ].join(" ");
      const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-STA", "-Command", ps],
        { encoding: "utf8", timeout: 5 * 60 * 1000 },
      );
      result = { stdout: r.stdout || "", status: r.status, stderr: r.stderr || "" };
    } else if (platform === "darwin") {
      // AppleScript's `choose folder`. Returns a HFS-style path which
      // we convert to POSIX via `POSIX path of`.
      const prompt = initialDir
        ? `choose folder with prompt "Choose a project folder" default location POSIX file "${initialDir}"`
        : `choose folder with prompt "Choose a project folder"`;
      const r = spawnSync(
        "osascript",
        ["-e", `POSIX path of (${prompt})`],
        { encoding: "utf8", timeout: 5 * 60 * 1000 },
      );
      result = { stdout: r.stdout || "", status: r.status, stderr: r.stderr || "" };
    } else {
      // Linux — try zenity. Falls back with a clear error if absent.
      const args = ["--file-selection", "--directory", "--title=Choose a project folder"];
      if (initialDir) args.push(`--filename=${initialDir}/`);
      const r = spawnSync("zenity", args, {
        encoding: "utf8",
        timeout: 5 * 60 * 1000,
      });
      if (r.error) {
        return c.json(
          {
            path: null,
            error:
              "Native folder picker unavailable on this system. Install 'zenity' or enter a path manually.",
          },
          501,
        );
      }
      result = { stdout: r.stdout || "", status: r.status, stderr: r.stderr || "" };
    }
  } catch (error) {
    return c.json(
      {
        path: null,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }

  const picked = result.stdout.trim();
  if (!picked) {
    // User cancelled or picker closed — this is a normal outcome, not
    // an error. Return null so the frontend just does nothing.
    return c.json({ path: null });
  }

  // Normalize separators to forward-slash for consistency with the rest
  // of the app (frontend compares cwds as strings).
  const normalized = picked.replace(/\\/g, "/").replace(/\/+$/, "");
  return c.json({ path: normalized });
}

/**
 * POST /api/system/pick-file — spawn the OS native file-picker dialog
 * and return the chosen file(s), optionally reading text contents inline
 * so the frontend can prepend them to the next message as context.
 *
 * Request body: {
 *   multiple?: boolean;         // default false
 *   initialDir?: string;        // hint to open dialog in this dir
 *   includeContent?: boolean;   // default true; read text bodies
 *   maxContentBytes?: number;   // default 1 MB, hard cap 20 MB; files
 *                               // larger than the chosen value are
 *                               // returned as "other" without body
 *                               // (caller falls back to path reference)
 * }
 *
 * Response: {
 *   files: Array<{
 *     path: string;           // absolute, forward-slash normalized
 *     filename: string;
 *     sizeBytes: number;
 *     mimeType: string;       // best-effort guess
 *     kind: 'text' | 'image' | 'other';
 *     content?: string;       // present only for small text files
 *   }>;
 *   error?: string;
 * }
 *
 * Cancel returns { files: [] }.
 */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "log",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "jsonc",
  "py", "pyi", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp",
  "h", "hpp", "hh", "cs", "php", "lua", "sh", "bash", "zsh", "fish", "ps1",
  "html", "htm", "xml", "svg", "css", "scss", "sass", "less",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "sql", "dockerfile", "makefile", "gitignore", "gitattributes",
  "vue", "svelte", "astro",
  "ino", "pde", // arduino
]);
const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff", "avif",
]);

function guessKindAndMime(filename: string): {
  kind: "text" | "image" | "other";
  mimeType: string;
} {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      kind: "image",
      mimeType: ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`,
    };
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return { kind: "text", mimeType: "text/plain" };
  }
  // Also treat files with no extension as text (e.g. Makefile, Dockerfile)
  if (!filename.includes(".")) {
    return { kind: "text", mimeType: "text/plain" };
  }
  return { kind: "other", mimeType: "application/octet-stream" };
}

export async function handlePickFile(c: Context) {
  let multiple = false;
  let initialDir = "";
  let includeContent = true;
  // Default 1 MB per text file inlined; hard ceiling 20 MB so the
  // caller can't push an arbitrary-size file through. Anything above
  // the per-call maxContentBytes is degraded to "other" kind (path
  // reference only — Claude's Read tool can still open it).
  let maxContentBytes = 1024 * 1024;
  const HARD_CONTENT_BYTES_CAP = 20 * 1024 * 1024;
  try {
    const body = await c.req.json();
    if (body && typeof body === "object") {
      if (typeof body.multiple === "boolean") multiple = body.multiple;
      if (typeof body.initialDir === "string") initialDir = body.initialDir.trim();
      if (typeof body.includeContent === "boolean") includeContent = body.includeContent;
      if (typeof body.maxContentBytes === "number" && body.maxContentBytes > 0) {
        maxContentBytes = Math.min(body.maxContentBytes, HARD_CONTENT_BYTES_CAP);
      }
    }
  } catch {
    // Empty body is fine — all fields optional
  }

  const platform = process.platform;
  const { spawnSync } = await import("node:child_process");

  let stdout = "";
  let errResp: { status: number; body: { files: []; error: string } } | null = null;

  try {
    if (platform === "win32") {
      // OpenFileDialog, Multiselect support. We ask PS to emit one
      // absolute path per line, which keeps parsing trivial.
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$dlg = New-Object System.Windows.Forms.OpenFileDialog;",
        "$dlg.Title = 'Choose file(s) to attach';",
        `$dlg.Multiselect = $${multiple ? "true" : "false"};`,
        initialDir
          ? `$dlg.InitialDirectory = '${initialDir.replace(/'/g, "''")}';`
          : "",
        "if ($dlg.ShowDialog() -eq 'OK') { $dlg.FileNames | ForEach-Object { Write-Output $_ } }",
      ].join(" ");
      const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-STA", "-Command", ps],
        { encoding: "utf8", timeout: 5 * 60 * 1000 },
      );
      stdout = r.stdout || "";
    } else if (platform === "darwin") {
      // AppleScript. `choose file with multiple selections allowed`
      // returns a list of aliases which we convert to POSIX paths.
      const multi = multiple ? " with multiple selections allowed" : "";
      const locClause = initialDir
        ? ` default location POSIX file "${initialDir}"`
        : "";
      const script = multiple
        ? `set theFiles to choose file${multi}${locClause} with prompt "Choose file(s) to attach"\n` +
          `set out to ""\n` +
          `repeat with f in theFiles\n` +
          `set out to out & POSIX path of f & linefeed\n` +
          `end repeat\n` +
          `return out`
        : `POSIX path of (choose file${locClause} with prompt "Choose a file to attach")`;
      const r = spawnSync("osascript", ["-e", script], {
        encoding: "utf8",
        timeout: 5 * 60 * 1000,
      });
      stdout = r.stdout || "";
    } else {
      // Linux — zenity.
      const args = ["--file-selection", "--title=Choose file(s) to attach"];
      if (multiple) args.push("--multiple", "--separator=\n");
      if (initialDir) args.push(`--filename=${initialDir}/`);
      const r = spawnSync("zenity", args, {
        encoding: "utf8",
        timeout: 5 * 60 * 1000,
      });
      if (r.error) {
        errResp = {
          status: 501,
          body: {
            files: [],
            error:
              "Native file picker unavailable on this system. Install 'zenity' or paste paths manually.",
          },
        };
      }
      stdout = r.stdout || "";
    }
  } catch (error) {
    return c.json(
      {
        files: [],
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }

  if (errResp) return c.json(errResp.body, errResp.status as 501);

  const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) {
    // User cancelled — normal outcome, not an error.
    return c.json({ files: [] });
  }

  const { statSync, readFileSync } = await import("node:fs");

  const files = lines.map((rawPath) => {
    const normalized = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const filename = normalized.split("/").pop() || normalized;
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(rawPath).size;
    } catch {
      // File vanished between picker and here; continue with 0 size
    }
    let { kind, mimeType } = guessKindAndMime(filename);
    let content: string | undefined;
    if (
      includeContent &&
      kind === "text" &&
      sizeBytes > 0 &&
      sizeBytes <= maxContentBytes
    ) {
      try {
        content = readFileSync(rawPath, "utf8");
      } catch (error) {
        // Read failure (permission, binary with text ext) → degrade to "other"
        console.warn(
          `[pick-file] Failed to read ${rawPath} as utf8:`,
          error instanceof Error ? error.message : String(error),
        );
        kind = "other";
        content = undefined;
      }
    } else if (kind === "text" && sizeBytes > maxContentBytes) {
      // Text file, but too large to inline — caller will treat as
      // "path-only" reference (Claude can still open it via Read tool).
      kind = "other";
    }

    return {
      path: normalized,
      filename,
      sizeBytes,
      mimeType,
      kind,
      ...(content !== undefined ? { content } : {}),
    };
  });

  return c.json({ files });
}

/**
 * POST /api/projects/create — create a new project directory on disk.
 *
 * Body: { path: string } — absolute path to create (recursive mkdir).
 *
 * Idempotent: if the directory already exists, it returns success.
 * Rejects non-absolute paths because the SDK will feed this through as
 * `cwd` for child_process.spawn, and a relative value makes spawn fail
 * with the infamously misleading "native binary not found" from the
 * agent SDK.
 */
export async function handleCreateProject(c: Context) {
  let body: { path?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const raw = typeof body.path === "string" ? body.path.trim() : "";
  if (!raw) {
    return c.json({ error: "Missing 'path' field" }, 400);
  }

  const isAbsolute =
    /^[A-Za-z]:[/\\]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\");
  if (!isAbsolute) {
    return c.json(
      {
        error: `Path must be absolute, got "${raw}". Example: D:/foo/bar or /home/you/project`,
      },
      400,
    );
  }

  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(raw, { recursive: true });
    console.log(`[projects] Created project directory: ${raw}`);
    return c.json({ success: true, path: raw });
  } catch (error) {
    console.error(`[projects] Failed to create ${raw}:`, error);
    return c.json(
      {
        error: `Failed to create directory: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      500,
    );
  }
}

/**
 * DELETE /api/projects — remove a project: delete every .jsonl under its
 * encoded projects dir, then remove the dir itself if empty.
 *
 * Body: { cwd: string } — the real working directory (same value shown
 * in the sidebar, derived from jsonl contents, NOT the encoded slug).
 *
 * The on-disk slug is computed the same way the SDK computes it:
 * path-separator-like chars turned into `-`, with the Windows drive
 * letter getting a `--` suffix. We don't remove arbitrary files — only
 * .jsonl history — so unrelated files (e.g. a `memory/` dir) are
 * preserved; the dir itself is only removed when left empty.
 */
export async function handleDeleteProject(c: Context) {
  let body: { cwd?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd) {
    return c.json({ error: "Missing 'cwd' field" }, 400);
  }

  // Replicate the SDK's encoding convention
  const encodedName = cwd
    .replace(/[/\\:._]/g, "-")
    .replace(/^([A-Za-z]):/, "$1--");
  const projectDir = path.join(getClaudeProjectsDir(), encodedName);

  let deleted = 0;
  let skipped = 0;
  const failed: string[] = [];

  if (await exists(projectDir)) {
    const { unlink, rmdir, readdir } = await import("node:fs/promises");
    const jsonls = await listJsonlFiles(projectDir);

    for (const file of jsonls) {
      try {
        await unlink(file);
        deleted++;
      } catch (error) {
        console.error(`[projects] Failed to unlink ${file}:`, error);
        failed.push(file);
      }
    }

    // Remove the project dir only if there's nothing left — preserves any
    // companion artefacts (e.g. a user's `memory/` subdir) the user might
    // want to keep.
    try {
      const remaining = await readdir(projectDir);
      if (remaining.length === 0) {
        await rmdir(projectDir);
      } else {
        skipped = remaining.length;
      }
    } catch (error) {
      console.error(`[projects] Failed to cleanup ${projectDir}:`, error);
    }
  }

  console.log(
    `[projects] Deleted project cwd="${cwd}": removed ${deleted} jsonl(s)` +
      (skipped > 0 ? `, kept ${skipped} non-history file(s)` : "") +
      (failed.length > 0 ? `, ${failed.length} failure(s)` : ""),
  );

  return c.json({
    success: true,
    cwd,
    deletedJsonlCount: deleted,
    keptNonHistoryCount: skipped,
    failedCount: failed.length,
  });
}

// =====================================================================
// Slash-command discovery + expansion
//
// Claude Code CLI discovers commands from several sources at startup:
//   - ~/.claude/commands/*.md                (user commands)
//   - ~/.claude/skills/<name>/SKILL.md       (user skills)
//   - <cwd>/.claude/commands/*.md            (project commands)
//   - <cwd>/.claude/skills/<name>/SKILL.md   (project skills)
//
// On top of that it hard-codes a set of built-ins (/clear, /compact,
// /init, /context, /debug, /heapdump, /insights, ...) inside the CLI
// binary. The SDK doesn't expose those, so for the web UI we:
//   1. Scan those four directories for the dynamic set.
//   2. Return them to the frontend with body=null (body is fetched
//      on-demand via /expand to keep this listing cheap and responsive).
//   3. The frontend MERGES these with its own local-UI built-ins
//      (/clear, /help, /modes, /history, /new, /cost, /model, /compact,
//      /init, /context) and shows everything in one menu.
//
// Commands here are treated as "prompt templates": when executed, the
// body is substituted with arguments and sent as the next message.
// =====================================================================

export interface DiscoveredCommand {
  name: string;                  // "/claude-api"
  description: string;
  source:
    | "user-commands"
    | "user-skills"
    | "project-commands"
    | "project-skills"
    | "plugin-skills"
    | "plugin-commands";
  filepath: string;              // absolute
  argumentHint?: string;         // optional
}

/**
 * Parse YAML frontmatter from a markdown file.
 *
 * We don't pull in a full YAML parser — skills/commands use a tiny
 * subset (name:, description:, allowed-tools:, argument-hint:), all
 * single-line scalar values. This simple line-by-line parser handles
 * that shape and bails on anything more complex.
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: content };
  }
  const frontmatter: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip wrapping quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }
  const body = lines.slice(i + 1).join("\n");
  return { frontmatter, body };
}

async function readCommandsDir(
  dir: string,
  source: DiscoveredCommand["source"],
): Promise<DiscoveredCommand[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  if (!(await exists(dir))) return [];
  const out: DiscoveredCommand[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filepath = path.join(dir, entry);
    try {
      const content = await readFile(filepath, "utf8");
      const { frontmatter } = parseFrontmatter(content);
      const name = entry.replace(/\.md$/, "");
      out.push({
        name: `/${name}`,
        description: frontmatter.description || `Custom command from ${entry}`,
        source,
        filepath,
        argumentHint: frontmatter["argument-hint"] || undefined,
      });
    } catch (error) {
      console.warn(`[slash-commands] Failed to read ${filepath}:`, error);
    }
  }
  return out;
}

async function readSkillsDir(
  dir: string,
  source: DiscoveredCommand["source"],
): Promise<DiscoveredCommand[]> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  if (!(await exists(dir))) return [];
  const out: DiscoveredCommand[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const subdir = path.join(dir, entry);
    try {
      const st = await stat(subdir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const skillFile = path.join(subdir, "SKILL.md");
    if (!(await exists(skillFile))) continue;
    try {
      const content = await readFile(skillFile, "utf8");
      const { frontmatter } = parseFrontmatter(content);
      // Prefer frontmatter `name`; fall back to directory name.
      const name = frontmatter.name || entry;
      out.push({
        name: `/${name}`,
        description: frontmatter.description || `Skill: ${name}`,
        source,
        filepath: skillFile,
        argumentHint: frontmatter["argument-hint"] || undefined,
      });
    } catch (error) {
      console.warn(`[slash-commands] Failed to read ${skillFile}:`, error);
    }
  }
  return out;
}

/**
 * Walk the plugin-cache tree (~/.claude/plugins/cache/) and harvest
 * every skill and command bundled by an installed plugin.
 *
 * Plugin layout (from Claude Code's installer):
 *   <cacheRoot>/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
 *   <cacheRoot>/<marketplace>/<plugin>/<version>/commands/*.md
 *
 * We walk with a depth cap (PLUGIN_WALK_MAX_DEPTH) because a mis-packaged
 * plugin could nest arbitrarily; caps also guard against symlink cycles.
 * On each "skills/" or "commands/" dir hit we delegate to the same
 * helpers the non-plugin paths use.
 */
const PLUGIN_WALK_MAX_DEPTH = 6;

async function walkPluginCache(
  root: string,
): Promise<DiscoveredCommand[]> {
  if (!(await exists(root))) return [];
  const { readdir, stat } = await import("node:fs/promises");
  const acc: DiscoveredCommand[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > PLUGIN_WALK_MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = (await stat(full)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (entry === "skills") {
        acc.push(...(await readSkillsDir(full, "plugin-skills")));
      } else if (entry === "commands") {
        acc.push(...(await readCommandsDir(full, "plugin-commands")));
      } else {
        await visit(full, depth + 1);
      }
    }
  };

  await visit(root, 0);
  return acc;
}

/**
 * GET /api/slash-commands?cwd=<abs>
 *
 * Returns the dynamic set of commands discoverable from the user-home,
 * project, and installed-plugin directories. Built-in CLI commands
 * (/clear, /compact, etc.) are NOT included — the frontend owns those
 * as local entries.
 *
 * Response: { commands: DiscoveredCommand[] }
 */
export async function handleListSlashCommands(c: Context) {
  const cwdParam = c.req.query("cwd") || "";
  // Unicode-safe; use node's os.homedir directly (always defined on
  // modern Node) instead of utils/getHomeDir which may return undefined.
  const homeDir = homedir();

  const userCommandsDir = path.join(homeDir, ".claude", "commands");
  const userSkillsDir = path.join(homeDir, ".claude", "skills");
  const projectCommandsDir = cwdParam
    ? path.join(cwdParam, ".claude", "commands")
    : "";
  const projectSkillsDir = cwdParam
    ? path.join(cwdParam, ".claude", "skills")
    : "";

  const pluginCacheRoot = path.join(homeDir, ".claude", "plugins", "cache");

  const [userCmds, userSkills, projectCmds, projectSkills, pluginItems] =
    await Promise.all([
      readCommandsDir(userCommandsDir, "user-commands"),
      readSkillsDir(userSkillsDir, "user-skills"),
      projectCommandsDir
        ? readCommandsDir(projectCommandsDir, "project-commands")
        : Promise.resolve([]),
      projectSkillsDir
        ? readSkillsDir(projectSkillsDir, "project-skills")
        : Promise.resolve([]),
      walkPluginCache(pluginCacheRoot),
    ]);

  // Dedup by name with precedence: project > user > plugin. That way
  // a user or project can override a plugin-shipped skill by creating
  // a same-named local file.
  const byName = new Map<string, DiscoveredCommand>();
  for (const list of [pluginItems, userSkills, userCmds, projectSkills, projectCmds]) {
    for (const cmd of list) byName.set(cmd.name, cmd);
  }
  const commands = Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return c.json({ commands });
}

/**
 * POST /api/slash-commands/expand
 *
 * Body: { name: string, args: string, cwd?: string }
 * Response: { prompt: string, source: string, argumentHint?: string }
 *
 * Looks up the command by name (same discovery as /list), reads the
 * .md file's body, performs $ARGUMENTS and $1-$9 substitution, and
 * returns the result as a prompt ready to be sent via /api/chat.
 *
 * The frontend sends this result as a regular message — Claude sees
 * the expanded template and acts on it like it would in the CLI's
 * interactive mode.
 */
export async function handleExpandSlashCommand(c: Context) {
  let body: { name?: string; args?: string; cwd?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = (body.name || "").trim();
  const args = (body.args || "").trim();
  const cwdParam = (body.cwd || "").trim();

  if (!name.startsWith("/")) {
    return c.json({ error: "Command name must start with /" }, 400);
  }

  // Re-run discovery to find the target command. Cheap — a few fs
  // listings. Avoids caching bugs when user edits a SKILL.md.
  // Unicode-safe; use node's os.homedir directly (always defined on
  // modern Node) instead of utils/getHomeDir which may return undefined.
  const homeDir = homedir();
  const [userCmds, userSkills, projectCmds, projectSkills, pluginItems] =
    await Promise.all([
      readCommandsDir(path.join(homeDir, ".claude", "commands"), "user-commands"),
      readSkillsDir(path.join(homeDir, ".claude", "skills"), "user-skills"),
      cwdParam
        ? readCommandsDir(
            path.join(cwdParam, ".claude", "commands"),
            "project-commands",
          )
        : Promise.resolve([]),
      cwdParam
        ? readSkillsDir(
            path.join(cwdParam, ".claude", "skills"),
            "project-skills",
          )
        : Promise.resolve([]),
      walkPluginCache(path.join(homeDir, ".claude", "plugins", "cache")),
    ]);

  // Same precedence as /list: project > user > plugin.
  const byName = new Map<string, DiscoveredCommand>();
  for (const list of [pluginItems, userSkills, userCmds, projectSkills, projectCmds]) {
    for (const cmd of list) byName.set(cmd.name, cmd);
  }

  const found = byName.get(name);
  if (!found) {
    return c.json({ error: `Unknown command: ${name}` }, 404);
  }

  const { readFile } = await import("node:fs/promises");
  let raw: string;
  try {
    raw = await readFile(found.filepath, "utf8");
  } catch (error) {
    return c.json(
      {
        error: `Failed to read ${found.filepath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      500,
    );
  }

  const { body: template } = parseFrontmatter(raw);

  // Split args on whitespace for positional substitution. The full
  // `args` string is also available via $ARGUMENTS.
  const argsArray = args.length > 0 ? args.split(/\s+/) : [];

  let expanded = template;
  // Replace $ARGUMENTS first so positional $1, $2 inside the rest of
  // the template don't accidentally substitute into the joined form.
  expanded = expanded.replace(/\$ARGUMENTS/g, args);
  for (let i = 1; i <= 9; i++) {
    const re = new RegExp(`\\$${i}(?!\\d)`, "g");
    expanded = expanded.replace(re, argsArray[i - 1] || "");
  }

  return c.json({
    prompt: expanded,
    source: found.source,
    argumentHint: found.argumentHint,
  });
}

