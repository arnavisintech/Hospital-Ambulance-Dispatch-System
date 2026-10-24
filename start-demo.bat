@echo off
REM HADS demo launcher: starts the whole stack in Docker with the seeded Chennai demo and opens the app.
REM Requires Docker Desktop to be running. Demo secrets live in demo.env (throwaway values, never for real data).
cd /d "%~dp0"
echo Starting HADS (database, road router, backend, frontend)...
docker compose --env-file demo.env -f docker-compose.yml -f docker-compose.demo.yml up -d --build
if errorlevel 1 (
  echo.
  echo Docker failed to start the stack. Is Docker Desktop running?
  pause
  exit /b 1
)
echo Waiting for the backend to become ready...
:wait
curl -fs http://localhost:8080/api/ready >nul
if errorlevel 1 (
  timeout /t 2 >nul
  goto wait
)
echo HADS is ready.
start "" http://localhost:8080
