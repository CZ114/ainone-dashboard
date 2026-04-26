#!/bin/bash
#
# AinOne Dashboard - launches all three tiers (macOS / Linux).
#
# Tiers:
#   [1/3] Python sensor backend (FastAPI)        :8080
#   [2/3] Claude (Hono) backend                  :3000
#   [3/3] React frontend (Vite dev server)       :5173

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Starting AinOne Dashboard..."
echo

echo "[1/3] Starting Python Backend (port 8080)..."
cd "$ROOT/backend"
python -u run.py &
PY_PID=$!

sleep 2

echo "[2/3] Starting Claude Backend (port 3000)..."
cd "$ROOT/backend/claude"
npm run dev &
NODE_PID=$!

sleep 2

echo "[3/3] Starting Frontend (port 5173)..."
cd "$ROOT/frontend"
npm install
npm run dev &
FE_PID=$!

cleanup() {
  kill "$PY_PID" "$NODE_PID" "$FE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait
