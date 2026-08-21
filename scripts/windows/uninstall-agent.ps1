[CmdletBinding()]
param([switch]$PurgeData)

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this uninstaller from an elevated PowerShell session.' }

$serviceName = 'NexoraAgent'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force }
    sc.exe delete $serviceName | Out-Null
}
$installPath = Join-Path $env:ProgramFiles 'Nexora\Agent'
if (Test-Path $installPath) { Remove-Item -Path $installPath -Recurse -Force }
if ($PurgeData) {
    $dataPath = Join-Path $env:ProgramData 'Nexora\Agent'
    if (Test-Path $dataPath) { Remove-Item -Path $dataPath -Recurse -Force }
}
Write-Host ('Nexora Agent removed. Persistent data {0}.' -f $(if ($PurgeData) { 'was deleted' } else { 'was preserved' }))
