# Changelog

All user-facing changes to AinOne Dashboard.

## v1.0.6 — 2026-04-26

### Added

- **BLE device name and UDP audio port are now user-editable.** Both
  used to be hardcoded (BLE always scanned for `ESP32-S3-MultiSensor`,
  audio always listened on UDP 8888) and required a `config.py` edit
  + restart to change. They're now plain inputs in the connection
  panel, persisted to `localStorage` per user. Defaults still match
  the backend constants. The BLE name flows through the existing
  `/api/ble/scan` endpoint (now accepting an optional `device_name`
  in the request body); the audio port was already accepted by
  `/api/audio/start` — only the frontend was hardcoding it.

## v1.0.5 — 2026-04-26

### Changed

- **Attachment ceiling raised to 20 MB end-to-end.** Two layers held
  the previous low caps:
  - Frontend `MAX_TOTAL_ATTACHMENT_BYTES`: 500 KB → 20 MB (this counts
    prompt-bytes, so audio / image attachments still cost ~256 B each
    — the 20 MB is a real text/CSV ceiling, not a binary-file guard).
  - Hono picker default `maxContentBytes`: 50 KB → 1 MB; hard cap
    1 MB → 20 MB. Reasonable text files now inline by default; the
    caller can push up to 20 MB explicitly.

  Past this, Claude's own context window is the binding constraint.

## v1.0.4 — 2026-04-26

### Fixed

- **Audio attachments no longer hit the 500 KB attachment cap.** The
  `MAX_TOTAL_ATTACHMENT_BYTES` guardrail used to count on-disk file
  size, which rejected any audio file larger than 500 KB (a 30 s
  mono WAV is ~960 KB) even though only its URL ever lands in the
  prompt. The cap now measures actual prompt-bytes per attachment
  kind (text inlines content, recording counts CSV preview only,
  image/binary count just the path reference). The displayed pill
  size is unchanged — that's the file size, which is what users
  expect to see.

## v1.0.3 — 2026-04-26

### Fixed

- **"Drag both" from the recordings panel now produces two pills.**
  Previously, dragging both CSV + audio looked like only the CSV had
  been attached: a single recording pill with the CSV filename, and
  the audio info silently buried in metadata. Each file now becomes
  its own visible attachment with its own prompt block, and the
  audio attachment carries the served URL as its path so Claude can
  fetch it from a Bash call.

## v1.0.2 — 2026-04-26

### Added

- **Frontend startup splash.** Vite is ready in ~1 s but the Python
  and Hono backends take longer (especially on first run while
  `pip install` and `npm install` finish). The dashboard now covers
  itself with a loading screen that polls `/api/health` and
  `/api/projects` until both come online, with a per-tier status row
  so the user can see exactly which backend they're waiting on. After
  8 s a "Continue anyway" button appears for the case where one tier
  is intentionally off.

## v1.0.1 — 2026-04-26

Bug-fix release covering issues found in the v1.0.0 first-week test
window. No breaking changes; the wire formats and on-disk recording
layout are unchanged. Drop-in upgrade.

### Fixed

- **Recording timer no longer jumps backward.** The 30 s capture would
  display `27 → 28 → 29 → 28 → 30` and could spontaneously reset to the
  initial duration partway through. Heartbeat re-anchoring (which
  fought a constantly-lagging WS feed) has been removed; the local
  clock is now the sole authority once a session starts. Drift fixes
  are applied only when the tab has clearly fallen behind (≥ 2 s),
  never to nudge the anchor backward.
- **Recording auto-stops at the requested duration.** The frontend now
  self-stops when local elapsed reaches duration, even if the backend's
  heartbeat is delayed; the backend's monitor thread also broadcasts
  the stop event immediately rather than waiting up to 1 s for the
  next periodic tick.
- **Recordings now show up in the chat sidebar.** The recording writer
  was using a CWD-relative path that landed files in
  `backend/recordings/` while the listing API read from
  `<project>/recordings/`. Both ends now read the same path from
  `app.config`.
- **`Recording already in progress` after clicking Start.** Stale
  WebSocket frames from before the user's click could clobber a
  freshly-started session. A 3-second post-action quarantine drops
  any heartbeats whose timing predates the local action.
- **Duration input field no longer collapses to "0".** Backspacing
  the number field used to leave a stuck `0` you couldn't clear; the
  input now stores the raw string and only parses on commit.
- **BLE button label correctly reads "Connecting…" through scan + poll.**
  Previously, when the backend WS pushed `ble.connected = true`
  mid-scan, the button briefly switched to "Disconnecting…". The
  label now follows user intent, not connection state.
- **Serial / BLE / Audio buttons no longer disable each other.** The
  three transports now have independent loading flags.
- **Disconnect stops data immediately.** Bridges previously kept
  emitting frames for ~1-2 s while their teardown finished; an
  explicit running-guard inside the read callbacks drops in-flight
  data the moment the user clicks Disconnect.
- **Embedded terminal mascot stops wrapping.** xterm `lineHeight` was
  fighting cell metrics, mis-positioning the Claude Code spinner
  redraw. Set to 1.0.
- **Chat recordings panel no longer greys out chat.** Removed the
  modal backdrop so drag-to-attach actually reaches the textarea.
- **Sensor card shading is consistent.** Channels with negative-only
  data used to fill *above* the line (Recharts default `baseValue=0`).
  Now anchored to the visible chart bottom for a uniform "area
  under the curve" look across all channels.

### Improved

- **Navigation no longer stutters during recording.** The WebSocket
  subscription and 100 ms recording timer were promoted out of
  `<Dashboard/>` into a top-level `<AppBridge/>` component, so route
  changes no longer tear them down. High-rate sensor / audio frames
  are coalesced into one update per `requestAnimationFrame`, freeing
  the main thread for input. Header navigation is wrapped in
  React 18 `startTransition` so route changes can interrupt pending
  re-renders.
- **Chat recordings sidebar lets you attach individual files.** Each
  session card now exposes three drag handles — *drag CSV*,
  *drag audio*, *drag both* — so you can attach just the readings,
  just the audio, or the full bundle.
- **Custom recording duration.** The duration field accepts any
  value from 1 s to 24 h. Five preset chips (30 s / 1 m / 2 m /
  5 m / 10 m) remain available for one-tap selection.

## v1.0.0 — 2026-04-25

Initial public release.
