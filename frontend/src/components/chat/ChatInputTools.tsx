// Chat input toolbar — the strip directly below the textarea.
//
// Layout:
//   [ + ] [ / ]    📁 <cwd display>    [ Mode ] [ Thinking ] [ Effort ]
//         attach    current project        cycling pills each persist
//         slash
//
// Each pill is a cycling button: click cycles through the enum; the
// visible label + colored dot reflect the current choice. Modes that
// mean "omit the field over the wire" (i.e. "default") render in
// neutral gray so the user knows nothing is being forced.
//
// Token-budget & thinking defaults are kept inside chatStore; we just
// read and write via setters here.

import { useChatStore, VOICE_LANGS } from '../../store/chatStore';
import { getDisplayName } from './ChatSidebar';
import { ChatAudioStatus } from './ChatAudioStatus';
import type {
  PermissionModeValue,
  ThinkingModeValue,
  EffortModeValue,
} from '../../store/chatStore';

interface ChatInputToolsProps {
  cwd: string | null;
  onAttachClick: () => void;
  onSlashClick: () => void;
  onMicClick: () => void;
  onEsp32MicClick: () => void;
  attachBusy?: boolean;
  // 'idle' — ready to start
  // 'listening' — actively capturing speech (renders red pulse)
  // 'error' — last attempt failed; button still clickable to retry
  micState: 'idle' | 'listening' | 'error';
  // When false, the browser lacks SpeechRecognition — render the
  // button disabled with an explanatory tooltip.
  micSupported: boolean;
  // True when the Whisper-local backend extension is installed and
  // enabled. Shows a secondary "ESP32" mic button that routes audio
  // through backend transcription rather than the browser.
  esp32MicAvailable: boolean;
  // True while the ESP32 WS session is active — pulses the button.
  esp32MicListening: boolean;
  // Called whenever the user cycles a mode pill. ChatPage uses this to
  // push an explanatory toast — without it, the user changes a setting
  // and has no feedback about what the new value actually does.
  onModeChangeAnnounce?: (text: string) => void;
}

// --- Cycling order definitions ---------------------------------------

const PERMISSION_CYCLE: PermissionModeValue[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
];
const THINKING_CYCLE: ThinkingModeValue[] = ['default', 'enabled', 'disabled'];
const EFFORT_CYCLE: EffortModeValue[] = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function nextInCycle<T>(cycle: T[], current: T): T {
  const idx = cycle.indexOf(current);
  return cycle[(idx + 1) % cycle.length];
}

// --- Display config --------------------------------------------------

// Label shape:
//   value    — short string used in the pill: e.g. "Ask"
//   detail   — single-sentence behavioral explanation. Shown in the
//              tooltip AND pushed as a toast when the user cycles to
//              this value, so they get immediate feedback about what
//              they just turned on.
//   dot      — tailwind bg class for the colored indicator
//
// The pill's visible text is `${CATEGORY}: ${value}` so every pill is
// self-describing even without hovering.
interface ModeMeta {
  value: string;
  detail: string;
  dot: string;
}

const PERMISSION_META: Record<PermissionModeValue, ModeMeta> = {
  default: {
    value: 'Ask',
    detail:
      'Ask — Claude asks before running anything potentially destructive. ' +
      'Safest for exploratory work.',
    dot: 'bg-gray-400',
  },
  plan: {
    value: 'Plan',
    detail:
      'Plan — Claude drafts a plan and proposes changes WITHOUT executing. ' +
      'Useful for review-before-act workflows.',
    dot: 'bg-blue-400',
  },
  acceptEdits: {
    value: 'Auto-Edit',
    detail:
      'Auto-Edit — file edits go through silently; other risky ops (shell, ' +
      'network) still prompt.',
    dot: 'bg-green-400',
  },
  bypassPermissions: {
    value: 'Bypass',
    detail:
      'Bypass — every permission check is skipped; Claude runs fully ' +
      'autonomously. Use only in a trusted sandbox / project.',
    dot: 'bg-orange-400',
  },
};

const THINKING_META: Record<ThinkingModeValue, ModeMeta> = {
  default: {
    value: 'Auto',
    detail:
      'Auto — lets the model decide when to think (adaptive on Opus 4.6+, ' +
      'off on older models). Best default.',
    dot: 'bg-gray-400',
  },
  enabled: {
    value: 'On',
    detail:
      'On — forces extended thinking with a 10 000-token budget. Slower but ' +
      'more deliberate on hard problems.',
    dot: 'bg-purple-400',
  },
  disabled: {
    value: 'Off',
    detail: 'Off — disables extended thinking entirely. Fastest; best for simple tasks.',
    dot: 'bg-amber-400',
  },
};

const EFFORT_META: Record<EffortModeValue, ModeMeta> = {
  default: {
    value: 'Auto',
    detail: 'Auto — lets the model pick an effort level per prompt.',
    dot: 'bg-gray-400',
  },
  low: {
    value: 'Low',
    detail: 'Low — fastest, cheapest; skips deep exploration.',
    dot: 'bg-sky-400',
  },
  medium: {
    value: 'Med',
    detail: 'Medium — balanced default for most tasks.',
    dot: 'bg-blue-400',
  },
  high: {
    value: 'High',
    detail: 'High — more passes / deeper reasoning; slower, more expensive.',
    dot: 'bg-purple-400',
  },
  xhigh: {
    value: 'xHigh',
    detail: 'xHigh — extra-high effort for genuinely hard problems.',
    dot: 'bg-pink-400',
  },
  max: {
    value: 'Max',
    detail: 'Max — maximum effort. Reserve for tricky debugging / planning.',
    dot: 'bg-red-400',
  },
};

// --- Voice language picker --------------------------------------------

function VoiceLangPicker() {
  const voiceLang = useChatStore((s) => s.voiceLang);
  const setVoiceLang = useChatStore((s) => s.setVoiceLang);
  const active = VOICE_LANGS.find((l) => l.code === voiceLang) ?? VOICE_LANGS[0];
  return (
    <div className="relative flex items-center">
      {/* Native select stacked on top of a compact visual chip. The
          select is transparent + absolutely positioned so the chip
          handles the look while the browser still provides its
          normal dropdown UI. */}
      <div
        className="flex items-center gap-1 h-7 px-1.5 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors pointer-events-none select-none"
        title={`Voice input language: ${active.label} (${active.code}). Click to change.`}
      >
        <span className="font-mono">🌐 {active.short}</span>
      </div>
      <select
        value={voiceLang}
        onChange={(e) => setVoiceLang(e.target.value)}
        aria-label="Voice input language"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      >
        {VOICE_LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label} ({l.code})
          </option>
        ))}
      </select>
    </div>
  );
}

// --- Pill subcomponent ------------------------------------------------

interface PillProps {
  icon: string;
  category: string;        // "Perm" / "Think" / "Effort" — visible prefix
  value: string;           // "Ask" / "On" / "High"
  dotClass: string;
  title: string;
  onClick: () => void;
}

function Pill({ icon, category, value, dotClass, title, onClick }: PillProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
      <span>{icon}</span>
      <span>
        <span className="text-text-muted">{category}:</span>{' '}
        <span className="font-medium">{value}</span>
      </span>
    </button>
  );
}

// --- Main ------------------------------------------------------------

export function ChatInputTools({
  cwd,
  onAttachClick,
  onSlashClick,
  onMicClick,
  onEsp32MicClick,
  attachBusy = false,
  micState,
  micSupported,
  esp32MicAvailable,
  esp32MicListening,
  onModeChangeAnnounce,
}: ChatInputToolsProps) {
  const permissionMode = useChatStore((s) => s.permissionMode);
  const thinkingMode = useChatStore((s) => s.thinkingMode);
  const effortMode = useChatStore((s) => s.effortMode);
  const setPermissionMode = useChatStore((s) => s.setPermissionMode);
  const setThinkingMode = useChatStore((s) => s.setThinkingMode);
  const setEffortMode = useChatStore((s) => s.setEffortMode);

  const pm = PERMISSION_META[permissionMode];
  const tm = THINKING_META[thinkingMode];
  const em = EFFORT_META[effortMode];

  // Cycle handlers — each bumps the store AND echoes the new value's
  // full `detail` string via the announce callback so the user gets
  // immediate, human-language feedback about what they just enabled.
  const cyclePermission = () => {
    const next = nextInCycle(PERMISSION_CYCLE, permissionMode);
    setPermissionMode(next);
    onModeChangeAnnounce?.(PERMISSION_META[next].detail);
  };
  const cycleThinking = () => {
    const next = nextInCycle(THINKING_CYCLE, thinkingMode);
    setThinkingMode(next);
    onModeChangeAnnounce?.(THINKING_META[next].detail);
  };
  const cycleEffort = () => {
    const next = nextInCycle(EFFORT_CYCLE, effortMode);
    setEffortMode(next);
    onModeChangeAnnounce?.(EFFORT_META[next].detail);
  };

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 bg-card-bg/50 border-t border-card-border/50 text-xs select-none">
      {/* Left — attach + slash triggers */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          onClick={onAttachClick}
          disabled={attachBusy}
          className="w-7 h-7 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors disabled:opacity-50"
          title="Attach file(s) — opens OS file picker"
          aria-label="Attach file"
        >
          {attachBusy ? (
            <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
            </svg>
          )}
        </button>
        <button
          onClick={onSlashClick}
          className="w-7 h-7 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-card-border/50 transition-colors font-mono text-sm"
          title="Insert / to open the slash-command menu"
          aria-label="Open slash commands"
        >
          /
        </button>
        {/* Voice language picker — BCP-47 code for SpeechRecognition.
            Compact native <select> so all platforms render a familiar
            OS dropdown. Change takes effect on next mic start; if the
            user swaps language while listening they'll need to click
            the mic off / on (auto-restart after onend reads the fresh
            store value so language change propagates quickly anyway). */}
        <VoiceLangPicker />
        {/* Mic button — browser SpeechRecognition → textarea. Three
            states: disabled (unsupported browser), idle (🎤), listening
            (🔴 pulsing). Click while listening stops; we do NOT
            auto-send so the user can review and correct before Enter. */}
        <button
          onClick={onMicClick}
          disabled={!micSupported}
          className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
            !micSupported
              ? 'text-text-muted opacity-40 cursor-not-allowed'
              : micState === 'listening'
              ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20'
              : 'text-text-secondary hover:text-text-primary hover:bg-card-border/50'
          }`}
          title={
            !micSupported
              ? 'Voice input not supported in this browser (try Chrome / Edge).'
              : micState === 'listening'
              ? 'Click to stop recording. Auto-filled into the textarea — press Enter to send.'
              : 'Click to record voice (browser-local speech recognition, zh-CN).'
          }
          aria-label={
            micState === 'listening' ? 'Stop voice input' : 'Start voice input'
          }
        >
          {micState === 'listening' ? (
            <span className="relative flex items-center justify-center">
              <span className="w-2 h-2 bg-red-400 rounded-full" />
              <span className="absolute w-2 h-2 bg-red-400 rounded-full animate-ping opacity-75" />
            </span>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
            </svg>
          )}
        </button>
        {/* ESP32 microphone — only visible once the Whisper-local
            extension is installed + enabled. Wired to backend UDP
            transcription in Phase C3; for now it just announces. */}
        {esp32MicAvailable && (
          <button
            onClick={onEsp32MicClick}
            className={`h-7 px-2 flex items-center gap-1 rounded transition-colors text-[11px] ${
              esp32MicListening
                ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20'
                : 'text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10'
            }`}
            title={
              esp32MicListening
                ? 'Click to stop ESP32 transcription.'
                : 'Transcribe the ESP32 UDP audio stream via Whisper-local.'
            }
            aria-label={
              esp32MicListening ? 'Stop ESP32 mic' : 'Start ESP32 mic'
            }
          >
            {esp32MicListening ? (
              <span className="relative flex items-center justify-center w-3.5 h-3.5">
                <span className="w-2 h-2 bg-red-400 rounded-full" />
                <span className="absolute w-2 h-2 bg-red-400 rounded-full animate-ping opacity-75" />
              </span>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
              </svg>
            )}
            <span className="font-medium">ESP32</span>
          </button>
        )}
        {/* ESP32 UDP audio meter — auto-renders nothing if audio not
            connected, so it doesn't hog space for users who never
            start the UDP listener. Same WS data pipeline as the
            Dashboard page, so values are live across tabs. */}
        <ChatAudioStatus />
      </div>

      {/* Middle — current working directory */}
      <div className="flex-1 min-w-0 text-center text-text-muted truncate">
        {cwd ? (
          <span title={cwd}>📁 {getDisplayName(cwd)}</span>
        ) : (
          <span className="opacity-0">—</span>
        )}
      </div>

      {/* Right — mode pills. Each pill cycles through its enum; the
          colored dot + category prefix + value keep the current
          selection self-explanatory without hovering. */}
      <div className="flex items-center gap-0.5 shrink-0">
        <Pill
          icon="🛡️"
          category="Perm"
          value={pm.value}
          dotClass={pm.dot}
          title={`${pm.detail}\n\nClick to cycle through permission modes.`}
          onClick={cyclePermission}
        />
        <Pill
          icon="💡"
          category="Think"
          value={tm.value}
          dotClass={tm.dot}
          title={`${tm.detail}\n\nClick to cycle: Auto → On → Off.`}
          onClick={cycleThinking}
        />
        <Pill
          icon="⚡"
          category="Effort"
          value={em.value}
          dotClass={em.dot}
          title={`${em.detail}\n\nClick to cycle: Auto → Low → Med → High → xHigh → Max.`}
          onClick={cycleEffort}
        />
      </div>
    </div>
  );
}
