<#
  Run HADS on this machine without Docker: SQLite database (backend/data/hads.db), backend on :8000,
  built frontend on :4173 (proxying /api to the backend).

    .\scripts\run-local.ps1            # demo mode: seeded city + one-click demo logins for every role
    .\scripts\run-local.ps1 -NoDemo    # empty database; create the first admin with backend\scripts\create_admin.py
    .\scripts\run-local.ps1 -Reset     # delete the local SQLite database first

  Stop with Ctrl+C (both processes are stopped).
#>
param([switch]$NoDemo, [switch]$Reset, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$py = Join-Path $backend '.venv\Scripts\python.exe'

if (-not (Test-Path $py)) {
  Write-Host 'Creating Python virtualenv...'
  python -m venv (Join-Path $backend '.venv')
  & $py -m pip install -q -r (Join-Path $backend 'requirements.txt')
}
if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
  Write-Host 'Installing frontend packages...'
  Push-Location $frontend; npm ci; Pop-Location
}
if ($Reset) {
  Get-ChildItem (Join-Path $backend 'data') -Filter 'hads.db*' -ErrorAction SilentlyContinue | Remove-Item -Force
}
if (-not $SkipBuild) {
  Write-Host 'Building frontend...'
  Push-Location $frontend; npm run build; Pop-Location
}

$env:APP_ENV = $(if ($NoDemo) { 'development' } else { 'demo' })
$env:DATABASE_URL = 'sqlite:///./data/hads.db'
$env:ROUTING_PROVIDER = 'haversine'
$env:GEO_PROVIDER = 'offline'
$env:DEMO_AUTOPILOT = $(if ($NoDemo) { 'false' } else { 'true' })

Write-Host 'Migrating the database schema...'
Push-Location $backend
try { & $py scripts\migrate.py; if ($LASTEXITCODE -ne 0) { throw 'Database migration failed (see above). For demo data, rerun with -Reset.' } }
finally { Pop-Location }

$api = Start-Process -FilePath $py -ArgumentList '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000' `
  -WorkingDirectory $backend -PassThru -NoNewWindow
$web = Start-Process -FilePath 'npx.cmd' -ArgumentList 'vite', 'preview', '--port', '4173', '--strictPort' `
  -WorkingDirectory $frontend -PassThru -NoNewWindow
try {
  Write-Host 'Waiting for the backend...'
  for ($i = 0; $i -lt 120; $i++) {
    try { if ((Invoke-RestMethod 'http://127.0.0.1:8000/api/ready' -TimeoutSec 2).ready) { break } } catch { Start-Sleep 1 }
  }
  Write-Host "HADS is running: http://localhost:4173  (API http://localhost:8000/docs)"
  Wait-Process -Id $api.Id
} finally {
  foreach ($p in @($api, $web)) { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
}
