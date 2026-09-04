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
  dotnet test agent/Nexora.Agent.Tests/Nexora.Agent.Tests.csproj --configuration Release --filter "FullyQualifiedName~Task010_" --logger "trx;LogFileName=task010-agent.trx" --results-directory $out
  $trx = Join-Path $out 'task010-agent.trx'
  if (-not (Test-Path $trx)) { throw 'Task #010 TRX was not produced.' }
  [xml]$xml = Get-Content $trx
  $results = @($xml.TestRun.Results.UnitTestResult | Where-Object { $_.testName -match 'Task010_' })
  if ($results.Count -lt 20) { throw "Expected at least 20 Task010 tests, found $($results.Count)." }
  if (@($results | Where-Object outcome -ne 'Passed').Count -gt 0) { throw 'A Task010 acceptance test failed.' }
  $summary = @('Task #010 Windows Runtime Validation', "OS: $([Environment]::OSVersion.VersionString)", "Task010 tests: $($results.Count)", "Passed: $(@($results | Where-Object outcome -eq 'Passed').Count)", 'Failed: 0', 'Skipped: 0', "Total: $($results.Count)", '')
  $summary += $results | ForEach-Object { "$($_.testName): $($_.outcome)" }
  $summary | Set-Content (Join-Path $out 'task010-runtime-summary.txt')
  dotnet publish agent/Nexora.Agent/Nexora.Agent.csproj --configuration Release --runtime win-x64 --self-contained true --output (Join-Path $out 'publish')
  $hashes = Get-ChildItem (Join-Path $out 'publish') -File | Get-FileHash -Algorithm SHA256
  $hashes | ForEach-Object { "$($_.Hash)  $($_.Path)" } | Set-Content (Join-Path $out 'SHA256SUMS.txt')
} finally { Pop-Location }
Write-Host "Validation artifacts: $out"
