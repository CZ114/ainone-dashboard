// Chat Sidebar - sessions grouped by project (cwd)
//
// Projects come from two sources:
//   1. `sessions[].cwd` — real projects that already have jsonl history
//   2. `extraProjects` — user-added empty folders via "+ New Project",
//      persisted in localStorage upstream. Shown with 0 sessions until
//      the user's first message in them creates a real jsonl.
//
// Display name is the last two path segments of cwd so
// `/foo/bar/learn/skillsLearn` shows as `learn/skillsLearn` — short but
// usually enough to disambiguate.

import { useMemo, useState, useEffect } from 'react';
import { type SessionSummary } from '../../store/chatStore';
import { claudeApi } from '../../api/claudeApi';

interface ChatSidebarProps {
  sessions: SessionSummary[];
  extraProjects?: string[];
  onSelectSession: (sessionId: string) => void;
  onNewChatInProject: (cwd: string) => void;
  onDeleteProject: (cwd: string) => void;
  // "Open in system terminal" — spawns the OS-native terminal at the
  // project's cwd with `claude` running. Gives the user the full
  // interactive CLI experience when the web UI isn't enough.
  onLaunchTerminal: (cwd: string) => void;
  onSessionDeleted: () => void;
  currentSessionId: string | null;
  open: boolean;
  onClose: () => void;
  // Parent owns the NewProjectDialog state + submit handler so slash
  // commands (e.g. `/new`) can open it without the drawer being open.
  onOpenNewProjectDialog: () => void;
}

interface ProjectGroup {
  cwd: string;
  displayName: string;
  sessions: SessionSummary[];
  latestUpdatedAt: string;
}

const EXPAND_STATE_KEY = 'chat-sidebar-expanded-projects';

export function getDisplayName(cwd: string): string {
  if (!cwd) return '(no project)';
  const segments = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) return cwd;
  if (segments.length === 1) return segments[0];
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

// Canonical form of a cwd — used only as the Map key for dedup, never
// for display or for spawning child processes. Two cwds that refer to
// the same on-disk directory should collapse to the same key.
//
// The sessions list feeds us cwds read from jsonl (Windows-native
// backslashes, original case), while extraProjects comes from the New
// Project dialog (already forward-slash-normalized, user-typed case).
// Without canonicalization the sidebar shows duplicate project rows
// for the same folder.
export function canonicalCwd(cwd: string): string {
  if (!cwd) return '';
  let out = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows FS is case-insensitive across the whole path; collapse so
  // `D:/Foo` and `d:/foo` land in the same bucket. Linux paths are
  // case-sensitive, so only normalize when we see a drive letter
  // prefix (a pretty reliable "this is Windows" signal).
  if (/^[A-Za-z]:\//.test(out)) {
    out = out.toLowerCase();
  }
  return out;
}

function groupByProject(
  sessions: SessionSummary[],
  extraProjects: string[],
): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();

  // Seed from real sessions. The session's recorded cwd becomes the
  // display form for the group — it's the ground-truth path the CLI
  // actually used, and matches what the user will see in file
  // explorers / shell prompts.
  for (const session of sessions) {
    const cwd = session.cwd || '';
    const key = canonicalCwd(cwd);
    let group = map.get(key);
    if (!group) {
      group = {
        cwd,
        displayName: getDisplayName(cwd),
        sessions: [],
        latestUpdatedAt: session.updatedAt,
      };
      map.set(key, group);
    }
    group.sessions.push(session);
    if (
      session.updatedAt &&
      new Date(session.updatedAt) > new Date(group.latestUpdatedAt || 0)
    ) {
      group.latestUpdatedAt = session.updatedAt;
    }
  }

  // Merge in user-added empty folders (no sessions yet). If the
  // canonical key already has a group (because a session referring to
  // the same dir was seen), we don't overwrite — the existing group
  // already represents that project.
  for (const path of extraProjects) {
    if (!path) continue;
    const key = canonicalCwd(path);
    if (!map.has(key)) {
      map.set(key, {
        cwd: path,
        displayName: getDisplayName(path),
        sessions: [],
        // Use now() so fresh-added projects float to the top
        latestUpdatedAt: new Date().toISOString(),
      });
    }
  }

  for (const group of map.values()) {
    group.sessions.sort(
      (a, b) =>
        new Date(b.updatedAt || 0).getTime() -
        new Date(a.updatedAt || 0).getTime(),
    );
  }

  return Array.from(map.values()).sort(
    (a, b) =>
      new Date(b.latestUpdatedAt || 0).getTime() -
      new Date(a.latestUpdatedAt || 0).getTime(),
  );
}

function loadExpandState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPAND_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveExpandState(state: Record<string, boolean>) {
  try {
    localStorage.setItem(EXPAND_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota / private-mode failures
  }
}

export function ChatSidebar({
  sessions,
  extraProjects = [],
  onSelectSession,
  onNewChatInProject,
  onDeleteProject,
  onLaunchTerminal,
  onSessionDeleted,
  currentSessionId,
  open,
  onClose,
  onOpenNewProjectDialog,
}: ChatSidebarProps) {
  const groups = useMemo(
    () => groupByProject(sessions, extraProjects),
    [sessions, extraProjects],
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    loadExpandState(),
  );

  // Auto-expand the project containing the active session so the user
  // never has to hunt for where they are. Only expands, never collapses,
  // so it doesn't fight manual folds.
  useEffect(() => {
    if (!currentSessionId) return;
    const activeGroup = groups.find((g) =>
      g.sessions.some(
        (s) =>
          s.sessionId === currentSessionId ||
          s.groupSessions?.includes(currentSessionId),
      ),
    );
    if (activeGroup && !expanded[activeGroup.cwd]) {
      setExpanded((prev) => {
        const next = { ...prev, [activeGroup.cwd]: true };
        saveExpandState(next);
        return next;
      });
    }
  }, [currentSessionId, groups, expanded]);

  // Close drawer on ESC — cheap-and-accessible dismiss
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  const toggleProject = (cwd: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [cwd]: !prev[cwd] };
      saveExpandState(next);
      return next;
    });
  };

  const formatTime = (isoString: string) => {
    if (!isoString) return '';
    return new Date(isoString).toLocaleString();
  };

  const truncate = (text: string, maxLen: number) => {
    if (!text) return 'No message';
    const cleanText = text.replace(/<[^>]*>/g, '');
    return cleanText.length > maxLen
      ? cleanText.substring(0, maxLen) + '...'
      : cleanText;
  };

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!confirm('Delete this chat history?')) return;
    const success = await claudeApi.deleteSession(sessionId);
    if (success) onSessionDeleted();
  };

  const handleNewProjectClick = () => {
    onOpenNewProjectDialog();
  };

  const handleProjectPlusClick = (e: React.MouseEvent, cwd: string) => {
    e.stopPropagation(); // don't also toggle the fold
    onNewChatInProject(cwd);
  };

  const handleProjectDeleteClick = (e: React.MouseEvent, cwd: string) => {
    e.stopPropagation(); // confirm dialog lives in the parent handler
    onDeleteProject(cwd);
  };

  const handleProjectTerminalClick = (e: React.MouseEvent, cwd: string) => {
    e.stopPropagation(); // don't also toggle the project fold
    onLaunchTerminal(cwd);
  };

  return (
    <>
      {/* Backdrop — click outside to close. Pointer-events off when
          closed so the main area is fully interactive. */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden={!open}
      />

      {/* Drawer itself — slides in from the right. Kept mounted even
          when closed so expand/fold state and scroll position don't
          reset between opens. */}
      <aside
        className={`fixed right-0 top-0 bottom-0 z-50 w-80 max-w-[85vw] bg-card-bg border-l border-card-border flex flex-col shadow-2xl transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        aria-hidden={!open}
      >
      {/* Header */}
      <div className="p-4 border-b border-card-border shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary">
            Chat History
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary hover:bg-card-border/50 rounded transition-colors"
            title="Close (Esc)"
            aria-label="Close sidebar"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
        <button
          onClick={handleNewProjectClick}
          className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition-colors"
          title="Register a new project folder — you'll be asked for its absolute path, then dropped into a fresh chat scoped to it."
        >
          + New Project
        </button>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="p-4 text-sm text-text-muted">
            No chat history found
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {groups.map((group) => {
              const isExpanded = expanded[group.cwd] ?? false;
              const hasActive = group.sessions.some(
                (s) =>
                  currentSessionId === s.sessionId ||
                  (currentSessionId !== null &&
                    s.groupSessions?.includes(currentSessionId)),
              );

              return (
                <div key={group.cwd}>
                  {/* Project header row: click the name/arrow to fold,
                      click the + to start a new chat here. */}
                  <div
                    className={`group/row flex items-center gap-1 px-2 py-2 rounded-md transition-colors ${
                      hasActive
                        ? 'bg-purple-600/10'
                        : 'hover:bg-card-border/40'
                    }`}
                  >
                    <button
                      onClick={() => toggleProject(group.cwd)}
                      className={`flex-1 flex items-center gap-2 text-left min-w-0 ${
                        hasActive ? 'text-text-primary' : 'text-text-secondary'
                      }`}
                      title={group.cwd}
                    >
                      <span
                        className={`text-xs text-text-muted transition-transform ${
                          isExpanded ? 'rotate-90' : ''
                        }`}
                      >
                        ▶
                      </span>
                      <span className="text-sm font-medium truncate flex-1">
                        {group.displayName}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-card-border/60 text-text-muted shrink-0">
                        {group.sessions.length}
                      </span>
                    </button>
                    <button
                      onClick={(e) => handleProjectPlusClick(e, group.cwd)}
                      className="shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-purple-600/30 transition-colors opacity-60 group-hover/row:opacity-100"
                      title={`New chat in ${group.displayName}`}
                      aria-label="New chat in this project"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => handleProjectTerminalClick(e, group.cwd)}
                      className="shrink-0 p-1 rounded text-text-muted hover:text-emerald-300 hover:bg-emerald-500/20 transition-colors opacity-0 group-hover/row:opacity-100"
                      title={`Open ${group.displayName} in system terminal with Claude CLI`}
                      aria-label="Open in system terminal"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm3.293 2.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L7.586 11 5.293 8.707a1 1 0 010-1.414zM11 12a1 1 0 100 2h3a1 1 0 100-2h-3z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => handleProjectDeleteClick(e, group.cwd)}
                      className="shrink-0 p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-500/20 transition-colors opacity-0 group-hover/row:opacity-100"
                      title={`Delete project ${group.displayName}`}
                      aria-label="Delete this project"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  </div>

                  {/* Session list under this project */}
                  {isExpanded && (
                    <div className="ml-4 mt-1 space-y-1 border-l border-card-border/50 pl-2">
                      {group.sessions.length === 0 ? (
                        <div className="text-[10px] text-text-muted italic py-1 px-2">
                          No chats yet — click + to start one.
                        </div>
                      ) : (
                        group.sessions.map((session) => {
                          const isActive =
                            currentSessionId === session.sessionId ||
                            (currentSessionId !== null &&
                              session.groupSessions?.includes(
                                currentSessionId,
                              )) ||
                            false;

                          return (
                            <div
                              key={session.sessionId}
                              className={`group relative p-2 rounded-lg transition-colors cursor-pointer ${
                                isActive
                                  ? 'bg-purple-600/20 border border-purple-500/50'
                                  : 'hover:bg-card-border/50 border border-transparent'
                              }`}
                              onClick={() => onSelectSession(session.sessionId)}
                            >
                              <div className="text-[10px] text-text-muted mb-0.5">
                                {formatTime(session.updatedAt)}
                              </div>
                              <div className="text-xs text-text-primary truncate">
                                {truncate(session.firstMessage, 40)}
                              </div>
                              <div className="text-[10px] text-text-secondary mt-0.5 truncate flex items-center gap-2">
                                <span>{session.messageCount} messages</span>
                                {session.isGrouped && session.groupSize ? (
                                  <span
                                    className="px-1 py-0 rounded bg-purple-500/20 text-purple-300 text-[9px]"
                                    title={`Continued across ${session.groupSize} resume forks`}
                                  >
                                    {session.groupSize} branches
                                  </span>
                                ) : null}
                              </div>

                              {/* Delete button */}
                              <button
                                onClick={(e) =>
                                  handleDelete(e, session.sessionId)
                                }
                                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-red-400 transition-opacity"
                                title="Delete"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  className="h-3.5 w-3.5"
                                  viewBox="0 0 20 20"
                                  fill="currentColor"
                                >
                                  <path
                                    fillRule="evenodd"
                                    d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </aside>
    </>
  );
}
