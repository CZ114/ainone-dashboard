// RecordingControls — start / stop a sensor + audio recording session.
//
// State model (see store/index.ts → `recording`):
//   - When idle: this component owns the duration & include-audio choice.
//   - When active: it reads `recording.elapsedSec` / `recording.remainingSec`
//     for display; those are kept fresh by Dashboard's 100 ms tick.
//
// The component never tries to compute time itself. It just kicks
// off the backend, lets the store track the session, and renders
// whatever the store says.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { recordingApi } from '../../api/client';
import { useT, useLang } from '../../contexts/LanguageContext';
import { useAuth, useCan } from '../../contexts/RoleContext';
import { patientsApi, matchPatientByDevice, type Patient } from '../../api/patientsApi';
import { useActivePatient, setActivePatient } from '../../lib/activePatient';

const PRESETS_S = [30, 60, 120, 300, 600];
const MIN_DURATION_S = 1;
const MAX_DURATION_S = 86400; // 24 h
const DEFAULT_DURATION_S = 60;

const formatTime = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
};

const presetLabel = (s: number): string => {
  if (s < 60) return `${s}s`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${(s / 60).toFixed(1)}m`;
};

export function RecordingControls() {
  const t = useT();
  const recording = useStore((state) => state.recording);
  const recordingStart = useStore((state) => state.recordingStart);
  const recordingStop = useStore((state) => state.recordingStop);

  // User input — only used while idle.
  // Duration is held as a STRING so the user can briefly type an
  // empty / partial value (after backspacing all digits) without
  // React snapping it back to "0". A controlled `<input type="number"
  // value={number}>` re-renders 0 the instant Number("") is committed,
  // making the field appear glued to "0" no matter what you type.
  // We parse + validate on Start / blur instead.
  const [durationStr, setDurationStr] = useState<string>(String(DEFAULT_DURATION_S));
  const [includeAudio, setIncludeAudio] = useState(true);
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Patient attribution — auto-match the live device to a patient's bound
  // device name, with a manual dropdown fallback. Resolved id is tagged onto
  // the recording (sidecar) at Start.
  const { lang } = useLang();
  const { auth } = useAuth();
  // Staff (route.patients) may attribute a recording to any patient; a patient
  // records only for themselves, so the cross-patient picker is hidden and
  // attribution locks to their own id.
  const canPickPatients = useCan()('route.patients');
  const activePatient = useActivePatient();   // shared with the chat sidebar
  const bleName = useStore((s) => s.ble.deviceName);
  const serialPort = useStore((s) => s.serial.port);
  const deviceId = bleName || serialPort || '';
  const [patients, setPatients] = useState<Patient[]>([]);
  useEffect(() => {
    if (!canPickPatients) return; // patient can't list others (would 403 anyway)
    patientsApi.list().then(setPatients).catch(() => setPatients([]));
  }, [canPickPatients]);
  const autoMatch = matchPatientByDevice(patients, deviceId);
  useEffect(() => {
    if (canPickPatients) {
      // Staff: adopt an unambiguous device→patient match only when nothing set.
      if (!activePatient && autoMatch) setActivePatient({ id: autoMatch.id, name: autoMatch.name });
    } else if (activePatient?.id !== auth.id) {
      // Patient: attribution is always themselves.
      setActivePatient({ id: auth.id, name: auth.name });
    }
  }, [canPickPatients, activePatient, autoMatch?.id, auth.id, auth.name]);
  const pt =
    lang === 'zh'
      ? {
          label: '归属患者',
          none: '（不绑定 / 未知）',
          auto: (n: string, d: string) => `✓ 已按设备 ${d} 自动识别为 ${n}`,
          noMatch: (d: string) => `设备 ${d} 未匹配到患者，请手动选择`,
          noDev: '未连接设备 —— 可手动选择患者',
        }
      : {
          label: 'Patient',
          none: '(none / unknown)',
          auto: (n: string, d: string) => `✓ Auto-matched to ${n} by device ${d}`,
          noMatch: (d: string) => `Device ${d} matched no patient — pick manually`,
          noDev: 'No device connected — pick a patient manually',
        };

  const clamp = (n: number) =>
    Math.max(MIN_DURATION_S, Math.min(MAX_DURATION_S, Math.round(n)));

  // Parse the input. Returns null if the field is empty / not a finite
  // number; the caller decides whether to surface an error.
  const parseDuration = (): number | null => {
    const trimmed = durationStr.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    return clamp(n);
  };

  // Used by the start button + preset highlight + error display.
  const parsedDuration = (() => {
    const trimmed = durationStr.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  })();
  const isValidDuration =
    parsedDuration !== null &&
    parsedDuration >= MIN_DURATION_S &&
    parsedDuration <= MAX_DURATION_S;

  const handleStart = async () => {
    const d = parseDuration();
    if (d === null) {
      setErrorMsg(t.dashboard.recording.durationError(MIN_DURATION_S, MAX_DURATION_S));
      return;
    }
    // Normalise the input to the clamped value so the user sees what
    // they're actually committing.
    setDurationStr(String(d));
    setErrorMsg(null);
    setBusy('starting');
    try {
      // Patient always attributes to self regardless of the shared context.
      const attrib = canPickPatients ? activePatient : { id: auth.id, name: auth.name };
      await recordingApi.start(d, includeAudio, attrib?.id ?? null, attrib?.name ?? null);
      // Only flip local state ONCE the backend confirms; keeps the UI
      // honest if the POST fails.
      recordingStart(d);
    } catch (e) {
      console.error('[Recording] start failed:', e);
      setErrorMsg(e instanceof Error ? e.message : t.dashboard.recording.startFailed);
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async () => {
    setErrorMsg(null);
    setBusy('stopping');
    try {
      await recordingApi.stop();
    } catch (e) {
      // Even on a 400 ("no recording in progress" — backend already
      // auto-stopped at duration), the right move is to clear local
      // state so the user gets out of the stuck UI.
      console.error('[Recording] stop failed:', e);
    } finally {
      recordingStop();
      setBusy(null);
    }
  };

  const progressPct = recording.duration
    ? Math.min(100, (recording.elapsedSec / recording.duration) * 100)
    : 0;

  return (
    <div className="bg-card-bg rounded-xl p-4 border border-card-border">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-status-disconnected text-lg">⏺</span>
          <span className="font-semibold text-text-primary">{t.dashboard.recording.title}</span>
        </div>
        {recording.active && (
          <div className="flex items-center gap-2">
            <span className="text-status-disconnected animate-pulse">●</span>
            <span className="text-sm text-text-secondary font-mono">
              {formatTime(recording.remainingSec)}
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      {!recording.active ? (
        <div className="space-y-3">
          {/* Duration input */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">
              {t.dashboard.recording.durationLabel}
            </label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={durationStr}
              onChange={(e) => setDurationStr(e.target.value)}
              onBlur={() => {
                // Normalise on blur ONLY if the user typed something
                // valid. Empty / partially-typed text is left alone so
                // the cursor doesn't jump while they're still editing.
                const trimmed = durationStr.trim();
                if (trimmed === '') return;
                const n = Number(trimmed);
                if (Number.isFinite(n)) {
                  setDurationStr(String(clamp(n)));
                }
              }}
              disabled={busy !== null}
              className="w-full bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm font-mono disabled:opacity-50"
              title={t.dashboard.recording.durationTitle(MIN_DURATION_S, MAX_DURATION_S)}
              placeholder={String(DEFAULT_DURATION_S)}
            />
          </div>

          {/* Preset chips */}
          <div className="flex flex-wrap gap-1.5">
            {PRESETS_S.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setDurationStr(String(s))}
                disabled={busy !== null}
                className={`px-2 py-1 text-xs rounded border transition-colors disabled:opacity-50 ${
                  parsedDuration === s
                    ? 'bg-accent/20 border-accent/60 text-text-primary'
                    : 'bg-window-bg border-card-border text-text-secondary hover:border-card-border/80'
                }`}
              >
                {presetLabel(s)}
              </button>
            ))}
          </div>

          {/* Include audio toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeAudio}
              onChange={(e) => setIncludeAudio(e.target.checked)}
              disabled={busy !== null}
              className="w-4 h-4 accent-accent"
            />
            <span className="text-sm text-text-secondary">{t.dashboard.recording.includeAudio}</span>
          </label>

          {/* Patient attribution — staff only. A patient records for themselves
              (attribution locked in handleStart), so no picker is shown. */}
          {canPickPatients && (
            <div>
              <label className="block text-xs text-text-secondary mb-1">{pt.label}</label>
              <select
                value={activePatient?.id ?? ''}
                onChange={(e) => {
                  const p = patients.find((x) => x.id === e.target.value);
                  setActivePatient(p ? { id: p.id, name: p.name } : null);
                }}
                disabled={busy !== null}
                className="w-full bg-window-bg border border-card-border rounded px-3 py-1.5 text-text-primary text-sm disabled:opacity-50"
              >
                <option value="">{pt.none}</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.name}
                    {p.device ? ` (${p.device})` : ''}
                  </option>
                ))}
              </select>
              {autoMatch && activePatient?.id === autoMatch.id && (
                <p className="text-[11px] text-status-connected mt-1">{pt.auto(autoMatch.name, deviceId)}</p>
              )}
              {deviceId && !autoMatch && (
                <p className="text-[11px] text-text-muted mt-1">{pt.noMatch(deviceId)}</p>
              )}
              {!deviceId && <p className="text-[11px] text-text-muted mt-1">{pt.noDev}</p>}
            </div>
          )}

          {/* Start button — disabled when the typed duration parses
              to nothing valid, so an empty field can't slip through. */}
          <button
            onClick={handleStart}
            disabled={busy !== null || !isValidDuration}
            className="w-full bg-accent hover:opacity-90 disabled:opacity-50 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
          >
            {busy === 'starting' ? t.dashboard.recording.starting : t.dashboard.recording.start}
          </button>

          {errorMsg && (
            <div className="text-xs text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-2 py-1">
              {errorMsg}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Progress bar */}
          <div>
            <div className="flex justify-between text-xs text-text-muted mb-1 font-mono">
              <span>{formatTime(recording.elapsedSec)} {t.dashboard.recording.elapsed}</span>
              <span>{formatTime(recording.duration)} {t.dashboard.recording.total}</span>
            </div>
            <div className="h-2 bg-window-bg border border-card-border rounded overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-100"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Stop button */}
          <button
            onClick={handleStop}
            disabled={busy !== null}
            className="w-full bg-status-danger hover:opacity-90 disabled:opacity-50 text-white font-semibold py-2 px-4 rounded-lg transition-colors"
          >
            {busy === 'stopping' ? t.dashboard.recording.stopping : t.dashboard.recording.stop}
          </button>

          {errorMsg && (
            <div className="text-xs text-status-danger bg-status-danger/10 border border-status-danger/30 rounded px-2 py-1">
              {errorMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
