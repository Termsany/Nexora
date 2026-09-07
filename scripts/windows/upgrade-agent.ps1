[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$SourcePath,
    [string]$PackagePath,
    [string]$ExpectedSha256,
    [string]$TargetVersion = '0.3.0',
    [string]$InstallPath = (Join-Path ${env:ProgramFiles} 'Nexora\Agent'),
    [string]$BackupRoot = (Join-Path ${env:ProgramData} 'Nexora\UpgradeBackup')
)

# Identity-preserving, in-place upgrade for an EXISTING NexoraAgent installation.
# This script never touches %ProgramData%\Nexora\Agent (device identity, credentials.dat,
# signing key material, config.json) and never calls --configure or performs enrollment.

$ErrorActionPreference = 'Stop'
$serviceName = 'NexoraAgent'
$dataPath = Join-Path ${env:ProgramData} 'Nexora\Agent'

function Get-ChildGlob {
    param([Parameter(Mandatory = $true)][string]$BasePath)
    # Escapes wildcard metacharacters in $BasePath (e.g. '[', ']', '`') so that only the
    # trailing '*' is treated as a wildcard, regardless of what the base path contains.
    return (Join-Path ([Management.Automation.WildcardPattern]::Escape($BasePath)) '*')
}

function Test-IsReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Get-DirectoryHash {
    param([Parameter(Mandatory = $true)][string]$Path)
    $root = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $files = Get-ChildItem -LiteralPath $root -Recurse -File -Force |
        Sort-Object { $_.FullName.Substring($root.Length) }
    $builder = New-Object System.Text.StringBuilder
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.Length).Replace('\', '/')
        $fileHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        [void]$builder.Append($relative).Append(':').Append($fileHash).Append("`n")
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($builder.ToString())
        return [BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace('-', '')
    } finally { $sha256.Dispose() }
}

function Expand-ZipSafely {
    param([Parameter(Mandatory = $true)][string]$ZipPath, [Parameter(Mandatory = $true)][string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $fullDestination = [IO.Path]::GetFullPath($Destination)
    $prefix = $fullDestination.TrimEnd('\') + '\'
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($entry in $archive.Entries) {
            if ([string]::IsNullOrEmpty($entry.Name)) { continue } # directory entry
            $targetPath = [IO.Path]::GetFullPath((Join-Path $fullDestination $entry.FullName))
            if (-not $targetPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to extract zip entry outside destination (zip-slip): $($entry.FullName)"
            }
            New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($targetPath)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
        }
    } finally { $archive.Dispose() }
}

function Get-CleanVersion {
    param([string]$VersionString)
    if (-not $VersionString) { return $null }
    $match = [Text.RegularExpressions.Regex]::Match($VersionString, '^\d+(\.\d+){1,3}')
    if (-not $match.Success) { return $null }
    return [Version]$match.Value
}

# --- Preconditions: elevation, existing installation, ProgramData state -----------------
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run from an elevated PowerShell session.' }
if (-not (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) { throw "Existing $serviceName service was not found; refusing fresh-install behavior." }
if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) { throw "Agent state directory is missing: $dataPath" }

$resolvedInstall = [IO.Path]::GetFullPath($InstallPath)
if ($resolvedInstall -ne ([IO.Path]::GetFullPath((Join-Path ${env:ProgramFiles} 'Nexora\Agent')))) { throw 'InstallPath must be the standard Program Files Nexora Agent directory.' }

$resolvedBackupRoot = [IO.Path]::GetFullPath($BackupRoot)
if ($resolvedBackupRoot -eq $resolvedInstall -or $resolvedBackupRoot -eq ([IO.Path]::GetFullPath($dataPath))) {
    throw 'BackupRoot must not be the install path or the Agent state directory.'
}

if ($SourcePath -and $PackagePath) { throw 'Specify either -SourcePath or -PackagePath, not both (source path confusion).' }
if (-not $SourcePath -and -not $PackagePath) { throw 'Either -SourcePath (extracted folder) or -PackagePath (zip, with -ExpectedSha256) is required.' }
if ($PackagePath -and -not $ExpectedSha256) { throw '-PackagePath requires -ExpectedSha256 for integrity verification.' }

$timestamp = Get-Date -Format 'yyyyMMddTHHmmssZ'
$staging = Join-Path $resolvedBackupRoot "Staging_$timestamp"

# --- Resolve and verify the authoritative release into a private, script-owned staging folder ---
if ($PackagePath) {
    if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw "Package not found: $PackagePath" }
    $actual = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash
    if ($actual -ne $ExpectedSha256.ToUpperInvariant()) { throw 'Package SHA-256 mismatch; no files were changed.' }
    Expand-ZipSafely -ZipPath $PackagePath -Destination $staging
} else {
    if (-not (Test-Path -LiteralPath $SourcePath -PathType Container)) { throw "Source folder not found: $SourcePath" }
    if (Test-IsReparsePoint -Path $SourcePath) { throw 'SourcePath must not be a reparse point/junction.' }
    if ($ExpectedSha256) {
        $actual = Get-DirectoryHash -Path $SourcePath
        if ($actual -ne $ExpectedSha256.ToUpperInvariant()) { throw 'Source folder SHA-256 (manifest) mismatch; no files were changed.' }
    }
    # Snapshot into a script-owned staging directory immediately after verification so the
    # bits verified above are the exact bits installed below (narrows the verify/use window).
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Copy-Item -Path (Get-ChildGlob $SourcePath) -Destination $staging -Recurse -Force
}

if (Test-IsReparsePoint -Path $staging) { throw 'Resolved release folder must not be a reparse point/junction.' }
if (-not (Test-Path -LiteralPath (Join-Path $staging 'nexora-agent.exe'))) { throw 'Resolved release is not a complete Agent publish (missing nexora-agent.exe).' }
if (-not (Test-Path -LiteralPath (Join-Path $staging 'nexora-agent.dll'))) { throw 'Resolved release looks like an apphost only, not the complete self-contained folder (missing nexora-agent.dll).' }
if (-not (Get-ChildItem -LiteralPath $staging -Filter '*.deps.json' -ErrorAction SilentlyContinue)) { throw 'Resolved release is missing *.deps.json; incomplete self-contained publish.' }

$sourceProductVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $staging 'nexora-agent.exe')).ProductVersion
if (-not $sourceProductVersion -or $sourceProductVersion -notlike "$TargetVersion*") { throw "Resolved release version is '$sourceProductVersion', expected $TargetVersion." }
$sourceFileVersion = Get-CleanVersion ([Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $staging 'nexora-agent.exe')).FileVersion)

$currentExe = Join-Path $resolvedInstall 'nexora-agent.exe'
if (Test-Path -LiteralPath $currentExe) {
    $currentFileVersion = Get-CleanVersion ([Diagnostics.FileVersionInfo]::GetVersionInfo($currentExe).FileVersion)
    if ($currentFileVersion -and $sourceFileVersion -and $sourceFileVersion -lt $currentFileVersion) {
        throw "Refusing downgrade: installed version $currentFileVersion is newer than release version $sourceFileVersion."
    }
}

# --- Disk space check -------------------------------------------------------------------
$releaseBytes = (Get-ChildItem -LiteralPath $staging -Recurse -File | Measure-Object -Property Length -Sum).Sum
$driveRoot = [IO.Path]::GetPathRoot($resolvedInstall).TrimEnd('\')
$drive = Get-PSDrive -Name $driveRoot.TrimEnd(':') -ErrorAction SilentlyContinue
if ($drive -and $releaseBytes -and $drive.Free -lt ($releaseBytes * 3)) {
    throw "Insufficient free space on $driveRoot for a safe upgrade (backup + new copy)."
}

# --- Backup current Program Files (never touches ProgramData) --------------------------
$backup = Join-Path $resolvedBackupRoot "Backup_$timestamp"
$stopped = $false
try {
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    Copy-Item -Path (Get-ChildGlob $resolvedInstall) -Destination $backup -Recurse -Force

    if ($PSCmdlet.ShouldProcess($serviceName, 'stop for in-place binary upgrade')) {
        Stop-Service -Name $serviceName -Force
        $stopped = $true

        Remove-Item -Path (Get-ChildGlob $resolvedInstall) -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item -Path (Get-ChildGlob $staging) -Destination $resolvedInstall -Recurse -Force

        $installedVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $resolvedInstall 'nexora-agent.exe')).ProductVersion
        if (-not $installedVersion -or $installedVersion -notlike "$TargetVersion*") { throw "Installed Agent version is '$installedVersion', expected $TargetVersion." }

        Start-Service -Name $serviceName
        $stopped = $false
        (Get-Service -Name $serviceName).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))

        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        Write-Output "Upgrade succeeded. Version=$installedVersion Backup=$backup StatePreserved=$dataPath"
    }
} catch {
    if ($stopped) { try { Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue } catch {} }
    if (Test-Path -LiteralPath $backup) {
        Remove-Item -Path (Get-ChildGlob $resolvedInstall) -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item -Path (Get-ChildGlob $backup) -Destination $resolvedInstall -Recurse -Force
        try { Start-Service -Name $serviceName -ErrorAction Stop } catch {}
    }
    throw "Upgrade failed; previous program files restored from $backup. $($_.Exception.Message)"
}
