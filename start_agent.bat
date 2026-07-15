@echo off
setlocal

echo ============================================
echo   ESP32 Sensor Dashboard launcher
echo   (custom agent stack: agent_service + agent_gateway)
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
echo Launching in %MODE_LABEL% mode (custom agent)...
echo.

:: [1/4] Python hardware backend (FastAPI :8080)
echo [1/4] Starting Python Backend (port 8080)...
start "ESP32 Backend [%MODE_LABEL%]" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe run.py"

timeout /t 2 /nobreak >nul

:: [2/4] Custom agent service (FastAPI :8100) - replaces Claude SDK
echo [2/4] Starting Agent Service (port 8100)...
start "Agent Service" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe -m agent_service.run"

timeout /t 2 /nobreak >nul

:: [3/4] Agent gateway (Hono :3000) - SDK-free copy of backend\claude,
::       proxies chat/diary to the agent service. Original start.bat still
::       launches the untouched backend\claude instead.
echo [3/4] Starting Agent Gateway (port 3000)...
start "Agent Gateway" cmd /k "cd /d %~dp0backend\agent_gateway && npx tsx cli/node.ts"

timeout /t 3 /nobreak >nul

:: [4/4] Frontend (Vite :5173)
echo [4/4] Starting Frontend (port 5173) [%MODE_LABEL%]...
cd /d %~dp0frontend
call npm install
call npm run dev

pause
