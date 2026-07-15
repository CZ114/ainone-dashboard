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

## Knowledge vault (Obsidian)

The same `docs/` tree is also exposed as an Obsidian vault at
`D:\Imperial\individual\plaformDev`. Inside the vault, `project-docs/` is a
Windows junction → this repo's `docs/`, so edits sync both ways. The vault
adds a navigation layer:

- `Hub.md` — main entry; links to MOCs / Pillars / Bases / Canvas
- `MOCs/` — hand-curated indexes by type (Specs / Plans / Guides / Journeys /
  Learn) and by pillar (1 / 2 / 3)
- `Bases/` — declarative views auto-derived from frontmatter
  (`All Docs`, `Active Specs`, `Journey Index`, `Stale Docs`)
- `Canvas/Architecture.canvas` — visual three-stack + dataflow diagram
- `Templates/` — `Spec`, `Journey`, `Guide` templates with the required
  frontmatter contract

### Which tool to reach for

- Plain `Read` / `Edit` / `Write` (or the `research-log` skill) — single
  known file, or Obsidian is closed.
- `obsidian:obsidian-cli` skill — when Obsidian is running and you need
  cross-doc context (graph, backlinks, base filters, templates). Prefer this
  when starting a new task so you enter through `Hub.md` → MOC → drill.

### Cheapest navigation path (use top-down)

```bash
obsidian read file="Hub"
obsidian read file="Pillar 1 — Data Analysis"      # or relevant pillar
obsidian read path="Bases/Active Specs.base"       # what's currently active
obsidian search query="<topic>" limit=5
obsidian read file="<spec-name>"                   # only after narrowing
```

### Write-back after a journey lands

```bash
obsidian create \
  path="project-docs/journeys/YYYY-MM-DD-<slug>.md" \
  template="Journey Template" content="..." silent
obsidian append path="MOCs/MOC — Journeys.md" \
  content="\n- [[YYYY-MM-DD-<slug>]] — <one-line summary>"
obsidian property:set file="<related-spec>" \
  name="last_updated" value="YYYY-MM-DD"
```

Always pass `silent` on writes so the Obsidian UI doesn't lose focus. Never
edit notes whose frontmatter has `status: archived` — append a new one.

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
