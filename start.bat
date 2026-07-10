@echo off
setlocal

echo ============================================
echo   ESP32 Sensor Dashboard launcher
echo ============================================
echo.
echo   [1] Realtime  - connect to ESP32 hardware
echo   [2] Demo      - same stack, demo entry
echo.

set "MODE="
set /p "MODE=Choose mode (1/2, default 1): "

if /i "%MODE%"=="2" (
  set "VITE_DEMO_MODE=1"
  set "MODE_LABEL=DEMO"
) else (
  set "VITE_DEMO_MODE="
  set "MODE_LABEL=REALTIME"
)

echo.
echo Launching in %MODE_LABEL% mode...
echo.

:: Start Python Backend (FastAPI on port 8080)
echo [1/3] Starting Python Backend (port 8080)...
start "ESP32 Backend [%MODE_LABEL%]" cmd /k "cd /d %~dp0backend && uv run python run.py"

:: Wait a bit for Python backend to start
timeout /t 2 /nobreak >nul

:: Start Node.js Claude Backend (Hono on port 3000)
echo [2/3] Starting Claude Backend (port 3000)...
start "Claude Backend [%MODE_LABEL%]" cmd /k "cd /d %~dp0backend\claude && npm run dev"

:: Wait a bit for Claude backend to start
timeout /t 3 /nobreak >nul

:: Start Frontend (Vite on port 5173) in this shell so VITE_DEMO_MODE
:: is inherited from setlocal above. Vite picks up any VITE_* prefixed
:: env var and exposes it as import.meta.env.VITE_DEMO_MODE.
echo [3/3] Starting Frontend (port 5173) [%MODE_LABEL%]...
cd /d %~dp0frontend
call npm install
call npm run dev

pause
