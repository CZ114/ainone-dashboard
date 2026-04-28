/**
 * Diary scheduler — runs daily on a HH:MM schedule using setInterval(60s).
 *
 * Spec §11 phase 2: simple HH:MM, no cron expressions. Daily quota
 * enforcement and event triggers are deferred to phase 3.
 *
 * Catch-up rule (spec §12 risk 2): if the host was off when the schedule
 * fired, we run a delayed entry on boot.
 */

import { logger } from "../utils/logger.ts";
import {
  patchConfig,
  readConfig,
} from "./store.ts";
import { runAndPersist } from "./orchestrator.ts";

const TICK_MS = 60_000;

let tickHandle: ReturnType<typeof setInterval> | null = null;
let inFlight: AbortController | null = null;

function todayDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD local-ish (UTC-day)
}

function formatHHMM(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function inQuietHours(now: Date, quiet?: [string, string]): boolean {
  if (!quiet || quiet.length !== 2) return false;
  const [start, end] = quiet;
  const t = formatHHMM(now);
  // start == end disables; otherwise simple lex compare with wrap-around.
  if (start === end) return false;
  if (start < end) return t >= start && t < end;
  // Wraps midnight: e.g. "22:00" - "08:00".
  return t >= start || t < end;
}

async function tick(opts: { boot?: boolean } = {}): Promise<void> {
  const cfg = await readConfig();
  if (!cfg.enabled) return;
  if (!cfg.schedule.daily) return;

  const now = new Date();
  if (inQuietHours(now, cfg.notification.quiet_hours)) return;

  const todayStr = todayDate();
  const lastRunDay = cfg.last_run?.daily?.date;
  const alreadyRanToday = lastRunDay === todayStr;
  const scheduledTime = cfg.schedule.daily.time; // "HH:MM"
  const nowHHMM = formatHHMM(now);

  let shouldRun = false;
  let delayed = false;

  if (opts.boot) {
    // Boot catch-up: schedule has already fired today and we missed it.
    if (!alreadyRanToday && nowHHMM >= scheduledTime) {
      shouldRun = true;
      delayed = true;
    }
  } else {
    // Tick: only run when minute matches, once per day.
    if (!alreadyRanToday && nowHHMM === scheduledTime) {
      shouldRun = true;
    }
  }

  if (!shouldRun) return;

  if (inFlight) {
    logger.chat.warn("[diary scheduler] previous run still in flight, skipping");
    return;
  }

  logger.chat.info(
    `[diary scheduler] ${delayed ? "delayed catch-up" : "tick"} firing daily at ${nowHHMM}`,
  );

  inFlight = new AbortController();
  try {
    const res = await runAndPersist({
      trigger: "cron",
      agentId: cfg.schedule.daily.agent_id,
      delayed,
      signal: inFlight.signal,
    });
    if (res.ok && res.entry) {
      await patchConfig({
        last_run: {
          ...(cfg.last_run ?? {}),
          daily: { date: todayStr, entry_id: res.entry.id },
        },
      });
    }
  } catch (err) {
    logger.chat.error(`[diary scheduler] run threw: ${err}`);
  } finally {
    inFlight = null;
  }
}

export function init(): void {
  if (tickHandle) return; // idempotent — guards HMR / double init
  logger.chat.info("[diary scheduler] init");
  // Boot catch-up once, then start ticking.
  void tick({ boot: true }).catch((err) =>
    logger.chat.error(`[diary scheduler] boot catch-up failed: ${err}`),
  );
  tickHandle = setInterval(() => {
    void tick().catch((err) =>
      logger.chat.error(`[diary scheduler] tick failed: ${err}`),
    );
  }, TICK_MS);
  // Tick handle is process-lifetime; unref so it doesn't keep node alive on
  // SIGINT in test runs.
  tickHandle.unref?.();
}

export function shutdown(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  inFlight?.abort();
}
