# Task010 Agent 0.3.0 Upgrade Runbook

Use only after the Task010 server migrations and deployment are complete. Run on DEPLOY in
an elevated PowerShell window. Do not display credentials. Remote Commands must remain
disabled for the device until the separate pilot-acceptance phase.

1. Confirm `NexoraAgent` is running: `Get-Service NexoraAgent`. Record the current version
   from `(Get-Item 'C:\Program Files\Nexora\Agent\nexora-agent.exe').VersionInfo.ProductVersion`.
2. Confirm `%ProgramData%\Nexora\Agent` exists and contains `device-id` and `credentials.dat`.
   Do not copy, move, or delete this directory at any point in this procedure.
3. Copy the released ZIP (e.g. `nexora-agent-win-x64-0.3.0.zip`) and its published
   `SHA256SUMS.txt` to the host. Do not extract it by hand — the upgrade script verifies the
   checksum and extracts it itself, so the bytes it verifies are the exact bytes it installs.
4. Run, without an enrollment token, pointing `-PackagePath` at the ZIP and `-ExpectedSha256`
   at the matching line from `SHA256SUMS.txt`:

```powershell
& .\scripts\windows\upgrade-agent.ps1 `
    -PackagePath 'C:\Path\to\nexora-agent-win-x64-0.3.0.zip' `
    -ExpectedSha256 '<sha256-from-SHA256SUMS.txt>' `
    -Verbose
```

   If the ZIP is not available and an already-extracted, trusted self-contained folder must be
   used instead, pass `-SourcePath 'C:\Path\to\win-x64'` in place of `-PackagePath`/`-ExpectedSha256`
   (omit `-ExpectedSha256` for that path only if no checksum is available; prefer supplying one).
   Do not pass both `-SourcePath` and `-PackagePath` together — the script refuses that.

   The script requires an existing `NexoraAgent` service and refuses to run otherwise. It
   never calls `--configure` and never performs enrollment. It stops the existing service,
   backs up only Program Files, replaces the complete Agent folder (not just the .exe),
   starts the service, and leaves `%ProgramData%\Nexora\Agent` untouched throughout.

5. Verify locally:
   - `Get-Service NexoraAgent` shows `Running` and `StartType` `Automatic`.
   - The installed `nexora-agent.exe` reports version `0.3.0`.
   - `%ProgramData%\Nexora\Agent` is unchanged (same `device-id`, same `credentials.dat`).
6. Verify from the server (not the endpoint): the device still shows the same Agent ID
   (`NX-000001`) and the same device UUID as before the upgrade, with heartbeat and telemetry
   continuing to arrive.

On failure, the script restores the prior program files from its own backup and restarts the
previous Agent automatically; it never re-enrolls and never touches ProgramData. Retain the
printed backup path (under `%ProgramData%\Nexora\UpgradeBackup`) as rollback evidence — it is
not deleted automatically.
