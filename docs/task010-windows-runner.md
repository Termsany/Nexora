# Task #010 Windows Validation Runner

Run only on a disposable Windows 10/11 or Windows Server VM/CI runner. Never
use DEPLOY or a production workstation. Do not provide production `.env`,
Agent tokens, enrollment tokens, signing keys, or administrator API tokens.

1. Check out the Nexora repository.
2. Install the supported .NET 8 SDK and confirm with `dotnet --info`.
3. Open PowerShell in the repository root.
4. Run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\task010-runtime-validation.ps1
```

The script refuses DEPLOY, verifies Windows and .NET 8, runs Agent tests,
publishes a self-contained `win-x64` artifact, and writes sanitized test
results and SHA-256 hashes under `artifacts/task010-windows-validation`.

The disposable runner must additionally execute the Task #010 Windows runtime
matrix: DPAPI persistence/corruption, CMD and PowerShell success/failure,
Unicode, bounded stdout/stderr, simultaneous output, timeout, process-tree
termination, cancellation, restart safety, and ECDSA interoperability against
a disposable API/database instance. Upload only sanitized logs and build
artifacts. Destroy the runner and all test data after validation.

Production migration, feature enablement, DEPLOY enrollment/upgrade, signing
key registration, and real DEPLOY command execution are prohibited.
