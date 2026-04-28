# Project context for Claude Code

This is the **ESP32 Sensor Dashboard** — part of a lab project building a
wearable + companion platform for early-AD prediction research.

## Read this first

All developer-facing design docs, debug post-mortems, guides, and learning
notes live under `docs/`. The layout and querying conventions are defined
in the `research-log` skill (`.claude/skills/research-log/SKILL.md`). That
skill auto-loads when relevant — trust it for "where to find X" questions.

> **Naming note**: the *research log* (this dev wiki) is unrelated to the
> *Diary* feature inside the dashboard product. Diary is a user-facing
> AI observation timeline; the research log is a developer artifact about
> the repo. Don't conflate the two.

Quick orientation:

- **`docs/specs/main-spec.md`** — full project spec (architecture, all features)
- **`docs/plans/lab-integration.md`** — multi-repo integration model
- **`docs/specs/`** — current and proposed feature designs
- **`docs/journeys/`** — debugging history (immutable; grep for prior landmines)
- **`README.md`** — quick-start (build / run instructions)

## Three pillars

When evaluating a new feature request, identify which pillar it serves:

1. **Data analysis** — sensor visualization, recordings, channel waveforms
2. **System settings** — extensions, AI agent config, knowledge management
3. **Report generation** — chat with Claude, diary, formal reports

If a request doesn't fit any pillar, surface that mismatch to the user.

## Stack snapshot

- **FastAPI** (`:8080`) — hardware I/O (Serial / BLE / UDP audio), recordings,
  extension manager, WebSocket fan-out at 50 Hz
- **Hono** (`:3000`) — wraps `@anthropic-ai/claude-agent-sdk`, SSE chat,
  embedded terminal via `node-pty`, session/conversation management
- **React + Vite** (`:5173`) — `/dashboard`, `/chat`, `/settings`; Zustand
  state; Recharts waveforms

## Conventions

- Docs under `docs/` always have YAML frontmatter (`type`, `status`,
  `last_updated`, `tags`) — see the research-log skill for details
- Debug journeys are **append-only history** — never edit after `status: archived`
- Specs progress: `draft → active → shipped`; update on implementation milestones
- Bug fix landed → write a journey under `docs/journeys/` with a TL;DR up top
- Extension implementations follow `backend/app/extensions/whisper_local.py`
  as the reference pattern (lifecycle, config schema, status reporting)
- This is a research prototype, not production — don't over-engineer scale
