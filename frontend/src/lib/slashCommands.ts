// Slash command registry — mix of local UI commands and server-
// discovered skills/commands.
//
// Two command origins:
//   1. LOCAL: defined in this file's SLASH_COMMANDS array. Pure
//      browser actions like /clear, /modes, /help, /cost. Also the
//      CLI-built-ins we can faithfully replicate without round-
//      tripping the backend (/compact, /init, /context).
//   2. SERVER: discovered by the backend scanning ~/.claude/skills/,
//      ~/.claude/commands/, <cwd>/.claude/skills/, and
//      <cwd>/.claude/commands/. These are prompt templates; on
//      dispatch the backend expands the template with arguments and
//      the frontend sends the result as a normal message.
//
// Both kinds are merged into one menu by `buildMergedCommands()` and
// sorted alphabetically (with local built-ins pinned to the top
// because they're conceptually "harness-level" actions).
//
// The `/` menu is shown only when the user's input starts with `/`
// and contains no whitespace — i.e. they're still typing the command
// name itself. Once they add a space (arguments), matching stops.

import type {
  SystemMessage,
  AllMessage,
  PermissionModeValue,
  ThinkingModeValue,
  EffortModeValue,
} from '../store/chatStore';
import type { ToastMessage } from '../components/Toast';
import type { DiscoveredCommand } from '../api/claudeApi';
import { claudeApi } from '../api/claudeApi';

export interface SlashContext {
  // Input-state helpers
  setInput: (v: string) => void;

  // Session / message helpers
  clearMessages: () => void;
  setSessionId: (id: string | null) => void;
  setDisplaySessionId: (id: string | null) => void;
  setTemporarySessionId: (id: string | null) => void;
  clearPendingAttachments: () => void;

  // UI surface
  pushToast: (text: string, kind?: ToastMessage['kind']) => void;
  openSidebar: () => void;
  openNewProjectDialog: () => void;

  // Send flow — used by /compact to reroute through normal send
  sendPrompt: (text: string) => void;

  // Cache of recent agent messages (for /cost, /model etc.)
  messages: AllMessage[];

  // Current toolbar selections (for /modes).
  permissionMode: PermissionModeValue;
  thinkingMode: ThinkingModeValue;
  effortMode: EffortModeValue;

  // Active project cwd — sent with `expand` calls so the backend scans
  // the right project-level skills/commands directory.
  cwd: string | null;

  // Raw argument string (everything after the command name in the
  // textarea). E.g. for "/review PR-123 urgent", args="PR-123 urgent".
  // Local commands usually ignore this; server commands get it
  // forwarded to the backend for $ARGUMENTS / $1-$9 substitution.
  args: string;
}

export interface SlashCommand {
  name: string;                  // always with leading slash, e.g. '/clear'
  description: string;
  icon?: string;
  // Tagged so menu UI can distinguish origin (local vs server).
  origin?: 'local' | 'server';
  // Server-only metadata for tooltip + debugging
  source?: DiscoveredCommand['source'];
  argumentHint?: string;
  execute: (ctx: SlashContext) => void | Promise<void>;
}

function findLatestSystemSubtype(
  messages: AllMessage[],
  subtype: 'init' | 'result' | 'error',
): SystemMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === 'system' && (m as SystemMessage).subtype === subtype) {
      return m as SystemMessage;
    }
  }
  return null;
}

function formatUsd(n: number | undefined | null): string {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/clear',
    description: 'Clear this conversation (same as the Clear Chat button)',
    icon: '🧹',
    execute: (ctx) => {
      ctx.clearMessages();
      ctx.setSessionId(null);
      ctx.setDisplaySessionId(null);
      ctx.setTemporarySessionId(null);
      ctx.clearPendingAttachments();
      ctx.setInput('');
    },
  },
  {
    name: '/compact',
    description:
      'Compact the session — CLI summarizes history and shrinks the context window in place',
    icon: '🗜️',
    execute: (ctx) => {
      // Forward the literal `/compact` (plus any user args) to the CLI.
      // The backend no longer strips the leading `/`, so the CLI sees
      // a real slash command and triggers its in-place compaction —
      // NOT a "please summarize" model turn, which is what this used
      // to do (and left the full history intact).
      ctx.setInput('');
      const raw = ctx.args ? `/compact ${ctx.args}` : '/compact';
      ctx.sendPrompt(raw);
    },
  },
  {
    name: '/cost',
    description: 'Show token usage and cost from the most recent Claude response',
    icon: '💰',
    execute: (ctx) => {
      const result = findLatestSystemSubtype(ctx.messages, 'result');
      if (!result) {
        ctx.pushToast('No result yet — send a message first.', 'info');
        return;
      }
      const cost = formatUsd(result.total_cost_usd);
      const dur = result.duration_ms ? `${result.duration_ms}ms` : '—';
      // SystemMessage has a loose shape — pull usage fields if present.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = result as any;
      const usage = r.usage || {};
      const input = usage.input_tokens ?? r.input_tokens ?? '?';
      const output = usage.output_tokens ?? r.output_tokens ?? '?';
      ctx.pushToast(
        `${cost} · in ${input} / out ${output} tokens · ${dur}`,
        'info',
      );
      ctx.setInput('');
    },
  },
  {
    name: '/help',
    description: 'List all slash commands',
    icon: '❓',
    execute: (ctx) => {
      const lines = SLASH_COMMANDS.map(
        (c) => `${c.name} — ${c.description}`,
      ).join('\n');
      ctx.pushToast(lines, 'info');
      ctx.setInput('');
    },
  },
  {
    name: '/history',
    description: 'Open the chat history drawer',
    icon: '📜',
    execute: (ctx) => {
      ctx.openSidebar();
      ctx.setInput('');
    },
  },
  {
    name: '/new',
    description: 'Register a new project folder',
    icon: '📁',
    execute: (ctx) => {
      ctx.openNewProjectDialog();
      ctx.setInput('');
    },
  },
  {
    name: '/model',
    description: 'Show the model used by the current session',
    icon: '🤖',
    execute: (ctx) => {
      const init = findLatestSystemSubtype(ctx.messages, 'init');
      if (!init || !init.model) {
        ctx.pushToast('Model info not available yet — send a message first.', 'info');
      } else {
        ctx.pushToast(`Model: ${init.model}`, 'info');
      }
      ctx.setInput('');
    },
  },
  {
    name: '/init',
    description:
      'Initialize a CLAUDE.md — runs the real CLI /init (no custom prompt)',
    icon: '📝',
    execute: (ctx) => {
      // Pass through to CLI. /init is one of Claude Code's built-in
      // slash commands and has a more sophisticated codebase-scan
      // implementation than a bare prompt template could replicate.
      ctx.setInput('');
      const raw = ctx.args ? `/init ${ctx.args}` : '/init';
      ctx.sendPrompt(raw);
    },
  },
  {
    name: '/context',
    description:
      'Show aggregate token usage for this session (from recorded results)',
    icon: '📊',
    execute: (ctx) => {
      // Sum up usage fields from every system/result in the current
      // message buffer. Not perfectly accurate across a long session
      // (doesn't account for CLI-side compaction), but matches what
      // we have client-side.
      let totalIn = 0;
      let totalOut = 0;
      let totalCacheRead = 0;
      let totalCost = 0;
      let resultCount = 0;
      for (const m of ctx.messages) {
        if (m.type === 'system' && (m as SystemMessage).subtype === 'result') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = m as any;
          const u = r.usage || {};
          totalIn += u.input_tokens || 0;
          totalOut += u.output_tokens || 0;
          totalCacheRead += u.cache_read_input_tokens || 0;
          if (typeof r.total_cost_usd === 'number') totalCost += r.total_cost_usd;
          resultCount++;
        }
      }
      if (resultCount === 0) {
        ctx.pushToast('No results yet — send a message first.', 'info');
      } else {
        ctx.pushToast(
          `${resultCount} turn${resultCount === 1 ? '' : 's'}\n` +
            `Input tokens: ${totalIn.toLocaleString()}\n` +
            `Output tokens: ${totalOut.toLocaleString()}\n` +
            `Cache-read tokens: ${totalCacheRead.toLocaleString()}\n` +
            `Est. cost: $${totalCost.toFixed(4)}`,
          'info',
        );
      }
      ctx.setInput('');
    },
  },
  {
    name: '/modes',
    description: 'Show what Permission / Thinking / Effort are set to right now',
    icon: '⚙️',
    execute: (ctx) => {
      // Tiny textual snapshot — deliberate: lives in the toast, not a
      // modal, so it's dismissable but doesn't break flow. Mirrors the
      // rich `detail` strings in ChatInputTools.
      const pmMap: Record<PermissionModeValue, string> = {
        default: 'Ask (prompts before risky ops)',
        plan: 'Plan (propose only, no execution)',
        acceptEdits: 'Auto-Edit (silent file edits)',
        bypassPermissions: 'Bypass (fully autonomous)',
      };
      const tmMap: Record<ThinkingModeValue, string> = {
        default: 'Auto (model decides)',
        enabled: 'On (10K-token budget)',
        disabled: 'Off',
      };
      const emMap: Record<EffortModeValue, string> = {
        default: 'Auto',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'xHigh',
        max: 'Max',
      };
      ctx.pushToast(
        `Perm: ${pmMap[ctx.permissionMode]}\n` +
          `Think: ${tmMap[ctx.thinkingMode]}\n` +
          `Effort: ${emMap[ctx.effortMode]}`,
        'info',
      );
      ctx.setInput('');
    },
  },
];

// Tag local built-ins so the menu can show a subtle indicator of origin.
SLASH_COMMANDS.forEach((c) => {
  if (!c.origin) c.origin = 'local';
});

/**
 * Wrap a server-discovered command in a SlashCommand whose `execute`
 * asks the backend to expand the template and forwards the resulting
 * prompt through the normal send pipeline (sendPrompt).
 *
 * The expand call happens at dispatch time (not at discovery), so file
 * edits to the .md source are picked up immediately without a refetch.
 */
function buildServerCommand(disc: DiscoveredCommand): SlashCommand {
  // Short icons to visually hint origin without cluttering the menu.
  const icon =
    disc.source === 'user-skills' || disc.source === 'project-skills'
      ? '✨'
      : '📜';
  return {
    name: disc.name,
    description: disc.description,
    icon,
    origin: 'server',
    source: disc.source,
    argumentHint: disc.argumentHint,
    execute: async (ctx) => {
      ctx.setInput('');
      const result = await claudeApi.expandSlashCommand(
        disc.name,
        ctx.args,
        ctx.cwd || undefined,
      );
      if (result.error || !result.prompt) {
        ctx.pushToast(
          `Failed to expand ${disc.name}: ${result.error || 'empty prompt'}`,
          'error',
        );
        return;
      }
      ctx.sendPrompt(result.prompt);
    },
  };
}

/**
 * Merge local + server commands into a single deduplicated list.
 * Local built-ins win on name collision (the harness owns /clear, etc.)
 * and are pinned above server commands so discoverability stays stable.
 */
export function mergeCommands(
  local: SlashCommand[],
  server: DiscoveredCommand[],
): SlashCommand[] {
  const localNames = new Set(local.map((c) => c.name.toLowerCase()));
  const serverCmds = server
    .filter((d) => !localNames.has(d.name.toLowerCase()))
    .map(buildServerCommand)
    .sort((a, b) => a.name.localeCompare(b.name));
  const sortedLocal = [...local].sort((a, b) => a.name.localeCompare(b.name));
  return [...sortedLocal, ...serverCmds];
}

/**
 * Detect a command-in-progress in the input and return the match list.
 *
 * Triggers only when the trimmed input starts with `/` and contains no
 * whitespace — we don't want the menu to appear mid-message when a user
 * types "what about /foo here". Returns [] when the input isn't a slash
 * command context.
 */
export function getMenuMatches(
  input: string,
  commands: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const t = input.trim();
  if (!t.startsWith('/')) return [];
  if (/\s/.test(t)) return [];
  // Show full list for bare "/" so users can discover commands
  if (t === '/') return commands;
  const lower = t.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(lower));
}

/**
 * Look up an exact command for submission. Returns the command if the
 * input's leading word (everything up to the first whitespace) matches
 * a registered command name exactly; otherwise null and the caller
 * should treat the input as a normal message.
 */
export function resolveCommand(
  input: string,
  commands: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand | null {
  const t = input.trim();
  if (!t.startsWith('/')) return null;
  const firstWord = t.split(/\s/, 1)[0].toLowerCase();
  return commands.find((c) => c.name.toLowerCase() === firstWord) || null;
}
