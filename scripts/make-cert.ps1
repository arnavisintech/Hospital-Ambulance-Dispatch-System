<#
  Self-signed certificate for testing HTTPS locally (browsers will warn). Real deployments use a CA-issued cert.
    .\scripts\make-cert.ps1 [-HostName localhost]   ->  certs\fullchain.pem, certs\privkey.pem
  Needs openssl on PATH (bundled with Git for Windows).
#>
param([string]$HostName = 'localhost')
$ErrorActionPreference = 'Stop'
$dir = Join-Path (Split-Path -Parent $PSScriptRoot) 'certs'
New-Item -ItemType Directory -Force $dir | Out-Null
& openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$HostName" `
  -addext "subjectAltName=DNS:$HostName,IP:127.0.0.1" `
  -keyout (Join-Path $dir 'privkey.pem') -out (Join-Path $dir 'fullchain.pem')
if ($LASTEXITCODE -ne 0) { throw 'openssl failed' }
Write-Host "Wrote $dir\fullchain.pem and $dir\privkey.pem"
