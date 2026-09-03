[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$ApiBaseUrl,
    [Parameter(Mandatory = $true)][string]$EnrollmentToken,
    [string]$SourcePath = (Join-Path $PSScriptRoot '..\..\agent\Nexora.Agent\bin\Release\net8.0-windows\win-x64\publish')
)

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer from an elevated PowerShell session.' }

$serviceName = 'NexoraAgent'
$installPath = Join-Path $env:ProgramFiles 'Nexora\Agent'
$dataPath = Join-Path $env:ProgramData 'Nexora\Agent'
$logPath = Join-Path $dataPath 'Logs'
$sourceExecutable = Join-Path $SourcePath 'nexora-agent.exe'
if (-not (Test-Path $sourceExecutable)) { throw "Published agent not found: $sourceExecutable" }

New-Item -ItemType Directory -Force -Path $installPath, $dataPath, $logPath | Out-Null
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $serviceName | Out-Null
    Start-Sleep -Seconds 2
}
Copy-Item -Path (Join-Path $SourcePath '*') -Destination $installPath -Recurse -Force
$executable = Join-Path $installPath 'nexora-agent.exe'
& $executable --configure --api-base-url $ApiBaseUrl --enrollment-token $EnrollmentToken
if ($LASTEXITCODE -ne 0) { throw 'Agent configuration failed.' }

New-Service -Name $serviceName -BinaryPathName ('"{0}"' -f $executable) -DisplayName 'Nexora Agent' -Description 'Nexora endpoint monitoring agent' -StartupType Automatic | Out-Null
sc.exe failure $serviceName reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
sc.exe failureflag $serviceName 1 | Out-Null
Start-Service -Name $serviceName
$service = Get-Service -Name $serviceName
if ($service.Status -ne 'Running') { throw "Nexora Agent failed to start. State: $($service.Status)" }
Write-Host "Nexora Agent installed and running from $installPath"
