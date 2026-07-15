/**
 * useReplay — drives the dashboard channels from a recorded CSV.
 *
 * State machine:
 *
 *   idle ─load(file)─▶ loading ─success─▶ paused ◀── pause()
 *                            │                       │
 *                            └─error─▶ error         ▼
 *                                                  playing
 *                                                    │
 *                                                    ▼
 *                                                  finished ─play()─▶ playing (restart)
 *                                                    │
 *                                                    └─stop()─▶ idle
 *
 * Implementation: a single rAF loop, ticking even when paused only
 * to keep timing refs consistent. While playing, each frame:
 *
 *   1. compute replayTime = wallClockElapsed × speed + offset
 *   2. binary-search the row index at replayTime
 *   3. slice a backwards window of `points_per_channel` rows for
 *      the waveform
 *   4. transpose the slice into per-channel waveforms; recompute
 *      min/max/avg stats
 *   5. push everything through `store.updateSensorData(...)` —
 *      the same entry point the live WebSocket fan-out uses, so
 *      ChannelGrid renders without knowing or caring about replay
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import {
  buildClipCsv,
  downloadCsv,
  findRowAt,
  loadReplay,
  type ReplayData,
} from '../lib/replay';

export type ReplayState =
  | 'idle'
  | 'loading'
  | 'paused'
  | 'playing'
  | 'finished'
  | 'error';

export interface UseReplayResult {
  state: ReplayState;
  error: string | null;
  /** ms within the recording. */
  currentMs: number;
  /** Total recording length in ms. */
  totalMs: number;
  /** Playback speed multiplier (1 = real-time). */
  speed: number;
  /** Loaded recording's channel names — useful for the UI to label
   *  controls or show what's about to play. Empty before load. */
  channelNames: string[];

  load: (csvFilename: string) => Promise<void>;
  play: () => void;
  pause: () => void;
  /** Stop playback and rewind to 0, but keep the recording loaded so
   *  the transport UI stays visible and play() can resume without
   *  re-fetching. To fully unload, call `clear()`. */
  stop: () => void;
  /** Fully unload the recording — drop parsed rows, clear channel
   *  names, return to `'idle'`. The picker's empty option calls this
   *  so the dashboard isn't held by a recording the user deselected. */
  clear: () => void;
  setSpeed: (next: number) => void;
  /** Jump to a specific time in the recording. ms-precision. */
  seek: (ms: number) => void;
  /** Slice the loaded recording from `startMs` to `endMs` and trigger
   *  a browser download of the result as a fresh CSV. No-op if no
   *  recording is loaded. */
  exportClip: (startMs: number, endMs: number, suggestedName?: string) => void;
}

export function useReplay(): UseReplayResult {
  const updateSensorData = useStore((s) => s.updateSensorData);
  const pointsPerChannel = useStore((s) => s.settings.points_per_channel);
  const setReplayActive = useStore((s) => s.setReplayActive);

  const [state, setState] = useState<ReplayState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [speed, setSpeedState] = useState(1);
  const [channelNames, setChannelNames] = useState<string[]>([]);

  // Refs used by the rAF loop. State for these would force ~60 React
  // re-renders/sec while playing, which the orb already costs us once;
  // we don't need to double up.
  const dataRef = useRef<ReplayData | null>(null);
  const rafRef = useRef<number>(0);
  const wallStartRef = useRef<number>(0);
  const offsetMsRef = useRef<number>(0);
  const speedRef = useRef<number>(1);
  const pointsRef = useRef<number>(pointsPerChannel);
  // Keep the latest points-per-channel inside the rAF closure.
  useEffect(() => {
    pointsRef.current = pointsPerChannel;
  }, [pointsPerChannel]);

  const renderFrame = useCallback(
    (replayTime: number) => {
      const data = dataRef.current;
      if (!data || data.rows.length === 0) return;
      const idx = findRowAt(data.rows, replayTime);
      const windowSize = Math.max(1, pointsRef.current);
      const startIdx = Math.max(0, idx - windowSize + 1);
      const numChannels = data.channelNames.length;

      const values = data.rows[idx].values;
      const waveforms: number[][] = new Array(numChannels);
      const minArr: number[] = new Array(numChannels);
      const maxArr: number[] = new Array(numChannels);
      const avgArr: number[] = new Array(numChannels);

      for (let c = 0; c < numChannels; c++) {
        const samples: number[] = new Array(idx - startIdx + 1);
        let mn = Infinity;
        let mx = -Infinity;
        let sum = 0;
        let count = 0;
        for (let i = startIdx; i <= idx; i++) {
          const v = data.rows[i].values[c] ?? 0;
          samples[i - startIdx] = v;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          sum += v;
          count++;
        }
        waveforms[c] = samples;
        minArr[c] = mn === Infinity ? 0 : mn;
        maxArr[c] = mx === -Infinity ? 0 : mx;
        avgArr[c] = count > 0 ? sum / count : 0;
      }

      updateSensorData(data.channelNames, values, waveforms, {
        min: minArr,
        max: maxArr,
        avg: avgArr,
      });
    },
    [updateSensorData],
  );

  const tick = useCallback(
    (now: number) => {
      const data = dataRef.current;
      if (!data) return;
      const elapsedWall = now - wallStartRef.current;
      const replayTime = offsetMsRef.current + elapsedWall * speedRef.current;

      if (replayTime >= data.totalMs) {
        // Render the final frame, then stop and flag finished.
        renderFrame(data.totalMs);
        setCurrentMs(data.totalMs);
        setState('finished');
        rafRef.current = 0;
        return;
      }

      renderFrame(replayTime);
      setCurrentMs(replayTime);
      rafRef.current = requestAnimationFrame(tick);
    },
    [renderFrame],
  );

  const load = useCallback(async (csvFilename: string) => {
    setState('loading');
    setError(null);
    try {
      const data = await loadReplay(csvFilename);
      dataRef.current = data;
      offsetMsRef.current = 0;
      setCurrentMs(0);
      setTotalMs(data.totalMs);
      setChannelNames(data.channelNames);
      // Mute the live WS feed so a still-streaming ESP32 doesn't
      // overwrite the replay we're about to start. Cleared in
      // stop() and on unmount.
      setReplayActive(true);
      // Render the first frame immediately so the dashboard isn't
      // empty before the user hits play.
      renderFrame(0);
      setState('paused');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }, [renderFrame, setReplayActive]);

  const play = useCallback(() => {
    const data = dataRef.current;
    if (!data) return;
    // If the playhead is already at the end, restart from zero on play.
    if (state === 'finished' || offsetMsRef.current >= data.totalMs) {
      offsetMsRef.current = 0;
      setCurrentMs(0);
    }
    speedRef.current = speed;
    wallStartRef.current = performance.now();
    setState('playing');
    // Re-engage the live-WS gate. Stop() clears it (so live data can
    // flow back into the channel grid once the user exits replay
    // mode); pressing Play again means replay is driving the grid
    // once more, so live frames must be muted.
    setReplayActive(true);
    if (rafRef.current === 0) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [state, speed, tick, setReplayActive]);

  const pause = useCallback(() => {
    if (rafRef.current !== 0) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    // Snapshot current playhead so resume continues from here.
    offsetMsRef.current = currentMs;
    setState('paused');
  }, [currentMs]);

  // Stop = rewind + pause, but keep `dataRef` loaded. This is what
  // a media-player Stop usually means; it also keeps the transport
  // UI visible so the user doesn't lose the progress bar / clip-export
  // controls just because they hit Stop. To fully unload, call
  // `clear()` (which the picker's empty option does).
  //
  // Stop ALSO releases the live-WS mute. While the recording is loaded
  // and the user is actively replaying or paused mid-stream, replay is
  // driving the channel grid and live ESP32 frames must be dropped or
  // they'll fight the rAF. Once the user hits Stop, they've exited
  // replay mode — the dashboard should accept live data again, even
  // though the recording stays loaded for a future Play. Without this
  // release, clicking Connect on Serial/BLE after Stop *looks* hung:
  // connection_status flips green but the channel grid stays frozen
  // on the rewound frame because sensor_data is still being gated.
  const stop = useCallback(() => {
    if (rafRef.current !== 0) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (!dataRef.current) {
      // Nothing loaded — fall through to a defensive idle reset so
      // an accidental stop() before load doesn't leave dangling refs.
      offsetMsRef.current = 0;
      setCurrentMs(0);
      setState('idle');
      setReplayActive(false);
      return;
    }
    offsetMsRef.current = 0;
    setCurrentMs(0);
    // Re-render the first frame so the dashboard reflects the rewind
    // visually — otherwise channels stay frozen at wherever the user
    // hit Stop.
    renderFrame(0);
    setState('paused');
    setReplayActive(false);
  }, [renderFrame, setReplayActive]);

  const clear = useCallback(() => {
    if (rafRef.current !== 0) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    dataRef.current = null;
    offsetMsRef.current = 0;
    setCurrentMs(0);
    setTotalMs(0);
    setChannelNames([]);
    setState('idle');
    setError(null);
    setReplayActive(false);
  }, [setReplayActive]);

  const setSpeed = useCallback(
    (next: number) => {
      // When changing speed mid-playback, anchor offset to the current
      // playhead so the next frame doesn't suddenly jump backwards or
      // forwards. Without this, changing 1× → 2× would re-evaluate
      // `(elapsedWall × newSpeed) + oldOffset` and skip ahead.
      if (state === 'playing') {
        offsetMsRef.current = currentMs;
        wallStartRef.current = performance.now();
      }
      speedRef.current = next;
      setSpeedState(next);
    },
    [state, currentMs],
  );

  const seek = useCallback(
    (ms: number) => {
      const data = dataRef.current;
      if (!data) return;
      const clamped = Math.max(0, Math.min(data.totalMs, ms));
      offsetMsRef.current = clamped;
      wallStartRef.current = performance.now();
      setCurrentMs(clamped);
      // Re-render at the new position even when paused, so scrubbing
      // updates the dashboard without needing to press play.
      renderFrame(clamped);
      // Scrubbing pulls the user back into replay (a non-zero frame
      // is on screen). Re-engage the live-WS mute — Stop() may have
      // cleared it, so without this a sensor frame can land between
      // the seek's renderFrame and the next rAF tick and overwrite
      // the scrubbed frame.
      setReplayActive(true);
      // If we landed past the end while playing, drop into 'finished'
      // so the UI shows the right state.
      if (clamped >= data.totalMs && state === 'playing') {
        if (rafRef.current !== 0) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        setState('finished');
      }
    },
    [renderFrame, state, setReplayActive],
  );

  const exportClip = useCallback(
    (startMs: number, endMs: number, suggestedName?: string) => {
      const data = dataRef.current;
      if (!data) return;
      const csv = buildClipCsv(data, startMs, endMs);
      const name =
        suggestedName ??
        `clip_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
      downloadCsv(csv, name);
    },
    [],
  );

  // rAF + replay-active cleanup on unmount. Without clearing the WS
  // mute on unmount, navigating away from the dashboard mid-replay
  // would leave the gate in place forever — chat/diary pages
  // wouldn't notice (they don't read sensor_data) but coming back to
  // the dashboard would show a frozen channel grid.
  useEffect(() => {
    return () => {
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      setReplayActive(false);
    };
  }, [setReplayActive]);

  return {
    state,
    error,
    currentMs,
    totalMs,
    speed,
    channelNames,
    load,
    play,
    pause,
    stop,
    clear,
    setSpeed,
    seek,
    exportClip,
  };
}
