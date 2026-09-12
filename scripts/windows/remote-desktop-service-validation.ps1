# Nexora Remote Desktop V1 - Windows SERVICE-MODE validation.
#
# This is the gate that Phase 2 cannot be declared complete without. It must
# run on a real Windows machine with the Agent installed AS A SERVICE, because
# the thing being proved is precisely what a Linux build cannot show: that a
# session-0 service reaches the interactive desktop through the helper.
#
# It deliberately does NOT assert "a remote session worked" on its own - steps
# 5 to 8 need a human driving the Nexora console. Those are printed as an
# explicit manual checklist rather than silently skipped, because a script that
# reports success without them would be lying about the only thing that matters.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\remote-desktop-service-validation.ps1
#
# Read-only with respect to Production: it starts no session and changes no
# gate. It inspects the local machine only.

$ErrorActionPreference = 'Stop'
$results = [ordered]@{}
$failed = @()

function Check([string]$name, [scriptblock]$test, [string]$detail = '') {
    try {
        $value = & $test
        if ($value -is [bool]) { $ok = $value } else { $ok = [bool]$value }
        $results[$name] = if ($ok) { "PASS $detail" } else { "FAIL $detail" }
        if (-not $ok) { $script:failed += $name }
    } catch {
        $results[$name] = "ERROR $($_.Exception.Message)"
        $script:failed += $name
    }
}

Write-Host "=== Nexora Remote Desktop service-mode validation ===" -ForegroundColor Cyan

# 1. The Agent is installed and running as a Windows service.
$service = Get-Service -Name 'NexoraAgent' -ErrorAction SilentlyContinue
Check 'AGENT_SERVICE_INSTALLED' { $null -ne $service }
Check 'AGENT_SERVICE_RUNNING'   { $service -and $service.Status -eq 'Running' }

# 2. The service really is in session 0. If it is not, this validation is
#    not testing service mode at all and every later result is meaningless.
$agentProcess = Get-CimInstance Win32_Process -Filter "Name='nexora-agent.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -notmatch '--remote-desktop-helper' } | Select-Object -First 1
Check 'AGENT_IN_SESSION_0' { $agentProcess -and $agentProcess.SessionId -eq 0 } "(session $($agentProcess.SessionId))"

# 3. Binary location is protected: a user-writable agent binary would mean the
#    service is launching something an unprivileged user can replace.
$expected = Join-Path $env:ProgramFiles 'Nexora\Agent\nexora-agent.exe'
Check 'AGENT_BINARY_IN_PROGRAM_FILES' { Test-Path $expected }
Check 'AGENT_BINARY_NOT_USER_WRITABLE' {
    if (-not (Test-Path $expected)) { return $false }
    $acl = Get-Acl $expected
    $writable = $acl.Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and
        $_.FileSystemRights -match 'Write|FullControl|Modify' -and
        $_.IdentityReference -match 'Users|Everyone|INTERACTIVE|Authenticated Users'
    }
    $null -eq $writable
}

# 4. No listening port was added. Remote Desktop is outbound-only; if the
#    helper or agent ever listens, the whole security story changes.
Check 'NO_VNC_PORT_5900' { -not (Get-NetTCPConnection -State Listen -LocalPort 5900 -ErrorAction SilentlyContinue) }
Check 'NO_RDP_PORT_OPENED_BY_NEXORA' {
    $rdp = Get-NetTCPConnection -State Listen -LocalPort 3389 -ErrorAction SilentlyContinue
    if (-not $rdp) { return $true }
    # 3389 may be open for reasons unrelated to Nexora; only fail if we own it.
    $owners = $rdp | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName }
    -not ($owners -contains 'nexora-agent')
}
Check 'AGENT_OPENS_NO_LISTENER' {
    if (-not $agentProcess) { return $false }
    $pids = @($agentProcess.ProcessId)
    Get-CimInstance Win32_Process -Filter "Name='nexora-agent.exe'" |
        Where-Object { $_.CommandLine -match '--remote-desktop-helper' } |
        ForEach-Object { $pids += $_.ProcessId }
    $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $pids -contains $_.OwningProcess }
    $null -eq $listening
}

# 5. Identity must be untouched by this feature: no re-enrollment.
$dataPath = Join-Path $env:ProgramData 'Nexora\Agent'
Check 'AGENT_IDENTITY_PRESERVED' { Test-Path $dataPath }
Check 'HELPER_HOLDS_NO_CREDENTIALS' {
    # The helper runs as the interactive user; the credential store must not be
    # readable by that user.
    if (-not (Test-Path $dataPath)) { return $false }
    $acl = Get-Acl $dataPath
    $exposed = $acl.Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference -match 'Users|Everyone|INTERACTIVE|Authenticated Users'
    }
    $null -eq $exposed
}

# 6. Interactive session state, so a failure later can be attributed.
$console = (Get-Process -Id $PID).SessionId
Check 'RUNNER_IN_INTERACTIVE_SESSION' { $console -ne 0 } "(session $console)"

# 7. Helper process hygiene: none should exist while no session is active.
$helpers = @(Get-CimInstance Win32_Process -Filter "Name='nexora-agent.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '--remote-desktop-helper' })
Check 'NO_ORPHANED_HELPER_AT_REST' { $helpers.Count -eq 0 } "(found $($helpers.Count))"

Write-Host ""
foreach ($key in $results.Keys) {
    $value = $results[$key]
    $colour = if ($value -like 'PASS*') { 'Green' } else { 'Red' }
    Write-Host ("{0,-34} {1}" -f $key, $value) -ForegroundColor $colour
}

Write-Host ""
Write-Host "=== MANUAL STEPS - REQUIRED, NOT OPTIONAL ===" -ForegroundColor Yellow
Write-Host @"
The checks above prove the service is installed correctly and opens no port.
They do NOT prove Remote Desktop works. Phase 2 is complete only when a human
has driven the following through the Nexora console and recorded the result:

  M1  Enable Remote Desktop for this device, request a session, have a second
      authorized person approve it.
  M2  A REAL desktop image appears in the console - not black, not frozen.
      Confirm by changing something on screen and seeing it update.
  M3  While the session is live, run this script again and confirm exactly one
      helper process exists, in YOUR session id, not session 0.
  M4  Mouse movement moves the remote cursor.
  M5  A mouse click activates the intended control.
  M6  Keyboard input types into a remote window (test a modifier: Ctrl+A).
  M7  Lock the workstation (Win+L). The session must end with reason
      'workstation_locked' - it must NOT keep streaming the lock screen.
  M8  Unlock and start a NEW session successfully.
  M9  Log off. The helper must disappear; re-run this script and confirm
      NO_ORPHANED_HELPER_AT_REST passes.
  M10 Kill the helper process by hand. The session must end promptly with
      reason 'helper_exited' rather than freezing on the last frame.
  M11 Run a Remote Command (CMD 'hostname') and confirm it still works.
  M12 Confirm the Agent is still healthy and heartbeating afterwards.

Record each as PASS/FAIL. Any FAIL blocks deployment.
"@

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "AUTOMATED CHECKS FAILED: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "Automated checks passed. Manual steps M1-M12 still required." -ForegroundColor Green
exit 0
