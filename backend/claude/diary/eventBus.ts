/**
 * Diary event bus — process-singleton EventEmitter shared between the
 * runner, the scheduler, and the /api/diary/stream NDJSON endpoint.
 *
 * Why an EventEmitter and not a per-request stream: a cron-fired run has
 * no caller to stream into, but its output still needs to reach any open
 * /diary tab. The bus decouples producers from listeners.
 *
 * Memory: setMaxListeners is bumped to 32 — each tab opens one stream
 * consumer; the dashboard plus a second monitoring tab is realistic.
 */

import { EventEmitter } from "node:events";
import type { DiaryEntry } from "../../shared/types.ts";

export type DiaryEventName =
  | "started"
  | "chunk"
  | "new"
  | "error"
  | "read"
  | "deleted";

export interface DiaryStartedEvent {
  type: "started";
  request_id: string;
  agent_id: string;
  trigger: "manual" | "cron" | "event";
  started_at: string; // ISO
}

export interface DiaryChunkEvent {
  type: "chunk";
  request_id: string;
  delta: string;
}

export interface DiaryNewEvent {
  type: "new";
  request_id: string;
  entry: DiaryEntry;
}

export interface DiaryErrorEvent {
  type: "error";
  request_id: string;
  error: string;
  stderr_excerpt?: string;
}

export interface DiaryReadEvent {
  type: "read";
  entry_id: string;
}

export interface DiaryDeletedEvent {
  type: "deleted";
  entry_id: string;
}

export type DiaryEvent =
  | DiaryStartedEvent
  | DiaryChunkEvent
  | DiaryNewEvent
  | DiaryErrorEvent
  | DiaryReadEvent
  | DiaryDeletedEvent;

const bus = new EventEmitter();
bus.setMaxListeners(32);
// Node's EventEmitter has special semantics for the 'error' event: if
// emitted without a direct listener, the process crashes with
// ERR_UNHANDLED_ERROR. We ALSO emit on '*' for the diaryStore to pick
// up, but that doesn't satisfy Node's check. Park a no-op direct
// listener so emitting `{ type: 'error' }` is safe even when no
// stream client is connected.
bus.on("error", () => {});

export const diaryBus = {
  emit(event: DiaryEvent): void {
    bus.emit(event.type, event);
    bus.emit("*", event);
  },

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(listener: (event: DiaryEvent) => void): () => void {
    bus.on("*", listener);
    return () => bus.off("*", listener);
  },
};
