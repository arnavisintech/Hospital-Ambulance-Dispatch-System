<#
  Disaster-recovery drill (NFR6): proves a destroyed database comes back from the nightly base backup plus the
  archived WAL, including data written AFTER the backup. Uses the demo stack; destroys and recreates its database.
    .\scripts\verify-restore.ps1
  Prints "RESTORE OK" with the measured recovery time, or fails. Requires Docker Desktop and Git Bash (sh).
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$compose = 'docker compose --env-file demo.env -f docker-compose.yml -f docker-compose.demo.yml'
function Compose([string]$argsLine) { Invoke-Expression "$compose $argsLine"; if ($LASTEXITCODE -ne 0) { throw "compose $argsLine failed" } }
function Sql([string]$q) { (Invoke-Expression "$compose exec -T db psql -U hads -d hads -tAc `"$q`"") | Out-String }

Write-Host 'Starting the demo stack...'
Compose 'up -d --build db backup backend'
for ($i = 0; $i -lt 120; $i++) { if ((Sql 'select 1').Trim() -eq '1') { break }; Start-Sleep 2 }

Sql "create table if not exists dr_marker (name text primary key, at timestamptz default now())" | Out-Null
Sql "insert into dr_marker(name) values ('before-backup') on conflict do nothing" | Out-Null
Write-Host 'Taking a base backup...'
Compose 'exec -T backup backup.sh'
Start-Sleep 30
Sql "insert into dr_marker(name) values ('after-backup') on conflict do nothing" | Out-Null
Write-Host 'Waiting 70 s for the WAL segment holding the second marker to be archived...'
Start-Sleep 70

Write-Host 'Destroying the database volume...'
Compose 'stop backend db'
$project = (Invoke-Expression "$compose config --format json" | ConvertFrom-Json).name
Compose 'rm -f db'
docker volume rm "${project}_pgdata" | Out-Null
Compose 'create db'

$env:COMPOSE = $compose
$t = Measure-Command { & sh scripts/restore-db.sh latest; if ($LASTEXITCODE -ne 0) { throw 'restore-db.sh failed' } }
Remove-Item Env:COMPOSE
$found = (Sql "select string_agg(name, ',' order by name) from dr_marker").Trim()
if ($found -ne 'after-backup,before-backup') { throw "RESTORE FAILED: markers found = '$found'" }
Sql 'drop table dr_marker' | Out-Null
Write-Host ("RESTORE OK in {0:n0} s (both markers present; the second was written after the base backup)" -f $t.TotalSeconds)
