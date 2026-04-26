// Thin wrapper around the browser Web Speech API (SpeechRecognition).
//
// This is the **local / zero-cost** voice input path: browsers with
// speech support (Chromium family — Chrome, Edge, Opera — and recent
// Safari) run recognition against a system-provided model, fully in
// the browser, no API keys. The server-side ESP32 Whisper path is
// unrelated (handled by the Whisper extension later on).
//
// API surface intentionally small:
//   - isSpeechRecognitionSupported() : feature-detect before showing mic
//   - startSpeechRecognition(lang, cb): begin continuous recognition
//
// The wrapper emits delta `final` events (new final text since the
// last event) and replaces `interim` on every event — that matches
// how a caller would want to append-confirmed, replace-live.

// The spec's shape. TS doesn't ship types for SpeechRecognition in
// lib.dom for all target versions; defining the minimal shape we use
// keeps us off `any`. If the project upgrades lib.dom later these can
// be deleted.
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string; confidence: number };
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message?: string;
}
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((evt: SpeechRecognitionEventLike) => void) | null;
  onerror: ((evt: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getCtor() !== null;
}

export interface SpeechRecognitionCallbacks {
  // Newly-finalized text since the previous event. Caller typically
  // appends this to a running buffer.
  onFinal?: (deltaText: string) => void;
  // Current interim transcript (replaces the previous interim). Empty
  // string means "no active interim" — caller should clear any UI hint.
  onInterim?: (currentInterim: string) => void;
  // One of the spec error codes: "no-speech", "audio-capture",
  // "not-allowed", "aborted", "network", etc. Caller renders a friendly
  // explanation based on the code.
  onError?: (errorCode: string) => void;
  // Fires when recognition actually begins (after user grants mic
  // permission). Useful for flipping UI into "listening" state.
  onStart?: () => void;
  // Fires after stop() / abort() / natural end. UI should reset here —
  // Chrome sometimes stops continuous recognition on long silences.
  onEnd?: () => void;
}

export interface SpeechRecognitionHandle {
  stop: () => void;
  abort: () => void;
}

// Log helper. Use console.log (not debug) so the trace is visible
// without requiring users to enable the "Verbose" filter in DevTools.
// Browsers mute `debug` by default; users trying to diagnose a broken
// mic need to see this output at the default console level.
function sr_log(tag: string, ...args: unknown[]): void {
  console.log(`[speech] ${tag}`, ...args);
}

/**
 * Pre-flight microphone check. Requests a short-lived audio stream via
 * `getUserMedia`, samples its level for a moment, and immediately
 * releases it. Returns diagnostic information the caller can surface
 * to the user when SpeechRecognition later behaves weirdly.
 *
 * `rmsDb === -Infinity` usually means the device grant succeeded but
 * no audio is actually reaching the browser (muted / wrong device).
 */
export interface MicDiagnostic {
  ok: boolean;
  reason?: string;           // populated when ok === false
  deviceLabel?: string;      // which mic the browser picked
  rmsDb?: number;            // best RMS level seen during the probe
  sampled: boolean;          // did we actually sample audio?
}

export async function preflightMicrophone(
  sampleMs = 400,
): Promise<MicDiagnostic> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: 'getUserMedia not available', sampled: false };
  }

  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = (err as Error).name || 'unknown';
    const msg = (err as Error).message || '';
    sr_log('preflight getUserMedia rejected:', name, msg);
    let reason = `Mic access failed: ${name}`;
    if (name === 'NotAllowedError') reason = 'Microphone permission was denied. Click the lock icon in the address bar and allow it.';
    else if (name === 'NotFoundError') reason = 'No microphone detected. Plug one in / check OS sound settings.';
    else if (name === 'NotReadableError') reason = 'Another app is holding the microphone. Close it and retry.';
    return { ok: false, reason, sampled: false };
  }

  const track = stream.getAudioTracks()[0];
  const label = track?.label || '(unnamed device)';
  sr_log('preflight got stream from device:', label);

  let maxRmsDb = -Infinity;
  try {
    const AC: typeof AudioContext =
      (window as unknown as { AudioContext: typeof AudioContext }).AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AC();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const start = Date.now();
    while (Date.now() - start < sampleMs) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const db = 20 * Math.log10(rms + 1e-10);
      if (db > maxRmsDb) maxRmsDb = db;
      await new Promise((r) => setTimeout(r, 25));
    }
    sr_log(`preflight max RMS during ${sampleMs}ms window: ${maxRmsDb.toFixed(1)} dB`);
  } catch (err) {
    sr_log('preflight analyser setup failed:', err);
    return {
      ok: true,                        // permission is fine; just couldn't sample
      deviceLabel: label,
      sampled: false,
    };
  } finally {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch { /* ignore */ }
    try {
      audioCtx?.close();
    } catch { /* ignore */ }
  }

  return {
    ok: true,
    deviceLabel: label,
    rmsDb: maxRmsDb,
    sampled: true,
  };
}

export function startSpeechRecognition(
  lang: string,
  cb: SpeechRecognitionCallbacks,
): SpeechRecognitionHandle {
  const Ctor = getCtor();
  if (!Ctor) {
    throw new Error('SpeechRecognition not supported in this browser');
  }
  const rec = new Ctor();
  rec.lang = lang;
  rec.continuous = true;        // keep listening across pauses
  rec.interimResults = true;    // stream partials for live display
  rec.maxAlternatives = 1;
  sr_log('config', { lang, continuous: true, interimResults: true });

  rec.onstart = () => {
    sr_log('onstart — recognition is live (user granted mic access)');
    cb.onStart?.();
  };
  rec.onend = () => {
    sr_log('onend — session ended');
    cb.onEnd?.();
  };

  rec.onresult = (evt) => {
    let newFinal = '';
    let currentInterim = '';
    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const result = evt.results[i];
      if (!result || result.length === 0) continue;
      const transcript = result[0].transcript || '';
      if (result.isFinal) newFinal += transcript;
      else currentInterim += transcript;
    }
    sr_log('onresult', {
      resultIndex: evt.resultIndex,
      totalResults: evt.results.length,
      newFinal,
      currentInterim,
    });
    if (newFinal) cb.onFinal?.(newFinal);
    // Always call onInterim — an empty string is meaningful (clear hint).
    cb.onInterim?.(currentInterim);
  };

  rec.onerror = (evt) => {
    sr_log('onerror', { error: evt.error, message: evt.message });
    cb.onError?.(evt.error || 'unknown');
  };

  try {
    rec.start();
    sr_log('start() called — waiting for onstart');
  } catch (err) {
    sr_log('start() threw synchronously', err);
    throw err;
  }

  return {
    stop: () => {
      sr_log('caller invoked stop()');
      try {
        rec.stop();
      } catch {
        /* ignore — already stopped */
      }
    },
    abort: () => {
      sr_log('caller invoked abort()');
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

// Which error codes should be suppressed from user-facing notices.
// `no-speech` fires every ~5-8 s of silence in continuous mode on
// Chromium; `aborted` is the normal result of us calling stop().
// Callers should auto-restart on `no-speech` if they want to keep
// listening — Chrome ends the session on this error.
export const SILENT_SPEECH_ERRORS = new Set(['no-speech', 'aborted']);

// User-facing explanation for each spec error code. Keep terse — shown
// in a toast / inline hint, not a full dialog.
export function explainSpeechError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission denied. Grant access in your browser settings and try again.';
    case 'no-speech':
      return 'No speech detected. Try speaking louder or closer to the mic.';
    case 'audio-capture':
      return 'No microphone found. Plug one in or check your OS audio device.';
    case 'network':
      return 'Browser speech service is unreachable (network issue).';
    case 'aborted':
      return 'Recognition was cancelled.';
    default:
      return `Speech recognition error: ${code}`;
  }
}
