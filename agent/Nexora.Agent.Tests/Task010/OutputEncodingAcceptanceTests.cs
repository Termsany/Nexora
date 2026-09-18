using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nexora.Agent.Security;
using Nexora.Agent.Services;
using Xunit;

namespace Nexora.Agent.Tests.Task010;

/// Windows runtime acceptance for redirected shell output decoding.
///
/// These require a real Windows host: they launch cmd.exe/powershell.exe and
/// assert on bytes those processes actually produce. They cannot be validated
/// by inspection, and they cannot run on the Linux build host - which is how
/// the previous cmd.exe /u + Encoding.Unicode regression reached Production
/// with a test file that would have caught it sitting unexecuted.
public sealed class OutputEncodingAcceptanceTests
{
    private static Task<RemoteCommandResult> Run(string shell, string command, int timeout = 10) =>
        new RemoteCommandExecutor().ExecuteAsync(shell, command, timeout, null, CancellationToken.None);

    private static string Normalize(string value) => value.TrimEnd('\r', '\n');

    // TEST 1 - external executable. hostname.exe writes 8-bit bytes straight to
    // the inherited pipe; cmd never transcodes them. This is the exact case that
    // /u + Encoding.Unicode corrupted in Production.
    [Fact]
    public async Task Task010_Cmd_ExternalExecutable_Hostname_Exact()
    {
        var result = await Run("CMD", "hostname");
        Assert.Equal(0, result.ExitCode);
        Assert.Equal("", result.Stderr);
        Assert.DoesNotContain("\0", result.Stdout);
        // Case-sensitive on purpose: the OS hostname is the truth here, not the
        // Nexora device display name. On the pilot host the device is recorded
        // as "DEPLOY" while Windows reports "Deploy" - an assertion that
        // upper-cases both sides would hide a real encoding fault.
        Assert.Equal(Environment.MachineName, Normalize(result.Stdout));
        // The raw stream must still carry the CRLF the shell emitted.
        Assert.EndsWith("\r\n", result.Stdout);
    }

    // TEST 2 - cmd.exe built-in, pure ASCII.
    [Fact]
    public async Task Task010_Cmd_Builtin_Ascii_Exact()
    {
        var result = await Run("CMD", "echo NEXORA-CMD-OK");
        Assert.Equal(0, result.ExitCode);
        Assert.Equal("NEXORA-CMD-OK", Normalize(result.Stdout));
        Assert.Equal("", result.Stderr);
    }

    // TEST 3 - Unicode round-trip through the UTF-8 code-page contract.
    // Exercised via a cmd built-in, which chcp 65001 governs deterministically.
    // Arbitrary third-party executables may still ignore the console code page;
    // that is a Windows limitation, not something the Agent can enforce.
    [Fact]
    public async Task Task010_Cmd_Builtin_Unicode_Exact()
    {
        const string expected = "NEXORA-عربي-✓";
        var result = await Run("CMD", "echo " + expected);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(expected, Normalize(result.Stdout));
        Assert.Equal("", result.Stderr);
    }

    // TEST 4 - the two streams must stay separate and independently decoded.
    [Fact]
    public async Task Task010_Cmd_StreamSeparation_Exact()
    {
        var result = await Run("CMD", "(echo NEXORA-STDOUT)&(echo NEXORA-STDERR 1>&2)");
        Assert.Equal("NEXORA-STDOUT", Normalize(result.Stdout));
        Assert.DoesNotContain("NEXORA-STDERR", result.Stdout);
        // cmd's `echo X 1>&2` emits a trailing space before the redirect.
        Assert.Equal("NEXORA-STDERR", Normalize(result.Stderr).TrimEnd());
        Assert.DoesNotContain("NEXORA-STDOUT", result.Stderr);
    }

    // TEST 5 - a failing command must surface its exit code and stderr, and must
    // not be retried inside the executor.
    [Fact]
    public async Task Task010_Cmd_NonZeroExit_PropagatesWithStderr()
    {
        var result = await Run("CMD", "(echo NEXORA-FAILURE-DETAIL 1>&2)& exit /b 7");
        Assert.Equal(7, result.ExitCode);
        Assert.False(result.TimedOut);
        Assert.Equal("", Normalize(result.Stdout));
        Assert.Contains("NEXORA-FAILURE-DETAIL", result.Stderr);
        Assert.False(result.StdoutTruncated);
        Assert.False(result.StderrTruncated);
    }

    // TEST 6a - a CMD command that outlives its budget is killed, reports
    // TimedOut and yields no exit code (never a synthesised success).
    [Fact]
    public async Task Task010_Cmd_Timeout_TerminatesAndReportsNoExitCode()
    {
        var started = Stopwatch.StartNew();
        var result = await Run("CMD", "ping -n 60 127.0.0.1>nul", 3);
        started.Stop();
        Assert.True(result.TimedOut);
        Assert.Null(result.ExitCode);
        Assert.True(started.Elapsed < TimeSpan.FromSeconds(30), $"timeout did not terminate promptly ({started.Elapsed})");
    }

    // TEST 6b - descendant processes must die with the tree, not be orphaned.
    [Fact]
    public async Task Task010_Timeout_KillsDescendant()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".pid");
        Process? child = null;
        try
        {
            var execution = Run("POWERSHELL", "$p = Start-Process powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 120' -PassThru; $p.Id | Set-Content -LiteralPath '" + path.Replace("'", "''") + "'; Start-Sleep -Seconds 120", 15);
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (!File.Exists(path) && DateTime.UtcNow < deadline) await Task.Delay(100);
            Assert.True(File.Exists(path), "Child PID must be recorded before timeout");
            var pid = int.Parse((await File.ReadAllTextAsync(path)).Trim());
            child = Process.GetProcessById(pid);
            Assert.False(child.HasExited);
            var result = await execution;
            Assert.True(result.TimedOut);
            Assert.Null(result.ExitCode);
            Assert.True(child.WaitForExit(5000), "Descendant survived timeout tree kill");
        }
        finally
        {
            if (child is not null) { if (!child.HasExited) child.Kill(true); child.Dispose(); }
            File.Delete(path);
        }
    }

    // PowerShell regression - must not change. The production-verified case plus
    // a Unicode string.
    [Theory]
    [InlineData("NEXORA-REMOTE-OK")]
    [InlineData("NEXORA-عربي-✓")]
    public async Task Task010_PowerShell_Output_Exact(string expected)
    {
        var result = await Run("POWERSHELL", "Write-Output '" + expected + "'");
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(expected, Normalize(result.Stdout));
        Assert.Equal("", result.Stderr);
    }

    [Fact]
    public async Task Task010_PowerShell_ExternalExecutable_Hostname_Exact()
    {
        var result = await Run("POWERSHELL", "hostname");
        Assert.Equal(0, result.ExitCode);
        Assert.Equal(Environment.MachineName, Normalize(result.Stdout));
    }

    [Fact]
    public async Task Task010_OutputLimits_Exact()
    {
        var result = await Run("POWERSHELL", "[Console]::Out.Write('x' * 1100000); [Console]::Error.Write('y' * 1100000)");
        Assert.Equal(new string('x', 1024 * 1024), result.Stdout);
        Assert.Equal(new string('y', 1024 * 1024), result.Stderr);
        Assert.True(result.StdoutTruncated);
        Assert.True(result.StderrTruncated);
    }

    [Fact]
    public async Task Task010_DecodedResult_SigningAndTamper()
    {
        const string expected = "NEXORA اختبار";
        var result = await Run("CMD", "echo " + expected);
        Assert.Equal(expected, Normalize(result.Stdout));
        var body = JsonSerializer.SerializeToUtf8Bytes(new { stdout = result.Stdout, stderr = result.Stderr, exit_code = result.ExitCode });
        using var parsed = JsonDocument.Parse(body);
        Assert.Equal(result.Stdout, parsed.RootElement.GetProperty("stdout").GetString());
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        const string path = "v1/agent/remote-commands/test/result";
        var signed = AgentRequestSigner.Sign(key, "POST", path, body, "test-agent", "test-key");
        bool Verify(byte[] bytes)
        {
            var digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            var canonical = string.Join("\n", "nexora-agent-sign-v1", "POST", "/" + path, digest, signed.Timestamp, signed.Nonce, "test-agent", "test-key");
            return key.VerifyData(Encoding.UTF8.GetBytes(canonical), Convert.FromBase64String(signed.Signature), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        }
        Assert.True(Verify(body));
        Assert.False(Verify(JsonSerializer.SerializeToUtf8Bytes(new { stdout = "changed", stderr = result.Stderr, exit_code = result.ExitCode })));
    }

    // Pins the exact Production corruption: "Deploy\r\n" read as UTF-16LE.
    [Fact]
    public async Task Task010_PreviousMojibake_Regression()
    {
        var result = await Run("CMD", "hostname");
        Assert.DoesNotContain("敄汰祯਍", result.Stdout);
        foreach (var c in Normalize(result.Stdout))
            Assert.True(c < 0x2E80 || c > 0x9FFF, $"CJK character U+{(int)c:X4} in hostname output indicates UTF-16LE mis-decoding");
    }
}
