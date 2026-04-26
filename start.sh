#!/bin/bash

echo "Starting ESP32 Sensor Dashboard..."
echo

# Start backend in background
echo "[1/2] Starting Backend (port 8000)..."
cd "$(dirname "$0")/backend"
uv run python run.py &
BACKEND_PID=$!

# Wait for backend
sleep 2

# Start frontend
echo "[2/2] Starting Frontend (port 5173)..."
cd "$(dirname "$0")/frontend"
npm install
npm run dev &

# Wait for Ctrl+C
trap "kill $BACKEND_PID 2>/dev/null" EXIT
wait