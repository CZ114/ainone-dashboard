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

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { type SessionSummary } from '../../store/chatStore';
import { claudeApi, type SearchHit } from '../../api/claudeApi';

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

// Search state tuning — debounce avoids hammering the backend on
// every keystroke; min length avoids returning everything for "a" or
// "i". 50 hits is plenty for an in-drawer list (more wouldn't fit on
// screen anyway, and the UI starts to feel unresponsive past that).
const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_MIN_QUERY_LEN = 2;
const SEARCH_RESULT_LIMIT = 50;

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
  onOpenNewProjectDialog,
}: ChatSidebarProps) {
  const groups = useMemo(
    () => groupByProject(sessions, extraProjects),
    [sessions, extraProjects],
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    loadExpandState(),
  );

  // -------- In-drawer search state ---------------------------------
  // The whole search experience is inline: the input lives in the
  // header, results replace the project list when the query is
  // non-empty, clearing the input restores the project list. No
  // modal, no separate route — the drawer IS the search surface.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Race-guard: every keystroke fires a fresh request, but slow ones
  // can land after fast ones if the user types quickly. We bump this
  // counter and only accept the latest response.
  const searchSeqRef = useRef(0);

  // Debounced search effect. Re-runs on every keystroke; the cleanup
  // cancels the previous timer so only the LAST debounced fire issues
  // a network call. Sub-min-length clears results immediately.
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (trimmed.length < SEARCH_MIN_QUERY_LEN) {
      setSearchHits([]);
      setSearchLoading(false);
      setSearchError(null);
      setSearchActiveIdx(0);
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(async () => {
      const seq = ++searchSeqRef.current;
      const r = await claudeApi.searchSessions(trimmed, SEARCH_RESULT_LIMIT);
      if (seq !== searchSeqRef.current) return; // stale response
      setSearchLoading(false);
      if (r.error) {
        setSearchError(r.error);
        setSearchHits([]);
      } else {
        setSearchError(null);
        setSearchHits(r.hits);
        setSearchActiveIdx(0);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const isSearching = searchQuery.trim().length >= SEARCH_MIN_QUERY_LEN;

  const handleSelectSearchHit = useCallback(
    (hit: SearchHit) => {
      onSelectSession(hit.sessionId);
      // Clear the query so the project list reappears for the user's
      // next visit. They can scroll-to-find later if needed.
      setSearchQuery('');
    },
    [onSelectSession],
  );

  // Keyboard navigation through search results. Listens at the input
  // level (via onKeyDown on the input below) so we don't capture
  // arrow keys when the user isn't actually focused on search.

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
    // Embedded mode — fills its parent container. The outer
    // ChatPage hosts this inside a resizable Panel that owns
    // visibility/collapse semantics; we don't manage drawer state
    // here anymore.
    <div className="h-full flex flex-col bg-card-bg">
      {/* Header */}
      <div className="p-3 border-b border-card-border shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-text-primary">
            Chat History
          </h2>
        </div>
        <button
          onClick={handleNewProjectClick}
          className="w-full px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-lg transition-colors"
          title="Register a new project folder — you'll be asked for its absolute path, then dropped into a fresh chat scoped to it."
        >
          + New Project
        </button>
        {/* Inline cross-session search. Real input — typing here
            replaces the project list below with matching messages
            from every .jsonl under ~/.claude/projects. Clearing the
            input restores the project list. No modal, no separate
            route — the drawer IS the search surface. */}
        <div className="mt-2 flex items-center gap-2 px-3 py-2 bg-window-bg border border-card-border rounded-lg focus-within:border-accent/60">
          <span className="text-sm text-text-muted shrink-0" aria-hidden="true">🔍</span>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              // Arrow / Enter / Escape navigation while focused. We
              // gate on the input being the focused element so these
              // keys don't fire when the input is blank-but-rendered
              // and the user is interacting with the project list.
              if (!isSearching) {
                if (e.key === 'Escape' && searchQuery !== '') {
                  setSearchQuery('');
                }
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setSearchQuery('');
              } else if (e.key === 'ArrowDown' && searchHits.length > 0) {
                e.preventDefault();
                setSearchActiveIdx((i) => Math.min(i + 1, searchHits.length - 1));
              } else if (e.key === 'ArrowUp' && searchHits.length > 0) {
                e.preventDefault();
                setSearchActiveIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && searchHits.length > 0) {
                e.preventDefault();
                handleSelectSearchHit(searchHits[searchActiveIdx]);
              }
            }}
            placeholder="Search history…"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 min-w-0 bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          {searchLoading && (
            <span className="text-[10px] text-text-muted animate-pulse shrink-0">
              …
            </span>
          )}
          {searchQuery && !searchLoading && (
            <button
              onClick={() => {
                setSearchQuery('');
                searchInputRef.current?.focus();
              }}
              className="text-text-muted hover:text-text-primary text-xs shrink-0"
              title="Clear search"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Project list — OR — search results (mutually exclusive
          based on whether the input has a usable query). Same scroll
          container so the user's eye stays in one place when toggling
          between modes. */}
      <div className="flex-1 overflow-y-auto">
        {isSearching ? (
          <SearchResultsView
            hits={searchHits}
            loading={searchLoading}
            error={searchError}
            query={searchQuery.trim()}
            activeIdx={searchActiveIdx}
            onHover={setSearchActiveIdx}
            onSelect={handleSelectSearchHit}
          />
        ) : groups.length === 0 ? (
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
                        ? 'bg-accent/10'
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
                      className="shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-accent/30 transition-colors opacity-60 group-hover/row:opacity-100"
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
                                  ? 'bg-accent/20 border border-accent/50'
                                  : 'hover:bg-card-border/50 border border-transparent'
                              }`}
                              onClick={() => onSelectSession(session.sessionId)}
                            >
                              <div className="text-[10px] text-text-muted mb-0.5">
                                {formatTime(session.updatedAt)}
                              </div>
                              {/* Two-line topic summary: user's
                                  question + Claude's first substantive
                                  reply. Both clamp at 2 lines via
                                  -webkit-line-clamp so a long opening
                                  message doesn't push the metadata row
                                  off the card.

                                  Falls back to the original 1-line
                                  layout if firstAssistantMessage is
                                  missing (older backend, or a session
                                  with no assistant reply yet). */}
                              <div className="text-xs text-text-primary line-clamp-2 leading-snug">
                                {truncate(session.firstMessage, 100)}
                              </div>
                              {session.firstAssistantMessage && (
                                <div
                                  className="mt-0.5 text-[11px] text-text-secondary line-clamp-2 leading-snug"
                                  title={session.firstAssistantMessage}
                                >
                                  <span className="text-text-muted/70 mr-1">↳</span>
                                  {truncate(session.firstAssistantMessage, 120)}
                                </div>
                              )}
                              <div className="text-[10px] text-text-secondary mt-1 truncate flex items-center gap-2">
                                <span>{session.messageCount} messages</span>
                                {session.isGrouped && session.groupSize ? (
                                  <span
                                    className="px-1 py-0 rounded bg-accent/20 text-accent-soft text-[9px]"
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search results sub-view — rendered inside the same scroll container as
// the project list, mutually exclusive based on whether the input has a
// usable query. Kept in this file (instead of a separate component) so
// the data flow stays simple: ChatSidebar owns query/hits/activeIdx
// state, this is just the presentational layer.

interface SearchResultsViewProps {
  hits: SearchHit[];
  loading: boolean;
  error: string | null;
  query: string;
  activeIdx: number;
  onHover: (idx: number) => void;
  onSelect: (hit: SearchHit) => void;
}

function SearchResultsView({
  hits,
  loading,
  error,
  query,
  activeIdx,
  onHover,
  onSelect,
}: SearchResultsViewProps) {
  // Keep the active row scrolled into view when the user arrow-keys
  // through a long results list. scrollIntoView with 'nearest' avoids
  // jumpy recentering — the row stays put if it's already on screen.
  useEffect(() => {
    const row = document.querySelector<HTMLElement>(
      `[data-search-hit-idx="${activeIdx}"]`,
    );
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (error) {
    return (
      <div className="p-3 text-xs text-red-400">
        <div className="font-semibold mb-1">Search failed</div>
        <div className="break-all">{error}</div>
        <div className="mt-2 text-text-muted">
          Is the chat backend running, and is{' '}
          <code>/api/sessions/search</code> registered?
        </div>
      </div>
    );
  }

  if (loading && hits.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-muted">
        Searching…
      </div>
    );
  }

  if (!loading && hits.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-muted">
        No matches for{' '}
        <span className="text-text-secondary">"{query}"</span>.
      </div>
    );
  }

  return (
    <ul className="py-1">
      {hits.map((hit, i) => (
        <li
          key={`${hit.sessionId}-${hit.timestamp}-${i}`}
          data-search-hit-idx={i}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep input focused
            onSelect(hit);
          }}
          className={`px-3 py-2 cursor-pointer border-l-2 ${
            i === activeIdx
              ? 'bg-accent/10 border-accent'
              : 'border-transparent hover:bg-card-border/30'
          }`}
        >
          <div className="flex items-center gap-2 text-[10px] text-text-muted mb-0.5">
            <SearchRoleBadge role={hit.messageRole} />
            <span className="truncate flex-1 min-w-0">
              {getDisplayName(hit.cwd)}
            </span>
            <span className="shrink-0">{formatRelative(hit.timestamp)}</span>
          </div>
          <div className="text-xs text-text-secondary leading-snug">
            <SearchSnippet
              snippet={hit.snippet}
              matchStart={hit.matchStart}
              matchEnd={hit.matchEnd}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function SearchRoleBadge({ role }: { role: SearchHit['messageRole'] }) {
  const styles =
    role === 'user'
      ? 'bg-accent/15 text-accent-soft border-accent/30'
      : 'bg-accent/15 text-accent-soft border-accent/30';
  return (
    <span
      className={`text-[9px] px-1 py-0 rounded border font-mono uppercase tracking-wider ${styles}`}
    >
      {role === 'user' ? 'you' : 'claude'}
    </span>
  );
}

// Render snippet with the matched range highlighted. Backend gives us
// the snippet plus offsets into it, so we just slice + wrap. Doing
// this client-side (instead of returning HTML) keeps the API JSON
// clean and skips the sanitization headache.
function SearchSnippet({
  snippet,
  matchStart,
  matchEnd,
}: {
  snippet: string;
  matchStart: number;
  matchEnd: number;
}) {
  if (
    matchStart < 0 ||
    matchEnd > snippet.length ||
    matchEnd <= matchStart
  ) {
    return <span>{snippet}</span>;
  }
  return (
    <>
      <span>{snippet.slice(0, matchStart)}</span>
      <mark className="bg-yellow-500/30 text-yellow-100 rounded px-0.5">
        {snippet.slice(matchStart, matchEnd)}
      </mark>
      <span>{snippet.slice(matchEnd)}</span>
    </>
  );
}

// "5m ago", "yesterday", "Apr 24" depending on age. Cheap, no
// dependency on date-fns.
function formatRelative(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const ms = Date.now() - t;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const d = new Date(t);
  return `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
}
