// Glove worn-detection via GSR self-calibration.
//
// The device streams a `gsr_filtered` channel (skin-conductance ADC). When the
// glove is worn, skin closes the circuit and the value settles into a stable
// mid-range (observed worn means ~1969 / 2404 / 2061 across sessions); with the
// glove OFF the circuit is open and the value sits at a distinctly different
// level. Because the absolute worn level varies by device / person / session,
// we do NOT hardcode a threshold. Instead the user calibrates once (capture the
// value glove-off, then glove-on); worn = the live value is on the "on" side of
// the unworn↔worn midpoint. Calibration persists in localStorage.

import { useSyncExternalStore } from 'react';
import type { ChannelData } from '../types';

export interface GsrCalib {
  unworn: number; // averaged gsr with the glove off
  worn: number;   // averaged gsr with the glove on
  ts: number;     // when calibrated (epoch ms)
}

const LS_KEY = 'glove.gsrCalib.v1';
const CH_KEY = 'glove.gsrChannel.v1';

function load(): GsrCalib | null {
  try {
    const s = localStorage.getItem(LS_KEY);
    return s ? (JSON.parse(s) as GsrCalib) : null;
  } catch {
    return null;
  }
}

let calib: GsrCalib | null = load();
// Manual GSR-channel override. Live ESP32 frames are often unnamed (CH1..CHN)
// when the firmware's header line was sent before the backend subscribed, so
// name-matching /gsr/ fails even though the data is present. The user can then
// point us at the right channel by name; we remember it.
let gsrChannel: string | null = (() => {
  try {
    return localStorage.getItem(CH_KEY);
  } catch {
    return null;
  }
})();
const listeners = new Set<() => void>();

export function getGsrChannel(): string | null {
  return gsrChannel;
}

export function setGsrChannel(name: string | null): void {
  gsrChannel = name;
  try {
    if (name) localStorage.setItem(CH_KEY, name);
    else localStorage.removeItem(CH_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function useGsrChannel(): string | null {
  return useSyncExternalStore(subscribe, getGsrChannel, getGsrChannel);
}

export function getCalib(): GsrCalib | null {
  return calib;
}

export function setCalib(c: GsrCalib | null): void {
  calib = c;
  try {
    if (c) localStorage.setItem(LS_KEY, JSON.stringify(c));
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* localStorage unavailable — keep in-memory only */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Reactive hook: the current calibration, shared across all components. */
export function useCalib(): GsrCalib | null {
  return useSyncExternalStore(subscribe, getCalib, getCalib);
}

/**
 * Read the live gsr value from the channel list (null if no channel).
 * A manual override (set when frames are unnamed CH1..CHN) wins; otherwise we
 * name-match /gsr/. On the override, if the exact name has vanished (channel
 * set changed) we fall back to name-matching rather than silently returning null.
 */
export function readGsr(channels: ChannelData[]): number | null {
  if (gsrChannel) {
    const picked = channels.find((ch) => ch.name === gsrChannel);
    if (picked) return picked.value;
  }
  const c = channels.find((ch) => /gsr/i.test(ch.name));
  return c ? c.value : null;
}

/** worn = the value is on the "worn" side of the unworn↔worn midpoint. */
export function isWorn(gsr: number, c: GsrCalib): boolean {
  const mid = (c.unworn + c.worn) / 2;
  return c.worn >= c.unworn ? gsr >= mid : gsr <= mid;
}

/** Gap between the two calibration points — small gap = untrustworthy. */
export function calibGap(c: GsrCalib): number {
  return Math.abs(c.worn - c.unworn);
}

/**
 * Sample the live gsr value for `ms`, return the average (null if no data).
 * Reads the store lazily to always get the freshest frame at call time.
 */
export async function captureGsr(
  getChannels: () => ChannelData[],
  ms = 1500,
): Promise<number | null> {
  const samples: number[] = [];
  const start = Date.now();
  return new Promise((resolve) => {
    const id = setInterval(() => {
      const g = readGsr(getChannels());
      if (g != null && Number.isFinite(g)) samples.push(g);
      if (Date.now() - start >= ms) {
        clearInterval(id);
        resolve(samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null);
      }
    }, 80);
  });
}
