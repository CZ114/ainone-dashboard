/**
 * useTranscriber — unified speech-to-text driver for the call page.
 *
 * Both ESP32 and Mic sources do record-then-transcribe via Whisper —
 * mic now goes through the same raw-PCM code path as ESP32 instead
 * of the WebM/Opus → pyav round-trip MediaRecorder used to take.
 *
 *   - 'esp32': begin() → POST /api/voice/clip/start (server starts
 *     buffering UDP audio, seeded from its 800 ms preroll ring).
 *     end() → POST /api/voice/clip/stop, server transcribes the full
 *     PCM clip and returns text.
 *
 *   - 'mic': begin() / end() drive a PcmCapture instance — a Web Audio
 *     AudioWorklet that always-on captures 16 kHz mono PCM16 with an
 *     800 ms rolling preroll. On end() we ship the assembled PCM to
 *     POST /api/voice/transcribe-pcm, which calls the same
 *     transcribe_pcm_clip whisper-local entrypoint as ESP32.
 *
 * Why PCM + preroll instead of MediaRecorder:
 *
 *   1. MediaRecorder.start() has 50–200 ms of codec-init delay that
 *      ate the user's first word every turn.
 *   2. WebM/Opus → pyav decode → Whisper added 100–400 ms of avoidable
 *      latency and a tiny accuracy hit on quiet speech.
 *   3. The new path matches the ESP32 path, so both sources feel
 *      identical from a user's POV.
 *
 * Lifecycle:
 *
 *   ┌─────────┐  begin()    ┌────────────┐  end()     ┌───────────────┐
 *   │  idle   │ ─────────▶  │ recording  │ ─────────▶ │ transcribing  │
 *   └─────────┘             └────────────┘            └───────────────┘
 *        ▲                                                   │
 *        └────────── reset() / consumeText() ────────────────┘
 *
 * `state === 'transcribing'` lets the UI show a thinking hint without
 * forking on source.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceApi } from '../api/voiceApi';
import { PcmCapture } from '../lib/pcmCapture';

export type TranscriberState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'error';

export interface UseTranscriberOptions {
  /** Source picked by the user via the CallPage toggle. */
  source: 'esp32' | 'mic' | 'synthetic';
  /** BCP-47 lang to pin (en-US / zh-CN); '' = auto. */
  lang?: string;
  /** Fired when the turn's transcript is finalised + non-empty.
   *  Used by CallPage to forward the text into Claude. */
  onFinalized?: (text: string) => void;
}

export interface UseTranscriberResult {
  state: TranscriberState;
  text: string;
  error: string | null;
  /** Mark the start of a turn (PTT down or VAD onset). */
  begin: () => void;
  /** Mark the end of a turn (PTT up or VAD silence). */
  end: () => void;
  /** Clear text and revert to idle without firing onFinalized. */
  reset: () => void;
}

export function useTranscriber({
  source,
  lang,
  onFinalized,
}: UseTranscriberOptions): UseTranscriberResult {
  const [state, setState] = useState<TranscriberState>('idle');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Persistent PCM capture for the mic source. Opened the moment the
  // user picks 'mic' (so getUserMedia + worklet load happen once, not
  // per-turn) and torn down on source switch / unmount. The instance
  // owns its own AudioContext + MediaStream + worklet node; this hook
  // only holds a reference.
  const pcmCaptureRef = useRef<PcmCapture | null>(null);
  const onFinalizedRef = useRef(onFinalized);
  useEffect(() => {
    onFinalizedRef.current = onFinalized;
  }, [onFinalized]);

  /* ────────────────── Mic mode: PcmCapture ────────────────── */

  // Initialise the worklet pipeline once the user picks Mic. We do
  // this asynchronously and stash the instance only when ready, so a
  // first-turn race resolves cleanly:
  //   - If begin() fires before init resolves, we surface a "mic not
  //     ready" error rather than silently dropping the turn.
  //   - The "click PTT" UX is fine because audio level + permission
  //     prompt typically settle within a few hundred ms; the user
  //     hasn't pressed yet.
  useEffect(() => {
    if (source !== 'mic') return;
    let cancelled = false;
    const cap = new PcmCapture();
    (async () => {
      try {
        await cap.init();
        if (cancelled) {
          await cap.dispose();
          return;
        }
        pcmCaptureRef.current = cap;
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
        // Always dispose on init failure — leaves no orphan tracks.
        await cap.dispose();
      }
    })();
    return () => {
      cancelled = true;
      const inst = pcmCaptureRef.current;
      pcmCaptureRef.current = null;
      // Drop any in-flight recording so a cancelled effect doesn't
      // resolve a stale `end()` promise after we've moved on.
      cap.cancel();
      if (inst === cap) {
        void inst.dispose();
      } else {
        // init never finished — dispose the local instance directly.
        void cap.dispose();
      }
    };
  }, [source]);

  /* ─────────────────── Public lifecycle methods ─────────────────── */

  const begin = useCallback(() => {
    setError(null);
    setText('');

    if (source === 'esp32') {
      // Tell the server to start buffering UDP audio. We optimistically
      // flip to 'recording' synchronously — the API call is fire-and-
      // forget from the user's POV, and a slow network would otherwise
      // make the orb look unresponsive.
      setState('recording');
      void voiceApi.clipStart().catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setState('error');
      });
      return;
    }

    if (source === 'mic') {
      const cap = pcmCaptureRef.current;
      if (!cap || !cap.ready) {
        // Init still in flight (rare — first turn within ~200ms of
        // switching source). Surface clearly so the user knows to
        // release and try again rather than wondering why nothing
        // transcribed.
        setError('Mic still warming up — release and try again.');
        setState('error');
        return;
      }
      try {
        cap.begin();
        setState('recording');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState('error');
      }
      return;
    }

    // synthetic: there's nothing to transcribe — keep state at 'idle'
    // so the UI doesn't pretend something happened.
  }, [source]);

  const end = useCallback(() => {
    if (source === 'esp32') {
      // Server already has the buffered audio; ask it to transcribe
      // and return text. While the response is in flight we live in
      // 'transcribing' so the UI can show its loading indicator.
      setState('transcribing');
      void (async () => {
        try {
          const result = await voiceApi.clipStop(lang);
          const finalText = result.text.trim();
          if (finalText) {
            setText(finalText);
            setState('idle');
            onFinalizedRef.current?.(finalText);
          } else {
            // No speech detected — back to idle silently.
            setState('idle');
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setState('error');
        }
      })();
      return;
    }

    if (source === 'mic') {
      const cap = pcmCaptureRef.current;
      if (!cap || !cap.ready) {
        setState('idle');
        return;
      }
      setState('transcribing');
      void (async () => {
        try {
          // Worklet posts back the assembled Int16 PCM (preroll +
          // live samples). Empty array = the user pressed PTT for
          // such a brief moment that nothing landed; treat as silence.
          const pcm = await cap.end();
          if (pcm.length === 0) {
            setState('idle');
            return;
          }
          // Ship raw PCM16 to the same Whisper code path the ESP32
          // source uses. No codec round-trip on the backend.
          const result = await voiceApi.transcribePcm(pcm, lang);
          const finalText = result.text.trim();
          if (finalText) {
            setText(finalText);
            setState('idle');
            onFinalizedRef.current?.(finalText);
          } else {
            // Silence / no recognized speech.
            setState('idle');
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setState('error');
        }
      })();
      return;
    }
  }, [source, lang]);

  const reset = useCallback(() => {
    setText('');
    setError(null);
    setState('idle');
  }, []);

  return { state, text, error, begin, end, reset };
}
