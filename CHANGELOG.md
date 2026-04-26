# Changelog

All user-facing changes to AinOne Dashboard.

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
