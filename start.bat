@echo off
echo Starting ESP32 Sensor Dashboard with Claude Code Chat...
echo.

:: Start Python Backend (FastAPI on port 8080)
echo [1/3] Starting Python Backend (port 8080)...
start "ESP32 Backend" cmd /k "cd /d %~dp0backend && uv run python run.py"

:: Wait a bit for Python backend to start
timeout /t 2 /nobreak >nul

:: Start Node.js Claude Backend (Hono on port 3000)
echo [2/3] Starting Claude Backend (port 3000)...
start "Claude Backend" cmd /k "cd /d %~dp0backend\claude && npm run dev"

:: Wait a bit for Claude backend to start
timeout /t 3 /nobreak >nul

:: Start Frontend (Vite on port 5173)
echo [3/3] Starting Frontend (port 5173)...
cd /d %~dp0frontend
call npm install
call npm run dev

pause
