// Slash command menu — shown above the textarea when the user types
// `/` as the first non-whitespace character of the input (and hasn't
// yet added a space to start typing arguments). Filters commands as
// they type; arrow keys navigate, Enter/Tab selects.
//
// The menu is a positioned overlay inside the input container — it
// doesn't use a portal, because its width should match the textarea's
// natural layout context. Keyboard handling lives in ChatInput
// (which also owns the textarea) and drives `activeIndex` here via
// props, so a single keydown handler stays authoritative.

import type { SlashCommand } from '../../lib/slashCommands';

function sourceLabel(s: NonNullable<SlashCommand['source']>): string {
  switch (s) {
    case 'user-skills':
      return 'user skill';
    case 'project-skills':
      return 'project skill';
    case 'user-commands':
      return 'user cmd';
    case 'project-commands':
      return 'project cmd';
    case 'plugin-skills':
      return 'plugin skill';
    case 'plugin-commands':
      return 'plugin cmd';
  }
}

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  onHoverIndex: (i: number) => void;
}

export function SlashCommandMenu({
  commands,
  activeIndex,
  onSelect,
  onHoverIndex,
}: SlashCommandMenuProps) {
  if (commands.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-4 right-4 mb-2 bg-card-bg border border-card-border rounded-lg shadow-lg overflow-hidden max-h-[320px] overflow-y-auto z-20"
      role="listbox"
      aria-label="Slash commands"
    >
      {commands.map((cmd, i) => {
        const active = i === activeIndex;
        return (
          <button
            key={cmd.name}
            onMouseDown={(e) => {
              // mousedown not click: click fires after textarea blur
              // which would destroy the selection context we need.
              e.preventDefault();
              onSelect(cmd);
            }}
            onMouseEnter={() => onHoverIndex(i)}
            className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${
              active
                ? 'bg-purple-600/20 text-text-primary'
                : 'hover:bg-card-border/40 text-text-secondary'
            }`}
            role="option"
            aria-selected={active}
          >
            <span className="text-base shrink-0" aria-hidden="true">
              {cmd.icon || '/'}
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2">
                <span className={`font-mono text-sm ${active ? 'text-purple-300' : 'text-text-primary'}`}>
                  {cmd.name}
                </span>
                {cmd.origin === 'server' && cmd.source && (
                  <span className="text-[9px] uppercase tracking-wide px-1 py-0 rounded bg-card-border/60 text-text-muted shrink-0">
                    {sourceLabel(cmd.source)}
                  </span>
                )}
                {cmd.argumentHint && (
                  <span className="text-[10px] italic text-text-muted shrink-0">
                    {cmd.argumentHint}
                  </span>
                )}
              </span>
              <span className="block text-[11px] text-text-muted truncate">
                {cmd.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
