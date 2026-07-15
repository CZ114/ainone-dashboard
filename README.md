# AinOne Dashboard

Full-stack real-time sensor dashboard with AI chat integration:

- **FastAPI** — Serial / BLE / UDP audio acquisition, WebSocket streaming
- **Hono + Claude Agent SDK** — streaming chat, embedded terminal
- **React + Vite + Tailwind** — real-time waveforms, recordings, chat

Part of a lab project on early Alzheimer's prediction (wearable + platform).
See `docs/plans/lab-integration.md` for the broader project context.

---

## Quick start

### 1. Python backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -u run.py                                      # → http://localhost:8080
```

### 2. Claude (Hono) backend

```bash
cd backend/claude
npm install
node scripts/generate-version.js
npm run dev                                           # → http://localhost:3000
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                                           # → http://localhost:5173
```

### 4. Connect ESP32

- Plug in via USB and pick the serial port, **or**
- Connect via BLE (default device name: `ESP32-S3-MultiSensor`), **or**
- Send UDP audio to `:8888` (after installing the Whisper extension)

Data appears automatically once frames arrive.

---

## Documentation

Project docs live under [`docs/`](./docs) and use YAML frontmatter to track
status and tags. The layout:

| Folder | Purpose |
|---|---|
| [`docs/specs/`](./docs/specs)         | Feature designs (status: draft → active → shipped) |
| [`docs/plans/`](./docs/plans)         | Roadmaps + requirements |
| [`docs/guides/`](./docs/guides)       | How-to references for tricky implementations |
| [`docs/journeys/`](./docs/journeys)   | Debug post-mortems (read-only history) |
| [`docs/learn/`](./docs/learn)         | Personal study notes |

Start with [`docs/specs/main-spec.md`](./docs/specs/main-spec.md) for the
full architecture, or open any subdirectory to browse.

For Claude Code sessions, the conventions are encoded as the `research-log`
skill at `.claude/skills/research-log/`. New docs go under one of the five
subdirectories above; copy frontmatter from any existing file.

> **Note**: the *research log* (this dev wiki) is distinct from the
> *Diary* feature inside the dashboard. The research log is for developers;
> Diary is a runtime feature that generates AI observations for the user.

---

## License

MIT
