/**
 * useTextToSpeech — bind the TTS lib to the call page lifecycle.
 *
 * Persists the user's enable/disable choice in localStorage so it
 * survives page reloads. Cancels any in-flight utterance on unmount
 * and on subsequent speak() calls (the lib does that internally too,
 * but the hook also stops on cleanup).
 *
 * Returns:
 *   enabled    — current toggle state
 *   setEnabled — toggle setter; flipping to false stops any in-flight
 *                utterance immediately
 *   speak      — kicks off TTS for the given text. No-op when disabled.
 *                Strips markdown / 📎 citations / tables before
 *                handing to the engine — see lib/tts.preparePlainText.
 *   stop       — cancel any current utterance
 *   available  — false in browsers without speechSynthesis (legacy
 *                Firefox builds, some embeds). UI uses this to hide
 *                the toggle when there's nothing to toggle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLang } from '../contexts/LanguageContext';
import {
  isTtsAvailable,
  preparePlainText,
  speak as ttsSpeak,
  type SpeakHandle,
} from '../lib/tts';

const STORAGE_KEY = 'call-tts-enabled';

export interface UseTextToSpeechResult {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  speak: (text: string) => void;
  /** Speak `text` and resolve when the utterance finishes (naturally
   *  or via cancel). Resolves immediately when TTS is disabled or
   *  unavailable. Used by the demo player so the timeline pauses on
   *  the reply until the AI has actually finished talking. */
  speakUntilDone: (text: string) => Promise<void>;
  stop: () => void;
  available: boolean;
}

export function useTextToSpeech(): UseTextToSpeechResult {
  const { lang } = useLang();
  const available = isTtsAvailable();

  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (!available) return false;
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const handleRef = useRef<SpeakHandle | null>(null);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
  }, []);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* private mode / quota; ignore */
      }
      if (!next) stop();
    },
    [stop],
  );

  const speak = useCallback(
    (text: string) => {
      if (!enabled || !available) return;
      const plain = preparePlainText(text);
      if (!plain) return;
      handleRef.current?.stop();
      handleRef.current = ttsSpeak(plain, { lang });
    },
    [enabled, available, lang],
  );

  const speakUntilDone = useCallback(
    (text: string): Promise<void> => {
      if (!enabled || !available) return Promise.resolve();
      const plain = preparePlainText(text);
      if (!plain) return Promise.resolve();
      // Replace any prior utterance — both for the visible cancel
      // semantics and to prevent two onEnd promises racing.
      handleRef.current?.stop();
      return new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        handleRef.current = ttsSpeak(plain, {
          lang,
          // Web Speech fires `end` on both natural completion and
          // cancel — either way the caller's wait is done.
          onEnd: settle,
        });
      });
    },
    [enabled, available, lang],
  );

  // Kick voices to load on Chromium — getVoices() returns [] until
  // the engine emits 'voiceschanged'. Calling getVoices() once early
  // primes the cache so the first real speak() has voices ready.
  useEffect(() => {
    if (!available) return;
    window.speechSynthesis.getVoices();
    const onChange = () => {
      // No-op handler — we just want the event to wake the engine.
      // Retrieving voices here would be racy with subsequent speak()
      // calls; lib/tts re-queries inside speak() itself.
    };
    window.speechSynthesis.addEventListener('voiceschanged', onChange);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', onChange);
    };
  }, [available]);

  // Cancel any in-flight utterance when the consumer unmounts (e.g.
  // user navigates away from /call mid-reply).
  useEffect(() => {
    return () => {
      handleRef.current?.stop();
      handleRef.current = null;
    };
  }, []);

  return { enabled, setEnabled, speak, speakUntilDone, stop, available };
}
