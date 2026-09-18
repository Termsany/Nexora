[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$ApiBaseUrl,
    [Parameter(Mandatory = $true)][string]$EnrollmentToken,
    [string]$SourcePath = (Join-Path $PSScriptRoot '..\..\agent\Nexora.Agent\bin\Release\net8.0-windows\win-x64\publish'),
    # Optional integrity pin for the source nexora-agent.exe. When supplied the
    # installer refuses to proceed on any mismatch. Recommended for
    # customer installs: pass the agentSha256 from agent-manifest.json /
    # Nexora Administration.
    [string]$ExpectedSha256,
    # When set, a missing/blank -ExpectedSha256 is a hard error rather than a
    # warning. Intended for locked-down customer environments.
    [switch]$RequireChecksum
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

# --- Integrity verification (before anything is copied) -------------------------
if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
    if ($RequireChecksum) { throw '-ExpectedSha256 is required (a -RequireChecksum install was requested).' }
    Write-Warning 'No -ExpectedSha256 supplied; skipping source integrity verification. Pass the agentSha256 from Nexora Administration for a verified install.'
} else {
    $actualSha = (Get-FileHash -LiteralPath $sourceExecutable -Algorithm SHA256).Hash
    if ($actualSha -ne $ExpectedSha256.Trim().ToUpperInvariant()) {
        throw "Source integrity check failed for nexora-agent.exe (expected $($ExpectedSha256.Trim().ToUpperInvariant()), got $actualSha). No files were changed."
    }
    Write-Host 'Source nexora-agent.exe SHA-256 verified.'
}

# Track whether THIS run created the install dir, so a failure can roll it back
# without deleting a pre-existing installation.
$createdInstallDir = -not (Test-Path $installPath)
New-Item -ItemType Directory -Force -Path $installPath, $dataPath, $logPath | Out-Null

try {
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
} catch {
    # Leave persistent identity/credentials (%ProgramData%) untouched, but do not
    # leave a half-populated Program Files directory behind.
    try {
        if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
            Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
            sc.exe delete $serviceName | Out-Null
        }
        if ($createdInstallDir) {
            if (Test-Path $installPath) { Remove-Item -LiteralPath $installPath -Recurse -Force -ErrorAction SilentlyContinue }
        } else {
            Get-ChildItem -LiteralPath $installPath -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch {}
    throw "Install failed and partial Program Files state was cleaned up. Original error: $($_.Exception.Message)"
}
