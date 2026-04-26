#!/bin/bash
#
# AinOne Dashboard - launches all three tiers (macOS / Linux).
#
# Tiers:
#   [1/3] Python sensor backend (FastAPI)        :8080
#   [2/3] Claude (Hono) backend                  :3000
#   [3/3] React frontend (Vite dev server)       :5173
#
# First run installs dependencies into backend/.venv, backend/claude/node_modules,
# and frontend/node_modules. Subsequent runs reuse what's already there.

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "=================================================="
echo "  AinOne Dashboard - launching all three tiers"
echo "=================================================="
echo

# ---- [1/3] Python sensor backend ----
echo "[1/3] Starting Python Backend (port 8080)..."
cd "$ROOT/backend"
if [ ! -x ".venv/bin/python" ]; then
  echo "  - first run: creating .venv"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --disable-pip-version-check -q -r requirements.txt
python -u run.py &
PY_PID=$!
deactivate

sleep 2

# ---- [2/3] Claude (Hono) backend ----
echo "[2/3] Starting Claude Backend (port 3000)..."
cd "$ROOT/backend/claude"
if [ ! -x "node_modules/.bin/tsx" ]; then
  echo "  - first run: installing node_modules"
  npm install
fi
npm run dev &
NODE_PID=$!

sleep 2

# ---- [3/3] Frontend ----
echo "[3/3] Starting Frontend (port 5173)..."
cd "$ROOT/frontend"
if [ ! -x "node_modules/.bin/vite" ]; then
  echo "  - first run: installing node_modules"
  npm install
fi
npm run dev &
FE_PID=$!

cleanup() {
  kill "$PY_PID" "$NODE_PID" "$FE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait
