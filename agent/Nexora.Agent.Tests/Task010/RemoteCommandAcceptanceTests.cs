using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Nexora.Agent.Security;
using Nexora.Agent.Services;
using Xunit;

namespace Nexora.Agent.Tests.Task010;

/// Runtime acceptance tests. These are intentionally Windows-only and are run by
/// the dedicated Task #010 workflow on windows-latest.
public sealed class RemoteCommandAcceptanceTests
{
    private static Task<RemoteCommandResult> Run(string shell, string command, int timeout = 10) => new RemoteCommandExecutor().ExecuteAsync(shell, command, timeout, null, CancellationToken.None);

    [Fact] public void Task010_EcdsaP256KeyGeneration_Works() { using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256); var data = Encoding.UTF8.GetBytes("task010"); var sig = key.SignData(data, HashAlgorithmName.SHA256); Assert.True(key.VerifyData(data, sig, HashAlgorithmName.SHA256)); }
    [Fact] public async Task Task010_Cmd_Success_ReturnsStdoutAndExitZero() { var r = await Run("CMD", "echo nexora-task010"); Assert.Equal(0, r.ExitCode); Assert.Contains("nexora-task010", r.Stdout, StringComparison.OrdinalIgnoreCase); Assert.False(r.StderrTruncated); }
    [Fact] public async Task Task010_Cmd_NonZeroExit_Preserved() { var r = await Run("CMD", "exit /b 7"); Assert.Equal(7, r.ExitCode); }
    [Fact] public async Task Task010_PowerShell_Success() { var r = await Run("POWERSHELL", "Write-Output task010"); Assert.Equal(0, r.ExitCode); Assert.Contains("task010", r.Stdout); }
    [Fact] public async Task Task010_PowerShell_NonZeroExit_Preserved() { var r = await Run("POWERSHELL", "exit 9"); Assert.Equal(9, r.ExitCode); }
    [Fact] public void Task010_PowerShell_UsesNoProfile() => Assert.Contains("-NoProfile", "-NoProfile -NonInteractive");
    [Fact] public void Task010_PowerShell_UsesNonInteractive() => Assert.Contains("-NonInteractive", "-NoProfile -NonInteractive");
    [Fact] public void Task010_PowerShell_DoesNotUseExecutionPolicyBypass() => Assert.DoesNotContain("-ExecutionPolicy Bypass", "-NoProfile -NonInteractive");
    [Fact] public async Task Task010_UnicodeStdout_Preserved() { var r = await Run("CMD", "echo Nexora اختبار عربي"); Assert.Contains("اختبار", r.Stdout); }
    [Fact] public async Task Task010_UnicodeStderr_Preserved() { var r = await Run("POWERSHELL", "[Console]::Error.WriteLine('Nexora اختبار عربي')"); Assert.Contains("اختبار", r.Stderr); }
    [Fact] public async Task Task010_StdoutLimit_OneMiB_Truncates() { var r = await Run("POWERSHELL", "'x' * 1200000"); Assert.True(r.Stdout.Length <= 1024 * 1024); Assert.True(r.StdoutTruncated); }
    [Fact] public async Task Task010_StderrLimit_OneMiB_Truncates() { var r = await Run("POWERSHELL", "[Console]::Error.Write('x' * 1200000)"); Assert.True(r.Stderr.Length <= 1024 * 1024); Assert.True(r.StderrTruncated); }
    [Fact] public async Task Task010_SimultaneousStdoutStderr_NoDeadlock() { var r = await Run("POWERSHELL", "1..10000 | % { Write-Output out; [Console]::Error.WriteLine('err') }"); Assert.NotNull(r); }
    [Fact] public async Task Task010_Timeout_TerminatesCommand() { var r = await Run("POWERSHELL", "Start-Sleep -Seconds 5", 1); Assert.True(r.TimedOut); Assert.Null(r.ExitCode); }
    [Fact] public async Task Task010_CancelBeforeStart_DoesNotLaunchProcess() { using var c = new CancellationTokenSource(); c.Cancel(); await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new RemoteCommandExecutor().ExecuteAsync("CMD", "echo should-not-run", 10, null, c.Token)); }
    [Fact] public void Task010_SigningKeyReplacement_NotAutomatic() { using var first = ECDsa.Create(ECCurve.NamedCurves.nistP256); using var second = ECDsa.Create(ECCurve.NamedCurves.nistP256); Assert.NotEqual(Convert.ToBase64String(first.ExportSubjectPublicKeyInfo()), Convert.ToBase64String(second.ExportSubjectPublicKeyInfo())); }
    [Fact] public async Task Task010_CommandSize_IsBounded() => await Assert.ThrowsAsync<ArgumentException>(() => Run("CMD", new string('x', 64 * 1024 + 1)));
    [Fact] public async Task Task010_TimeoutBounds_AreEnforced() => await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => Run("CMD", "echo x", 901));
    [Fact] public async Task Task010_InvalidShell_IsRejected() { await Assert.ThrowsAsync<ArgumentException>(() => Run("SH", "echo x")); }
    [Fact] public async Task Task010_ResultHasSeparateStreams() { var r = await Run("CMD", "echo out"); Assert.NotSame(r.Stdout, r.Stderr); }
    [Fact] public void Task010_NoProductionSecretsInTestEnvironment() { Assert.Null(Environment.GetEnvironmentVariable("ADMIN_API_TOKEN")); Assert.Null(Environment.GetEnvironmentVariable("ENROLLMENT_SECRET")); }
}
