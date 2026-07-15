/**
 * useVad — voice-activity-detection trigger driven by the same level
 * ref the orb / waveform read.
 *
 * State machine:
 *
 *   idle ── level > onsetThreshold for `onsetMs` ─▶ active
 *   active ── level < silenceThreshold for `silenceMs` ─▶ idle
 *
 * Edge events:
 *   - 'speech-start' fires once when entering 'active'  → CallPage calls transcriber.begin()
 *   - 'speech-end'   fires once when leaving 'active'   → CallPage calls transcriber.end()
 *
 * Why thresholds are separate (`onsetThreshold` > `silenceThreshold`):
 * classic Schmitt trigger / hysteresis. Using a single threshold makes
 * the trigger flap on every level wobble around the cutoff. Two
 * thresholds need a louder cue to start than to maintain, which kills
 * flicker in noisy environments.
 *
 * Why durations on both sides (`onsetMs`, `silenceMs`): a single brief
 * peak (like a cough) shouldn't open a turn, and a single brief
 * silence (a breath mid-sentence) shouldn't close one. Both edges
 * require the threshold to be sustained.
 *
 * The hook reads the `levelRef.current.rms` value each rAF — same
 * ref the orb consumes — so it's free of allocations and runs at
 * exactly the frame rate the user sees.
 */

import { useEffect, useRef } from 'react';
import type { AudioLevel } from './useAudioLevel';

export interface UseVadOptions {
  enabled: boolean;
  levelRef: React.MutableRefObject<AudioLevel>;
  /** Level above which we consider speech started. 0..1. */
  onsetThreshold?: number;
  /** Level below which we consider speech ended. Must be < onset. */
  silenceThreshold?: number;
  /** Sustained-onset duration (ms) before firing speech-start. */
  onsetMs?: number;
  /** Sustained-silence duration (ms) before firing speech-end. */
  silenceMs?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}

export function useVad({
  enabled,
  levelRef,
  onsetThreshold = 0.18,
  silenceThreshold = 0.10,
  onsetMs = 220,
  silenceMs = 1100,
  onSpeechStart,
  onSpeechEnd,
}: UseVadOptions): void {
  // Stash the latest callbacks in refs so the rAF loop doesn't have
  // to be torn down every time a parent re-renders.
  const onStartRef = useRef(onSpeechStart);
  const onEndRef = useRef(onSpeechEnd);
  useEffect(() => {
    onStartRef.current = onSpeechStart;
  }, [onSpeechStart]);
  useEffect(() => {
    onEndRef.current = onSpeechEnd;
  }, [onSpeechEnd]);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let active = false;
    // When `null`, we're not currently in a "candidate" window for a
    // transition. When set, it's the ms-time the candidate began —
    // we transition once `now - candidateSince >= durationMs`.
    let candidateSince: number | null = null;

    const tick = () => {
      const now = performance.now();
      const level = levelRef.current.rms;

      if (!active) {
        // Looking for onset.
        if (level >= onsetThreshold) {
          if (candidateSince === null) candidateSince = now;
          else if (now - candidateSince >= onsetMs) {
            active = true;
            candidateSince = null;
            onStartRef.current?.();
          }
        } else {
          candidateSince = null;
        }
      } else {
        // Looking for offset.
        if (level <= silenceThreshold) {
          if (candidateSince === null) candidateSince = now;
          else if (now - candidateSince >= silenceMs) {
            active = false;
            candidateSince = null;
            onEndRef.current?.();
          }
        } else {
          candidateSince = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [
    enabled,
    levelRef,
    onsetThreshold,
    silenceThreshold,
    onsetMs,
    silenceMs,
  ]);
}
