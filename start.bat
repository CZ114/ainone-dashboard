@echo off
setlocal
echo ==================================================
echo   AinOne Dashboard - launching all three tiers
echo ==================================================
echo.

set "ROOT=%~dp0"

:: ---- [1/3] Python sensor backend (port 8080) ----
echo [1/3] Starting Python Backend (port 8080)...
:: First run creates .venv and installs requirements.txt; subsequent runs reuse it.
start "ESP32 Backend" cmd /k "cd /d %ROOT%backend && (if not exist .venv\Scripts\python.exe python -m venv .venv) && call .venv\Scripts\activate.bat && python -m pip install --disable-pip-version-check -q -r requirements.txt && python -u run.py"

timeout /t 3 /nobreak >nul

:: ---- [2/3] Claude (Hono) backend (port 3000) ----
echo [2/3] Starting Claude Backend (port 3000)...
:: First run installs node_modules; subsequent runs skip straight to dev.
start "Claude Backend" cmd /k "cd /d %ROOT%backend\claude && (if not exist node_modules\.bin\tsx.cmd call npm install) && call npm run dev"

timeout /t 3 /nobreak >nul

:: ---- [3/3] Frontend (port 5173) ----
echo [3/3] Starting Frontend (port 5173)...
cd /d %ROOT%frontend
if not exist node_modules\.bin\vite.cmd call npm install
call npm run dev

pause
