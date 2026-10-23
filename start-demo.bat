@echo off
REM HADS demo launcher: starts the whole stack in Docker and opens the app.
REM Requires Docker Desktop to be running.
cd /d "%~dp0"
echo Starting HADS (database, road router, backend, frontend)...
docker compose up -d
if errorlevel 1 (
  echo.
  echo Docker failed to start the stack. Is Docker Desktop running?
  pause
  exit /b 1
)
echo Waiting for the backend to become healthy...
:wait
curl -s http://localhost:8000/api/health | find "ok" >nul
if errorlevel 1 (
  timeout /t 2 >nul
  goto wait
)
echo HADS is ready.
start "" http://localhost:8080
