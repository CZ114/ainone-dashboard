// Chat Page component - Claude Code chat interface with proper session handling

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../../store/chatStore';
import { claudeApi } from '../../api/claudeApi';
import { useStreamParser } from '../../hooks/useStreamParser';
import { ChatMessages, LoadingIndicator } from './ChatMessages';
import { ChatInput } from './ChatInput';
import { ChatSidebar, canonicalCwd } from './ChatSidebar';
import { NewProjectDialog } from './NewProjectDialog';
import { RecordingsPanel } from './RecordingsPanel';
import { EmbeddedTerminal } from '../shell/EmbeddedTerminal';
import { ThemeToggle } from '../ThemeToggle';
import { Toast, type ToastMessage } from '../Toast';
import {
  buildPromptWithAttachments,
  MAX_TOTAL_ATTACHMENT_BYTES,
  totalAttachmentBytes,
  formatSize,
} from '../../lib/attachments';
import {
  type SlashCommand,
  type SlashContext,
  SLASH_COMMANDS,
  mergeCommands,
} from '../../lib/slashCommands';
import type { DiscoveredCommand } from '../../api/claudeApi';
import { THINKING_BUDGET_TOKENS } from '../../store/chatStore';
import type {
  ThinkingConfigWire,
  EffortLevelWire,
} from '../../api/claudeApi';

function ChatPage() {
  const navigate = useNavigate();
  const { processStreamLine } = useStreamParser();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Chat state from store
  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);
  const isThinking = useChatStore((s) => s.isThinking);
  const error = useChatStore((s) => s.error);
  const sessionId = useChatStore((s) => s.sessionId);
  const displaySessionId = useChatStore((s) => s.displaySessionId);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setError = useChatStore((s) => s.setError);
  const setIsLoading = useChatStore((s) => s.setIsLoading);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const setDisplaySessionId = useChatStore((s) => s.setDisplaySessionId);
  const setTemporarySessionId = useChatStore((s) => s.setTemporarySessionId);
  const setCurrentRequestId = useChatStore((s) => s.setCurrentRequestId);
  const addMessage = useChatStore((s) => s.addMessage);
  const clearPendingAttachments = useChatStore((s) => s.clearPendingAttachments);

  // Session-related state
  const sessions = useChatStore((s) => s.sessions);
  const setSessions = useChatStore((s) => s.setSessions);
  const projects = useChatStore((s) => s.projects);
  const setProjects = useChatStore((s) => s.setProjects);
  const setMessages = useChatStore((s) => s.setMessages);

  // User-added empty projects (no sessions yet). Persisted in localStorage
  // so newly-created folders survive a reload before the first message
  // writes an actual .jsonl to disk.
  const EXTRA_PROJECTS_KEY = 'chat-extra-projects';
  const [extraProjects, setExtraProjects] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(EXTRA_PROJECTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  const persistExtraProjects = useCallback((next: string[]) => {
    setExtraProjects(next);
    try {
      localStorage.setItem(EXTRA_PROJECTS_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota/private-mode write failures
    }
  }, []);

  // Toast — one-at-a-time transient notification for actions that
  // otherwise have no visible effect (e.g. starting a new chat when
  // you're already in an empty chat state).
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const pushToast = useCallback((text: string, kind?: ToastMessage['kind']) => {
    setToast({ id: Date.now(), text, kind });
  }, []);

  // Sidebar drawer — opt-in, off by default. The old pinned-right
  // layout ate 18rem of every screen width just to show history the
  // user rarely references mid-chat.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Recordings drawer (right side) — lists ESP32 recording sessions
  // the user can drag into ChatInput as attachments. Opt-in for the
  // same screen-real-estate reason as the sidebar.
  const [recordingsOpen, setRecordingsOpen] = useState(false);

  // Whisper-local extension state — drives the ESP32 mic button
  // visibility. Polled every 5s because enabling/uninstalling happens
  // in a separate tab (Settings) and there's no WS event for it.
  const [whisperEnabled, setWhisperEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch('/api/extensions/whisper-local');
        if (!r.ok) {
          if (!cancelled) setWhisperEnabled(false);
          return;
        }
        const data = await r.json();
        if (!cancelled) {
          setWhisperEnabled(Boolean(data.installed && data.enabled));
        }
      } catch {
        if (!cancelled) setWhisperEnabled(false);
      }
    };
    void check();
    const t = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // New-project dialog — lifted out of ChatSidebar so the `/new`
  // slash command can open it even when the drawer is closed (a
  // transformed ancestor would clip a fixed-positioned dialog).
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);

  // Embedded-terminal session. `terminalCwd` null ⇒ no PTY spawned.
  // When non-null, the <EmbeddedTerminal> is mounted; `viewMode`
  // decides whether it's VISIBLE or just hidden behind the chat view.
  // Both views stay mounted so switching preserves:
  //   - Chat scroll position, typed but unsent input, attachment pills
  //   - Terminal scroll-back buffer, cursor state, live PTY session
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'chat' | 'terminal'>('chat');

  // Server-discovered slash commands (from ~/.claude/skills, commands,
  // and project-level equivalents). Refetched when the active cwd
  // changes so project-level commands come into / out of scope.
  const [serverCommands, setServerCommands] = useState<DiscoveredCommand[]>([]);

  // History loading state — briefly true between "user clicked a
  // session" and "messages arrived". Without this, the chat area
  // flashes the empty-state placeholder during the fetch and looks
  // like a bug.
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Load projects and sessions on mount
  useEffect(() => {
    const loadProjectsAndSessions = async () => {
      try {
        // Load projects (which contains session info via cwd)
        const projectList = await claudeApi.getProjects();
        setProjects(projectList.map((p) => ({ name: p.encodedName, path: p.path, encodedName: p.encodedName })));
      } catch (err) {
        console.error('[DEBUG] Error loading projects:', err);
      }

      // Load sessions
      try {
        const sessionList = await claudeApi.getSessions();
        setSessions(sessionList);
      } catch (err) {
        console.error('[DEBUG] Error loading sessions:', err);
      }
    };

    loadProjectsAndSessions();
  }, [setProjects, setSessions]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle session selection - load messages for that session
  const handleSelectSession = useCallback(async (newSessionId: string) => {
    console.log('[DEBUG] handleSelectSession:', newSessionId);

    // Clear any existing session and messages first. `clearMessages`
    // also drops pendingAttachments — avoids carrying files the user
    // picked under the previous conversation into this one.
    setSessionId(null);
    setDisplaySessionId(null);
    clearMessages();

    // Set the selected session ID as both live and display id.
    // Live id may later fork away when the user sends; display id stays.
    setSessionId(newSessionId);
    setDisplaySessionId(newSessionId);
    setIsLoadingHistory(true);
    // Close drawer on select — long history scroll works best with
    // the sidebar out of the way.
    setSidebarOpen(false);

    try {
      // Fetch messages for this session
      const result = await claudeApi.getSessionMessages(newSessionId);
      console.log('[DEBUG] getSessionMessages returned:', result);

      if (result.messages && result.messages.length > 0) {
        // Map messages to store format
        const loadedMessages = result.messages.map((m, i) => ({
          id: `load_${Date.now()}_${i}`,
          type: 'chat' as const,
          role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.content,
          timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
        }));
        setMessages(loadedMessages);
      }

      // Update project list with cwd from session (if available)
      if (result.cwd) {
        setProjects([{ name: '', path: result.cwd, encodedName: '' }]);
      }
    } catch (err) {
      console.error('[DEBUG] Error loading session messages:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [setSessionId, setDisplaySessionId, clearMessages, setMessages, setProjects]);

  // Start a fresh chat scoped to a specific project directory.
  //
  // Purely additive: NEVER deletes the previous session from disk. An
  // earlier version did, via an inverted guard, and the current chat
  // would vanish from the sidebar the moment you clicked "New Chat".
  // Deletion is the job of "Clear Chat" and the sidebar trash icons.
  //
  // The cwd is pinned by overwriting `projects` to a single entry so
  // handleSend picks it up as workingDirectory on the next send.
  const handleNewChatInProject = useCallback(
    async (cwd: string) => {
      setProjects([{ name: '', path: cwd, encodedName: '' }]);
      setSessionId(null);
      setDisplaySessionId(null);
      setTemporarySessionId(null);
      clearMessages();
      // Close the drawer so the user can see the empty chat + input
      // they're meant to type into.
      setSidebarOpen(false);

      // Visible confirmation: especially important when the previous
      // state was already an empty chat — without the toast, clicking +
      // appears to do nothing.
      const segs = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
      const shortName = segs.length >= 2
        ? `${segs[segs.length - 2]}/${segs[segs.length - 1]}`
        : segs[segs.length - 1] || cwd;
      pushToast(`New chat ready in ${shortName}`, 'success');

      // Refresh the sidebar so the just-finished conversation surfaces.
      const sessionList = await claudeApi.getSessions();
      setSessions(sessionList);
    },
    [
      setProjects,
      setSessionId,
      setDisplaySessionId,
      setTemporarySessionId,
      clearMessages,
      setSessions,
      pushToast,
    ],
  );

  // Register a new project folder. Combined action: create the folder
  // on disk (mkdir -p via backend), append to the extras list, and drop
  // the user into a fresh chat scoped to it, because "create project →
  // open it" is what users almost always mean.
  const handleNewProject = useCallback(
    async (rawPath: string) => {
      const path = rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (!path) return;

      // Reject non-absolute paths. The backend passes this through as
      // child_process.spawn's `cwd`, and a relative path makes spawn
      // fail with ENOENT — which the agent SDK then misleadingly
      // surfaces as "native binary not found". Better to catch it here
      // with a human-readable message.
      const isAbsoluteWindows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('//');
      const isAbsoluteUnix = path.startsWith('/');
      if (!isAbsoluteWindows && !isAbsoluteUnix) {
        window.alert(
          `"${rawPath}" is not an absolute path.\n\n` +
            `Please enter the full path, e.g.\n` +
            `  C:\\Projects\\my-project        (Windows)\n` +
            `  /home/user/my-project          (Linux/Mac)`,
        );
        return;
      }

      // Create the folder on disk (idempotent — mkdir -p). If this
      // fails we bail out early so we don't leave a ghost entry in the
      // sidebar pointing at a non-existent dir.
      const result = await claudeApi.createProject(path);
      if (!result.success) {
        window.alert(`Failed to create project folder:\n${result.error}`);
        return;
      }

      // Avoid duplicates — compare cwds canonically because session
      // paths from jsonl use Windows backslashes while user-typed
      // extras use forward slashes, and Windows FS is case-insensitive.
      // Without this, the sidebar shows the same folder twice.
      const canon = canonicalCwd(path);
      const existingCanonCwds = new Set(
        sessions.map((s) => canonicalCwd(s.cwd || '')),
      );
      const extrasCanon = new Set(extraProjects.map(canonicalCwd));
      if (!existingCanonCwds.has(canon) && !extrasCanon.has(canon)) {
        persistExtraProjects([...extraProjects, path]);
      }

      await handleNewChatInProject(path);
    },
    [sessions, extraProjects, persistExtraProjects, handleNewChatInProject],
  );

  // Open an EMBEDDED terminal at `cwd`. The terminal replaces the
  // chat view in-place (doesn't float over it) so users can toggle
  // back and forth while keeping both views' state intact.
  //
  // If there's already a terminal at a DIFFERENT cwd, opening a new
  // one terminates the old PTY (React remounts <EmbeddedTerminal>
  // when the cwd prop changes). If the new cwd matches the existing
  // one, we just switch views without touching the PTY.
  const handleLaunchTerminal = useCallback(
    (cwd: string) => {
      setTerminalCwd(cwd);
      setViewMode('terminal');
      setSidebarOpen(false);
    },
    [],
  );

  // Terminate the PTY session and return to chat. Used by the "End
  // session" button inside the terminal view. Distinct from just
  // switching back to chat (which keeps the PTY alive).
  const handleEndTerminalSession = useCallback(() => {
    setTerminalCwd(null);   // unmounts <EmbeddedTerminal>, WS close → backend pty.kill
    setViewMode('chat');
  }, []);

  // Remove a project from the sidebar.
  //
  // Two paths:
  // - empty project (only in extraProjects, no sessions on disk): just
  //   drop from localStorage, no backend call needed.
  // - real project with sessions: confirm destructive delete, then call
  //   backend to wipe all .jsonl files under that cwd's encoded project
  //   dir. Extra files (e.g. a companion memory/ dir) are preserved.
  const handleDeleteProject = useCallback(
    async (cwd: string) => {
      // Canonical comparison — session cwds and extras may differ in
      // slash direction or case but refer to the same folder.
      const targetCanon = canonicalCwd(cwd);
      const hasSessions = sessions.some(
        (s) => canonicalCwd(s.cwd || '') === targetCanon,
      );
      const isInExtras = extraProjects.some(
        (p) => canonicalCwd(p) === targetCanon,
      );

      if (hasSessions) {
        const ok = window.confirm(
          `Delete project "${cwd}"?\n\n` +
            `This removes ALL chat history files for this folder. The folder itself and any non-history files (e.g. memory/) are kept.`,
        );
        if (!ok) return;
        const result = await claudeApi.deleteProject(cwd);
        if (!result.success) {
          window.alert(`Delete failed:\n${result.error}`);
          return;
        }
      }

      if (isInExtras) {
        // Drop every extras entry whose canonical form matches — this
        // also cleans up any historically-duplicated entries that
        // slipped in before the canonical-compare fix.
        persistExtraProjects(
          extraProjects.filter((p) => canonicalCwd(p) !== targetCanon),
        );
      }

      // If we're currently inside a session that belonged to this
      // project, clear the UI — otherwise the header would point at a
      // deleted session.
      const active = useChatStore.getState();
      const activeGroup = sessions.find(
        (s) =>
          s.sessionId === active.sessionId ||
          s.groupSessions?.includes(active.sessionId || ''),
      );
      if (activeGroup && canonicalCwd(activeGroup.cwd) === targetCanon) {
        setSessionId(null);
        setDisplaySessionId(null);
        setTemporarySessionId(null);
        clearMessages();
      }

      const refreshed = await claudeApi.getSessions();
      setSessions(refreshed);
    },
    [
      sessions,
      extraProjects,
      persistExtraProjects,
      setSessionId,
      setDisplaySessionId,
      setTemporarySessionId,
      clearMessages,
      setSessions,
    ],
  );

  // Handle session deleted callback
  const handleSessionDeleted = useCallback(() => {
    claudeApi.getSessions().then(setSessions);
  }, [setSessions]);

  // Handle sending a message
  const handleSend = useCallback(async (message: string) => {
    // Read snapshot state up-front so multi-step logic is deterministic
    const storeSnapshot = useChatStore.getState();
    const attachments = storeSnapshot.pendingAttachments;

    // Empty-and-no-attachments guard — an attachment-only send is valid
    // (user might want "here are some files, what do you think?" without
    // the actual question — Claude will at least Read them).
    if (!message.trim() && attachments.length === 0) return;
    if (isLoading) return;

    // Abort early if attachments over size budget
    if (totalAttachmentBytes(attachments) > MAX_TOTAL_ATTACHMENT_BYTES) {
      pushToast(
        `Attachments exceed ${formatSize(MAX_TOTAL_ATTACHMENT_BYTES)} — remove some first.`,
        'error',
      );
      return;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Synthesize the final prompt: fenced text bodies + image/other
    // path references + the user's typed message. Shows the user
    // exactly-what-they-typed in the message bubble (not the synthesized
    // prompt), since that's closer to the mental model.
    const wirePrompt = buildPromptWithAttachments(message, attachments);

    // Display message is the user's typed text, plus a discreet summary
    // of what was attached. Prevents a jarring "my message now has
    // 50 lines of code in it" bubble.
    const displayText =
      attachments.length === 0
        ? message
        : `${message}${message ? '\n\n' : ''}` +
          `📎 ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}: ` +
          attachments.map((a) => a.filename).join(', ');

    addMessage({
      type: 'chat',
      role: 'user',
      content: displayText,
    });

    setIsLoading(true);
    setError(null);
    setCurrentRequestId(requestId);

    // Determine which session ID to use
    // Priority: existing sessionId > temporarySessionId > new temp session
    let sidToSend = storeSnapshot.sessionId;

    if (!sidToSend) {
      sidToSend = storeSnapshot.temporarySessionId;
      if (!sidToSend) {
        sidToSend = `new-session-${Date.now()}`;
        setTemporarySessionId(sidToSend);
      }
    }

    // Determine working directory - use project's cwd
    const workingDir = (() => {
      if (projects.length > 0 && projects[0].path) {
        return projects[0].path;
      }
      return undefined;
    })();

    // Translate toolbar state to wire types.
    // - permissionMode: always send (even 'default' — keeps backend
    //   behaviour predictable when the user explicitly picks it)
    // - thinking / effort: omit when 'default' so the SDK/model applies
    //   its own defaults (adaptive thinking on Opus 4.6+).
    const permissionMode = storeSnapshot.permissionMode;
    let thinkingWire: ThinkingConfigWire | undefined;
    if (storeSnapshot.thinkingMode === 'enabled') {
      thinkingWire = { type: 'enabled', budgetTokens: THINKING_BUDGET_TOKENS };
    } else if (storeSnapshot.thinkingMode === 'disabled') {
      thinkingWire = { type: 'disabled' };
    }
    const effortWire: EffortLevelWire | undefined =
      storeSnapshot.effortMode === 'default' ? undefined : storeSnapshot.effortMode;

    // Wire-level request log so bugs between "pill click" and
    // "backend log" can be localized. If this shows permissionMode
    // but backend's `[chat] request body` doesn't, the problem is
    // JSON serialization / HTTP layer. If this DOESN'T show it,
    // the problem is upstream (store not updated, pill not wired).
    console.log('[DEBUG] handleSend →', {
      sessionId: sidToSend,
      workingDirectory: workingDir,
      attachments: attachments.length,
      permissionMode,
      thinking: thinkingWire,
      effort: effortWire,
      storeSnapshotModes: {
        permission: storeSnapshot.permissionMode,
        thinking: storeSnapshot.thinkingMode,
        effort: storeSnapshot.effortMode,
      },
    });

    // Clear pending attachments now (not on success) — if the send
    // fails, the user has already "committed" them to this turn; making
    // them re-pick on a transient failure would be frustrating.
    clearPendingAttachments();

    try {
      const streamGenerator = claudeApi.sendMessage({
        message: wirePrompt,
        requestId,
        sessionId: sidToSend,
        workingDirectory: workingDir,
        permissionMode,
        ...(thinkingWire ? { thinking: thinkingWire } : {}),
        ...(effortWire ? { effort: effortWire } : {}),
      });

      for await (const _ of processStreamLine(streamGenerator, requestId)) {
        // Each iteration updates the store
      }

      // Refresh sessions so the sidebar picks up the new fork as the
      // group's latest representative (keeps highlight aligned with the
      // current live sessionId).
      try {
        const refreshed = await claudeApi.getSessions();
        setSessions(refreshed);
      } catch (refreshErr) {
        console.error('[DEBUG] Failed to refresh sessions after send:', refreshErr);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
      setIsLoading(false);
    } finally {
      setCurrentRequestId(null);
    }
  }, [isLoading, projects, addMessage, setIsLoading, setError, setCurrentRequestId, processStreamLine, setTemporarySessionId, setSessions, pushToast, clearPendingAttachments]);

  // Handle abort
  const handleAbort = useCallback(async () => {
    const requestId = useChatStore.getState().currentRequestId;
    if (requestId) {
      await claudeApi.abortRequest(requestId);
      setIsLoading(false);
      setCurrentRequestId(null);
    }
  }, [setIsLoading, setCurrentRequestId]);

  // Handle clear chat
  const handleClear = useCallback(async () => {
    if (sessionId && !sessionId.startsWith('new-session-')) {
      // Backend deletes the whole fork group, not just this one file
      await claudeApi.deleteSession(sessionId);
      claudeApi.getSessions().then(setSessions);
    }
    setSessionId(null);
    setDisplaySessionId(null);
    clearMessages();
  }, [sessionId, setSessionId, setDisplaySessionId, clearMessages, setSessions]);

  // Current cwd — shared between header and the ChatInputTools strip.
  // `projects[0].path` is the pinned cwd; handleSelectSession and
  // handleNewChatInProject both write to it.
  const currentCwd = projects[0]?.path || null;

  // Fetch server-discovered slash commands. Refetches when the pinned
  // cwd changes so project-level skills/commands appear as we switch
  // projects. Errors are logged but never toasted — a missing backend
  // endpoint shouldn't disable the whole input.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await claudeApi.listSlashCommands(currentCwd || undefined);
      if (cancelled) return;
      if (result.error) {
        console.warn('[chat] listSlashCommands failed:', result.error);
        setServerCommands([]);
      } else {
        setServerCommands(result.commands);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentCwd]);

  // Merged command list passed down to ChatInput / SlashCommandMenu.
  // Memoized so ChatInput doesn't re-render on every ChatPage render.
  const mergedCommands = useMemo(
    () => mergeCommands(SLASH_COMMANDS, serverCommands),
    [serverCommands],
  );

  // Dispatch a slash command. Builds a fresh SlashContext every call
  // so the command always sees current messages / current state.
  const handleSlashDispatch = useCallback(
    (cmd: SlashCommand, rawInput?: string) => {
      const snap = useChatStore.getState();
      // Extract args: everything after the first whitespace. If
      // rawInput wasn't supplied (e.g. menu click), fall back to
      // current store input. Commands that don't care about args just
      // ignore the field.
      const source = rawInput ?? snap.input;
      const match = source.trim().match(/^\/\S+\s+(.*)$/);
      const args = match ? match[1].trim() : '';

      const ctx: SlashContext = {
        setInput: snap.setInput,
        clearMessages,
        setSessionId,
        setDisplaySessionId,
        setTemporarySessionId,
        clearPendingAttachments,
        pushToast,
        openSidebar: () => setSidebarOpen(true),
        openNewProjectDialog: () => setShowNewProjectDialog(true),
        // /compact and server commands both reroute through handleSend
        // so the prompt goes through the normal stream + session
        // tracking pipeline.
        sendPrompt: (text: string) => {
          void handleSend(text);
        },
        messages: snap.messages,
        permissionMode: snap.permissionMode,
        thinkingMode: snap.thinkingMode,
        effortMode: snap.effortMode,
        cwd: currentCwd,
        args,
      };
      void cmd.execute(ctx);
    },
    // handleSend is declared later in the component; referenced via
    // closure so we can't put it in deps. Other setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearMessages, setSessionId, setDisplaySessionId, setTemporarySessionId, clearPendingAttachments, pushToast, currentCwd],
  );

  // Short display name for the current project (same algo as sidebar
  // getDisplayName). Surfaced in the header so the user always knows
  // which project the active chat is scoped to — otherwise a long
  // chat pushes that context out of sight and they lose their place.
  const currentProjectName = (() => {
    const cwd = projects[0]?.path || '';
    if (!cwd) return '';
    const segs = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segs.length === 0) return cwd;
    if (segs.length === 1) return segs[0];
    return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
  })();

  return (
    // h-screen (NOT min-h-screen) so the flex container is strictly
    // capped to viewport height. Without this, long message lists make
    // the root grow past 100vh and our `flex-1 overflow-y-auto` scroll
    // wrapper stops clipping — messages then push the header and
    // input out of view.
    <div className="h-screen bg-window-bg flex flex-col overflow-hidden">
      <Toast message={toast} onDismiss={() => setToast(null)} />

      {/* Header — always visible regardless of message volume */}
      <div className="bg-card-bg border-b border-card-border px-6 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 min-w-0">
            {/* Back to Dashboard button */}
            <button
              onClick={() => navigate('/dashboard')}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-card-border/50 rounded-lg transition-colors shrink-0"
            >
              <span>←</span>
              <span>Dashboard</span>
            </button>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
                Claude Code Chat
                {isThinking && (
                  <span className="flex items-center gap-1 text-xs text-purple-400">
                    <span className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
                    working...
                  </span>
                )}
              </h1>
              <p className="text-xs text-text-muted truncate flex items-center gap-2">
                {currentProjectName && (
                  <span className="text-text-secondary">
                    📁 {currentProjectName}
                  </span>
                )}
                <span>
                  {displaySessionId
                    ? `Session: ${displaySessionId.slice(0, 8)}…`
                    : sessionId
                    ? `Session: ${sessionId.slice(0, 8)}…`
                    : 'New conversation'}
                </span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Chat / Terminal view toggle. The Terminal tab only
                exists when there's an active PTY session — opening
                a terminal happens from the sidebar's project row.
                Clicking between tabs preserves BOTH views' state
                (chat scroll, typed input, attachments AND terminal
                scroll-back, cursor, live shell). */}
            {terminalCwd && (
              <div className="flex items-center gap-0.5 p-0.5 bg-card-border/30 rounded-md">
                <button
                  onClick={() => setViewMode('chat')}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    viewMode === 'chat'
                      ? 'bg-purple-600 text-white'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                  title="Switch to chat view"
                >
                  💬 Chat
                </button>
                <button
                  onClick={() => setViewMode('terminal')}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    viewMode === 'terminal'
                      ? 'bg-emerald-600 text-white'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                  title="Switch to terminal view"
                >
                  💻 Terminal
                </button>
              </div>
            )}
            {viewMode === 'chat' && (
              <button
                onClick={handleClear}
                className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-card-border/50 rounded-lg transition-colors"
              >
                Clear Chat
              </button>
            )}
            <ThemeToggle />
            {/* Settings — gear icon → /settings route where the user
                manages backend extensions (Whisper, future plugins). */}
            <button
              onClick={() => navigate('/settings')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-card-border/50 rounded-lg transition-colors"
              title="Open settings (extensions, preferences)"
              aria-label="Open settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
              <span className="hidden sm:inline">Settings</span>
            </button>
            {/* Recordings toggle — opens the right-side drawer that
                lists ESP32 sessions; user drags one into chat input. */}
            <button
              onClick={() => setRecordingsOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-card-border/50 rounded-lg transition-colors"
              title="Browse ESP32 recordings"
              aria-label="Open recordings panel"
            >
              <span>🎙️</span>
              <span className="hidden sm:inline">Recordings</span>
            </button>
            {/* Sidebar toggle — hamburger opens the history drawer */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-card-border/50 rounded-lg transition-colors"
              title="Open chat history & project panel"
              aria-label="Open sidebar"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
              </svg>
              <span className="hidden sm:inline">History</span>
            </button>
          </div>
        </div>
      </div>

      {/* Body region — hosts BOTH chat and terminal panels. Only the
          one matching `viewMode` is visible; the other is kept mounted
          via `display: none` so its state (chat scroll / typed input /
          xterm scroll-back / live PTY) survives tab switches.
          Important: the hidden panel's DOM still reports 0×0 — the
          EmbeddedTerminal has a 0×0 resize-guard to handle that. */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Chat panel */}
        <div
          className={`flex-1 flex flex-col overflow-hidden ${
            viewMode === 'chat' ? '' : 'hidden'
          }`}
          aria-hidden={viewMode !== 'chat'}
        >
          {/* Error display */}
          {error && (
            <div className="mx-auto mt-4 max-w-4xl w-full px-6">
              <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            </div>
          )}

          {/* Scrollable messages area */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto w-full px-6 py-6">
              {isLoadingHistory ? (
                <div className="flex flex-col items-center justify-center py-16 text-text-muted">
                  <div className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin mb-3" />
                  <div className="text-sm">Loading conversation…</div>
                </div>
              ) : (
                <>
                  <ChatMessages messages={messages} />
                  {isLoading && messages.length > 0 && <LoadingIndicator />}
                </>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input bar */}
          <div className="shrink-0">
            <ChatInput
              onSend={handleSend}
              onAbort={handleAbort}
              isLoading={isLoading}
              cwd={currentCwd}
              commands={mergedCommands}
              esp32MicAvailable={whisperEnabled}
              onSlashDispatch={handleSlashDispatch}
              onModeChangeAnnounce={(text) => pushToast(text, 'info')}
            />
          </div>
        </div>

        {/* Terminal panel — mounted once per `terminalCwd` value.
            Changing cwd remounts and therefore starts a fresh PTY;
            staying on the same cwd while switching tabs keeps the
            existing PTY intact. */}
        {terminalCwd && (
          <div
            className={`flex-1 flex flex-col overflow-hidden ${
              viewMode === 'terminal' ? '' : 'hidden'
            }`}
            aria-hidden={viewMode !== 'terminal'}
          >
            {/* Per-session action bar — only shown in terminal view.
                "End session" kills the PTY and drops back to chat;
                plain tab switching preserves the session. */}
            <div className="shrink-0 px-4 py-1.5 border-b border-card-border flex items-center justify-between bg-card-bg">
              <span className="text-xs text-text-muted">
                Live PTY session — switch to Chat tab to check messages while this keeps running.
              </span>
              <button
                onClick={handleEndTerminalSession}
                className="text-xs px-2 py-1 rounded text-text-secondary hover:text-red-400 hover:bg-red-500/20 transition-colors"
                title="Kill the PTY and close this terminal"
              >
                End session ✕
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <EmbeddedTerminal
                key={terminalCwd}
                cwd={terminalCwd}
                onExit={() => {
                  // PTY itself exited (user ran `exit` or was killed).
                  // Leave the view mounted showing "exited" status so
                  // the user can scroll back through the final output;
                  // they dismiss explicitly via the End Session button.
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Floating sidebar drawer — positioned fixed, slides in/out */}
      <ChatSidebar
        sessions={sessions}
        extraProjects={extraProjects}
        onSelectSession={handleSelectSession}
        onNewChatInProject={handleNewChatInProject}
        onDeleteProject={handleDeleteProject}
        onLaunchTerminal={handleLaunchTerminal}
        onSessionDeleted={handleSessionDeleted}
        currentSessionId={sessionId}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onOpenNewProjectDialog={() => setShowNewProjectDialog(true)}
      />

      {/* New project dialog — lifted from ChatSidebar so `/new` can
          open it while the drawer is closed. */}
      <NewProjectDialog
        open={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
        onSubmit={(abs) => handleNewProject(abs)}
      />

      {/* Recordings drawer — right-side floating panel. Listing lives
          inside the component; ChatPage only controls open/close. */}
      <RecordingsPanel
        open={recordingsOpen}
        onClose={() => setRecordingsOpen(false)}
      />

    </div>
  );
}

export default ChatPage;
