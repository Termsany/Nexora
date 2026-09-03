$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$out = Join-Path $repo 'artifacts/task010-windows-validation'
New-Item -ItemType Directory -Force $out | Out-Null

if ($env:COMPUTERNAME -eq 'DEPLOY') { throw 'Refusing to run on DEPLOY.' }
if (-not [System.Environment]::OSVersion.Platform.ToString().StartsWith('Win')) { throw 'Windows runner required.' }
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) { throw '.NET 8 SDK is required; install it on the disposable runner before running this script.' }
$info = dotnet --info 2>&1
$info | Set-Content (Join-Path $out 'dotnet-info.txt')
if (-not (($info -join "`n") -match '8\.')) { throw '.NET 8 SDK is required.' }

Push-Location $repo
try {
  dotnet test agent/Nexora.Agent.Tests/Nexora.Agent.Tests.csproj --configuration Release --logger "trx;LogFileName=task010-agent.trx" --results-directory $out
  dotnet publish agent/Nexora.Agent/Nexora.Agent.csproj --configuration Release --runtime win-x64 --self-contained true --output (Join-Path $out 'publish')
  $hashes = Get-ChildItem (Join-Path $out 'publish') -File | Get-FileHash -Algorithm SHA256
  $hashes | ForEach-Object { "$($_.Hash)  $($_.Path)" } | Set-Content (Join-Path $out 'SHA256SUMS.txt')
} finally { Pop-Location }
Write-Host "Validation artifacts: $out"
