@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found in PATH. Install Node 14+ and retry.
  pause
  exit /b 1
)

node -e "require('http').get('http://127.0.0.1:8888/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
if not errorlevel 1 (
  echo PortBoard is already running. Opening http://127.0.0.1:8888 ...
  start "" "http://127.0.0.1:8888"
  exit /b 0
)

echo.
echo   PortBoard  http://127.0.0.1:8888
echo   Press Ctrl+C to stop.
echo.

start "" "http://127.0.0.1:8888"
node server.js
pause
