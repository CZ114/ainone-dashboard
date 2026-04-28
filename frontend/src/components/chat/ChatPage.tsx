// Chat Page component - Claude Code chat interface with proper session handling

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useChatStore } from '../../store/chatStore';
import { claudeApi } from '../../api/claudeApi';
import { useStreamParser } from '../../hooks/useStreamParser';
import { ChatMessages, LoadingIndicator } from './ChatMessages';
import { ChatInput } from './ChatInput';
import { ChatSidebar, canonicalCwd } from './ChatSidebar';
// v4 API names: Group / Panel / Separator (not the v3 PanelGroup /
// PanelResizeHandle). Imperative handle for collapse/expand is the
// nested Panel.PanelImperativeHandle type.
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  usePanelRef,
} from 'react-resizable-panels';
import { NewProjectDialog } from './NewProjectDialog';
import { RecordingsPanel } from './RecordingsPanel';
import { EmbeddedTerminal } from '../shell/EmbeddedTerminal';
import { Header } from '../layout/Header';
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

// Storage key shape: `diary-handoff:<entry-id>`. Set by DiaryPage's
// Reply button right before navigating here. We pull it out on mount
// to render the pinned context card and to know which entry should
// be injected as `additionalSystemPrompt` on the FIRST chat send.
const DIARY_HANDOFF_PREFIX = 'diary-handoff:';

interface DiaryHandoff {
  entry_id: string;
  cwd: string;
  // DEAD CODE — see docs/specs/diary.md "Dead code / debt".
  additional_system_prompt: string;
  entry_title: string;
  entry_body: string;
  entry_created_at: string;
  entry_agent_id: string;
  entry_model: string;
}

function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams();
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

  // Diary -> chat handoff. When the diary "Reply" button navigates here
  // with ?from=diary&entryId=<id>, we pull the handoff blob stashed in
  // sessionStorage by DiaryPage. We:
  //   1. Render a pinned, read-only context card above the messages so
  //      the user understands what's loaded (cleaner than dumping the
  //      entry body into the input box).
  //   2. Override workingDirectory and additionalSystemPrompt for the
  //      FIRST send so the new chat session is created under the
  //      diary-replies cwd (groups it under one project label in the
  //      sidebar) and Claude receives the entry as background.
  // Subsequent turns inherit the conversation from --resume — no need
  // to keep re-injecting the system prompt.
  const [diaryHandoff, setDiaryHandoff] = useState<DiaryHandoff | null>(null);
  const [diaryHandoffConsumed, setDiaryHandoffConsumed] = useState(false);
  // Mirror state into refs so handleSend (a stable useCallback whose dep
  // array intentionally excludes most React state to keep its identity
  // stable across renders) sees the LATEST handoff at send time. Without
  // this, the closure captured at component-mount sees handoff=null and
  // the first send goes out without additionalSystemPrompt — Claude
  // ends up grounded in the cwd's git context instead of the diary entry.
  const diaryHandoffRef = useRef<DiaryHandoff | null>(null);
  const diaryHandoffConsumedRef = useRef<boolean>(false);
  useEffect(() => {
    diaryHandoffRef.current = diaryHandoff;
  }, [diaryHandoff]);
  useEffect(() => {
    diaryHandoffConsumedRef.current = diaryHandoffConsumed;
  }, [diaryHandoffConsumed]);
  useEffect(() => {
    const fromDiary = searchParams.get('from') === 'diary';
    const entryId = searchParams.get('entryId');
    if (!fromDiary || !entryId) return;
    const key = DIARY_HANDOFF_PREFIX + entryId;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(key);
    } catch {
      raw = null;
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as DiaryHandoff;
        // CRITICAL: wipe any chat state left over from the previous
        // /chat visit. Otherwise the diary reply tries to send into
        // the stale sessionId — which the chat handler treats as
        // `--resume <real-uuid>` and the SDK errors out
        // ("No conversation found"). Also clears the messages list so
        // the pinned diary card isn't sandwiched against an unrelated
        // earlier conversation.
        const chatState = useChatStore.getState();
        chatState.clearMessages();
        chatState.setSessionId(null);
        chatState.setDisplaySessionId(null);
        chatState.setTemporarySessionId(null);
        chatState.setError(null);
        setDiaryHandoff(parsed);
        pushToast('Diary entry loaded — type your question to start', 'info');
      } catch {
        /* malformed — ignore */
      }
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    // Clean the URL so a refresh doesn't try to re-load the handoff
    // (which we just consumed).
    const next = new URLSearchParams(searchParams);
    next.delete('from');
    next.delete('entryId');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Right panel collapse state. Replaces the old `sidebarOpen` /
  // `recordingsOpen` drawer toggles — chat history + recordings now
  // live together inside one resizable Panel on the right. Collapsing
  // it gives the chat the full width ("focus mode"). Persisted to
  // localStorage so the choice survives reloads.
  const rightPanelRef = usePanelRef();
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('chat-right-panel-collapsed') === '1';
    } catch {
      return false;
    }
  });
  // On first mount, if the user previously chose focus mode, collapse
  // the right panel so it matches the persisted preference. Imperative
  // refs aren't ready synchronously during initial render, so we run
  // this after layout. Empty dep array — only fires once.
  useEffect(() => {
    if (rightCollapsed) {
      // Microtask delay so the Panel has registered its imperative
      // handle by the time we call it.
      queueMicrotask(() => rightPanelRef.current?.collapse());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    // Read the diary handoff from refs (NOT from useState closures) so
    // we always see the latest values. handleSend's dep array is
    // intentionally minimal for identity stability, which means a
    // closure read of the useState would be stale.
    const currentHandoff = diaryHandoffRef.current;
    const currentConsumed = diaryHandoffConsumedRef.current;
    const inDiaryFirstSend = !!currentHandoff && !currentConsumed;

    // First send of a diary-reply chat: PREPEND the entry body inline
    // to the user's message. We tried `appendSystemPrompt` first (would
    // be invisible in chat history), but the SDK's `claude_code`
    // preset apparently doesn't surface it to the model — Claude ended
    // up using Bash/Read tools to find the diary on disk instead.
    // Inlining the entry into the first user message guarantees Claude
    // sees it and persists it in the session JSONL so subsequent
    // --resume turns also have the context.
    let effectiveMessage = message;
    if (inDiaryFirstSend) {
      const dateStr = (() => {
        try {
          return new Date(currentHandoff!.entry_created_at).toLocaleString();
        } catch {
          return currentHandoff!.entry_created_at;
        }
      })();
      const quotedBody = currentHandoff!.entry_body
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n');
      const preface =
        `📓 _Loaded from diary entry written ${dateStr} (agent: ` +
        `${currentHandoff!.entry_agent_id}, model: ` +
        `${currentHandoff!.entry_model})._\n\n` +
        `${quotedBody}\n\n---\n\n`;
      effectiveMessage = preface + message;
    }

    // Synthesize the final prompt: fenced text bodies + image/other
    // path references + the user's typed message. Shows the user
    // exactly-what-they-typed in the message bubble (not the synthesized
    // prompt), since that's closer to the mental model.
    const wirePrompt = buildPromptWithAttachments(effectiveMessage, attachments);

    // Display message is the user's typed text, plus a discreet summary
    // of what was attached. Prevents a jarring "my message now has
    // 50 lines of code in it" bubble. For a first-send diary reply we
    // show the prepended preface in the bubble too — that way the
    // conversation history stays consistent across page reloads (the
    // JSONL has the full text, so a refreshed view would otherwise
    // contradict the live view).
    const displayText =
      attachments.length === 0
        ? effectiveMessage
        : `${effectiveMessage}${effectiveMessage ? '\n\n' : ''}` +
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

    // Determine working directory - use project's cwd, unless this is
    // a diary-reply session that's never been sent in (use the
    // diary-replies cwd so the new chat lands in that project group).
    const workingDir = (() => {
      if (inDiaryFirstSend) {
        return currentHandoff!.cwd;
      }
      if (projects.length > 0 && projects[0].path) {
        return projects[0].path;
      }
      return undefined;
    })();

    if (inDiaryFirstSend) {
      console.log('[diary] first-turn inline preface', {
        cwd: currentHandoff!.cwd,
        bodyChars: currentHandoff!.entry_body.length,
      });
    }

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
      diaryFirstSend: inDiaryFirstSend,
      promptCharsAfterPreface: wirePrompt.length,
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

      // Mark the diary handoff as spent so subsequent sends in this
      // session don't re-prepend the diary preface (Claude has the
      // entry inline in the conversation history now and --resume
      // rehydrates it on every later turn).
      if (inDiaryFirstSend) {
        setDiaryHandoffConsumed(true);
      }

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
        openSidebar: () => {
          // History/recordings now live in the embedded right panel.
          // If the user collapsed it, the slash command expands it
          // back so they can see what they asked for.
          rightPanelRef.current?.expand();
          setRightCollapsed(false);
        },
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

      {/* Top nav — same Header used by Dashboard / Diary / Settings so
          the user always has Dashboard / Chat / Diary tabs visible. */}
      <Header />

      {/* Chat-specific subheader — project / session info + chat-only
          actions (terminal toggle, clear chat, focus mode). Sits below
          the unified <Header> nav. */}
      <div className="bg-card-bg/60 border-b border-card-border px-6 py-2 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2 shrink-0">
              💬 Claude Code Chat
              {isThinking && (
                <span className="flex items-center gap-1 text-xs text-accent-soft font-normal">
                  <span className="w-2 h-2 bg-accent-soft rounded-full animate-pulse" />
                  working...
                </span>
              )}
            </h2>
            <p className="text-xs text-text-muted truncate flex items-center gap-2 min-w-0">
              {currentProjectName && (
                <span className="text-text-secondary truncate">
                  📁 {currentProjectName}
                </span>
              )}
              <span className="shrink-0">
                {displaySessionId
                  ? `Session: ${displaySessionId.slice(0, 8)}…`
                  : sessionId
                  ? `Session: ${sessionId.slice(0, 8)}…`
                  : 'New conversation'}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {terminalCwd && (
              <div className="flex items-center gap-0.5 p-0.5 bg-card-border/30 rounded-md">
                <button
                  onClick={() => setViewMode('chat')}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    viewMode === 'chat'
                      ? 'bg-accent text-white'
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
                      ? 'bg-accent-soft text-text-primary'
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
                className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-card-border/50 rounded transition-colors"
              >
                Clear Chat
              </button>
            )}
            <button
              onClick={() => {
                if (rightCollapsed) {
                  rightPanelRef.current?.expand();
                  setRightCollapsed(false);
                  try { localStorage.setItem('chat-right-panel-collapsed', '0'); } catch {}
                } else {
                  rightPanelRef.current?.collapse();
                  setRightCollapsed(true);
                  try { localStorage.setItem('chat-right-panel-collapsed', '1'); } catch {}
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-card-border/50 rounded transition-colors"
              title={rightCollapsed ? 'Show history / recordings panel' : 'Hide right panel (focus mode)'}
              aria-label={rightCollapsed ? 'Show right panel' : 'Hide right panel'}
            >
              <span>{rightCollapsed ? '◀' : '▶'}</span>
              <span className="hidden sm:inline">
                {rightCollapsed ? 'Show panel' : 'Focus mode'}
              </span>
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
      <PanelGroup orientation="horizontal" className="flex-1 flex">
        {/* LEFT panel — chat + terminal. Two views toggle via
            viewMode; the inactive one is kept mounted via display:none
            so its state (chat scroll / typed input / xterm scroll-back
            / live PTY) survives tab switches. */}
        <Panel id="chat-main" defaultSize={70} minSize={40} className="flex flex-col">
          <div
            className={`flex-1 flex flex-col overflow-hidden ${
              viewMode === 'chat' ? '' : 'hidden'
            }`}
            aria-hidden={viewMode !== 'chat'}
          >
            {error && (
              <div className="mx-auto mt-4 w-full px-4">
                <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              </div>
            )}

            {/* Scrollable messages area. Note: max-w-4xl removed
                because the panel layout already constrains width via
                the user-resizable boundary; an inner cap would just
                re-introduce the empty whitespace we set out to fix. */}
            <div className="flex-1 overflow-y-auto">
              <div className="w-full px-4 py-4">
                {/* Pinned diary-context card — visible BEFORE the
                    first send only. After the user types and sends,
                    the diary entry is inlined as a quoted preface in
                    the first user-message bubble (and persisted in
                    the JSONL), so a separate card would be redundant. */}
                {diaryHandoff && !diaryHandoffConsumed && (
                  <DiaryContextCard
                    handoff={diaryHandoff}
                    consumed={diaryHandoffConsumed}
                    onDismiss={() => setDiaryHandoff(null)}
                  />
                )}

                {isLoadingHistory ? (
                  // Match the empty-chat centring so loading and
                  // empty states feel like the same kind of UI rather
                  // than a tiny spinner adrift at the top.
                  <div className="min-h-[60vh] flex flex-col items-center justify-center text-text-muted">
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

          {terminalCwd && (
            <div
              className={`flex-1 flex flex-col overflow-hidden ${
                viewMode === 'terminal' ? '' : 'hidden'
              }`}
              aria-hidden={viewMode !== 'terminal'}
            >
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
                  onExit={() => {}}
                />
              </div>
            </div>
          )}
        </Panel>

        {/* Drag handle between chat and right panel — subtle 4px
            line that turns blue on hover so the user gets affordance
            feedback before clicking. */}
        <PanelResizeHandle className="w-1 bg-card-border hover:bg-accent/60 active:bg-accent transition-colors cursor-col-resize" />

        {/* RIGHT panel — chat history (with embedded search) on top,
            recordings + audio previews on bottom, internal vertical
            resize handle between them. Collapsible via the header
            "Focus mode" button: rightPanelRef.collapse() / .expand(). */}
        <Panel
          id="chat-right"
          panelRef={rightPanelRef}
          defaultSize={30}
          minSize={18}
          collapsible
          collapsedSize={0}
          className="flex flex-col"
        >
          <PanelGroup orientation="vertical" className="flex-1 flex flex-col">
            <Panel id="right-history" defaultSize={55} minSize={20} className="flex flex-col">
              <ChatSidebar
                sessions={sessions}
                extraProjects={extraProjects}
                onSelectSession={handleSelectSession}
                onNewChatInProject={handleNewChatInProject}
                onDeleteProject={handleDeleteProject}
                onLaunchTerminal={handleLaunchTerminal}
                onSessionDeleted={handleSessionDeleted}
                currentSessionId={sessionId}
                onOpenNewProjectDialog={() => setShowNewProjectDialog(true)}
              />
            </Panel>
            <PanelResizeHandle className="h-1 bg-card-border hover:bg-accent/60 active:bg-accent transition-colors cursor-row-resize" />
            <Panel id="right-recordings" defaultSize={45} minSize={20} className="flex flex-col">
              <RecordingsPanel />
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>

      {/* New project dialog — top-level modal, unaffected by the
          panel layout. */}
      <NewProjectDialog
        open={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
        onSubmit={(abs) => handleNewProject(abs)}
      />

    </div>

  );
}

// Pinned read-only context card shown at the top of the message area
// when this chat was opened from a diary entry's Reply button. While
// the handoff is unconsumed (i.e. the user hasn't sent yet), the card
// signals that the next send will be tagged with the diary entry as
// `additionalSystemPrompt`. Once consumed it stays visible so the user
// remembers what the chat is grounded in, but the badge changes.
function DiaryContextCard({
  handoff,
  consumed,
  onDismiss,
}: {
  handoff: DiaryHandoff;
  consumed: boolean;
  onDismiss: () => void;
}) {
  let formattedDate = handoff.entry_created_at;
  try {
    formattedDate = new Date(handoff.entry_created_at).toLocaleString(
      undefined,
      { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' },
    );
  } catch {
    /* keep ISO fallback */
  }
  return (
    <div className="mb-3 rounded-lg border border-accent/40 bg-accent/5 p-4 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-text-muted">
          <span aria-hidden>📓</span>
          <span className="font-medium text-text-secondary">Diary context</span>
          <span aria-hidden>·</span>
          <span>{formattedDate}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{handoff.entry_agent_id}</span>
          <span
            className={`ml-1 rounded px-1.5 py-0.5 ${
              consumed
                ? 'bg-card-border/40 text-text-muted'
                : 'bg-accent/20 text-accent'
            }`}
          >
            {consumed ? 'in conversation' : 'will be loaded on send'}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-text-muted hover:text-text-primary"
          title="Hide this card (Claude still has the context)"
          aria-label="Dismiss diary context card"
        >
          ✕
        </button>
      </div>
      {handoff.entry_title && (
        <div className="mb-1 font-semibold text-text-primary">
          {handoff.entry_title}
        </div>
      )}
      <div className="max-h-48 overflow-y-auto whitespace-pre-wrap text-text-secondary">
        {handoff.entry_body}
      </div>
    </div>
  );
}

export default ChatPage;
