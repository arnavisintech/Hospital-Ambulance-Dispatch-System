<#
  Run the backend test suite against a throw-away PostgreSQL 16 container (port 55432), then remove it.
    .\scripts\test-postgres.ps1                 # whole suite
    .\scripts\test-postgres.ps1 tests\test_concurrency.py
  Requires Docker Desktop.
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PytestArgs)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$py = Join-Path $backend '.venv\Scripts\python.exe'
$name = "hads-test-pg-$PID"

docker run -d --rm --name $name -e POSTGRES_USER=hads -e POSTGRES_PASSWORD=hads -e POSTGRES_DB=hads_test `
  -p 127.0.0.1:55432:5432 postgres:16-alpine | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'docker run failed - is Docker Desktop running?' }
try {
  Write-Host 'Waiting for PostgreSQL...'
  for ($i = 0; $i -lt 60; $i++) {
    docker exec $name pg_isready -U hads -d hads_test 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep 1
  }
  docker exec $name psql -U hads -d hads_test -c 'CREATE DATABASE hads_ops' | Out-Null
  $env:HADS_TEST_DATABASE_URL = 'postgresql+psycopg2://hads:hads@127.0.0.1:55432/hads_test'
  $env:HADS_TEST_OPS_DATABASE_URL = 'postgresql+psycopg2://hads:hads@127.0.0.1:55432/hads_ops'
  Push-Location $backend
  try { & $py -m pytest -q -p no:cacheprovider @PytestArgs; $code = $LASTEXITCODE } finally { Pop-Location }
} finally {
  Remove-Item Env:HADS_TEST_DATABASE_URL, Env:HADS_TEST_OPS_DATABASE_URL -ErrorAction SilentlyContinue
  docker rm -f $name | Out-Null
}
exit $code
