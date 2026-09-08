using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Nexora.Agent.Security;
using Xunit;

namespace Nexora.Agent.Tests.Task010;

/// <summary>
/// Real Windows Service Control Manager acceptance tests for scripts/windows/upgrade-agent.ps1.
/// These tests install and remove a real "NexoraAgent" service and read/write the real
/// Program Files / ProgramData paths the script is pinned to, so they must never run against
/// DEPLOY and must not run concurrently with anything else touching that service. They are
/// run by the dedicated Task #010 workflow on a disposable windows-latest runner.
///
/// Fixture material is a tiny stand-in Windows Service (UpgradeStub project) published at
/// different -p:Version values, rather than the real Nexora.Agent, so these tests exercise
/// upgrade-agent.ps1's own responsibilities (service lifecycle, file replacement, rollback,
/// checksum/zip-slip/version guards) without depending on Agent networking/enrollment.
/// </summary>
public sealed class AgentUpgradeAcceptanceTests : IDisposable
{
    private const string ServiceName = "NexoraAgent";
    private static readonly string RepoRoot = FindRepoRoot();
    private static readonly string ScriptPath = Path.Combine(RepoRoot, "scripts", "windows", "upgrade-agent.ps1");
    private static readonly string StubProject = Path.Combine(RepoRoot, "agent", "Nexora.Agent.Tests", "UpgradeStub", "UpgradeTestStub.csproj");
    private static readonly string InstallPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Nexora", "Agent");
    private static readonly string DataPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Nexora", "Agent");
    private static readonly string BackupRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Nexora", "UpgradeBackup");
    private readonly string _work = Path.Combine(Path.GetTempPath(), "nexora-upgrade-tests-" + Guid.NewGuid().ToString("N"));

    public AgentUpgradeAcceptanceTests()
    {
        if (string.Equals(Environment.MachineName, "DEPLOY", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Refusing to run upgrade acceptance tests on DEPLOY.");
        Directory.CreateDirectory(_work);
        RemoveServiceAndStateIfPresent();
    }

    public void Dispose()
    {
        try { RemoveServiceAndStateIfPresent(); } catch { /* best-effort teardown */ }
        try { Directory.Delete(_work, recursive: true); } catch { /* best-effort teardown */ }
    }

    // ---------------------------------------------------------------------------------
    // Fast, independent checks of the actual shipped script/runbook content. No shared
    // OS state, safe to run in parallel with anything.
    // ---------------------------------------------------------------------------------

    [Fact]
    public void Task010_Upgrade_ScriptNeverCallsConfigureOrEnrollment()
    {
        var text = File.ReadAllText(ScriptPath);
        // Comments/documentation may mention these terms. Reject only executable forms
        // that could invoke configure or consume an enrollment token.
        Assert.DoesNotMatch(@"(?im)^\s*(?:&|Start-Process|Invoke-Expression)\b[^\r\n]*--configure\b", text);
        Assert.DoesNotMatch(@"(?im)^\s*\[?string\]?\s*\$EnrollmentToken\b", text);
        Assert.DoesNotMatch(@"(?im)^\s*(?:&|Start-Process|Invoke-Expression)\b[^\r\n]*(?:EnrollmentToken|enrollment-token)\b", text);
    }

    [Fact]
    public void Task010_Upgrade_ScriptNeverTouchesProgramDataPathDirectly()
    {
        var text = File.ReadAllText(ScriptPath);
        // The only reference to the data path must be the read-only existence check and the
        // final "StatePreserved" message; it must never appear as a Copy-Item/Remove-Item target.
        foreach (var line in text.Split('\n'))
        {
            if (line.Contains("$dataPath", StringComparison.Ordinal))
            {
                Assert.False(
                    line.Contains("Remove-Item", StringComparison.OrdinalIgnoreCase) ||
                    line.Contains("Copy-Item", StringComparison.OrdinalIgnoreCase),
                    $"ProgramData path must never be a Copy-Item/Remove-Item target: {line}");
            }
        }
    }

    [Fact]
    public void Task010_Upgrade_ScriptDoesNotAccessNetworkEndpoints()
    {
        var text = File.ReadAllText(ScriptPath);
        Assert.DoesNotContain("Invoke-WebRequest", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Invoke-RestMethod", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("nexora.design.local", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("http://", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("https://", text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Task010_Upgrade_RunbookDoesNotReferenceOldInstallerOrEnrollmentToken()
    {
        var runbook = File.ReadAllText(Path.Combine(RepoRoot, "docs", "task010-agent-upgrade-runbook.md"));
        Assert.DoesNotContain("install-agent.ps1", runbook, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("-EnrollmentToken", runbook, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("enrollment-token", runbook, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Task010_Upgrade_NoProductionSecretsInTestEnvironment()
    {
        Assert.Null(Environment.GetEnvironmentVariable("ADMIN_API_TOKEN"));
        Assert.Null(Environment.GetEnvironmentVariable("ENROLLMENT_SECRET"));
    }

    // ---------------------------------------------------------------------------------
    // Real, ordered, end-to-end acceptance run. All scenarios that need the "NexoraAgent"
    // service or the pinned Program Files/ProgramData paths live in this single Fact so
    // ordering across them is guaranteed (xUnit does not order independent Facts, and the
    // script intentionally pins to one global service name/install path).
    // ---------------------------------------------------------------------------------

    [Fact]
    public async Task Task010_Upgrade_RealServiceLifecycle_AllInvariants()
    {
        // [13] Missing existing installation fails safely, before any state exists.
        var missingInstallResult = RunUpgradeScript("-SourcePath", Path.Combine(_work, "nowhere"));
        Assert.NotEqual(0, missingInstallResult.ExitCode);
        Assert.Contains("was not found", missingInstallResult.StdErr, StringComparison.OrdinalIgnoreCase);
        Assert.False(Directory.Exists(InstallPath), "[13] install path must not be created by a failed upgrade attempt");

        // --- Establish a real 0.4.0 baseline purely to exercise the downgrade guard in isolation.
        var v040 = await PublishStubAsync("0.4.0", crash: false);
        InstallAndStartService(Path.Combine(v040, "nexora-agent.exe"));
        SeedProgramData(out var deviceId, out var credentialsBytes);

        var v030ForDowngrade = await PublishStubAsync("0.3.0", crash: false);
        var installedMetadata = FileVersionInfo.GetVersionInfo(Path.Combine(InstallPath, "nexora-agent.exe"));
        var candidateMetadata = FileVersionInfo.GetVersionInfo(Path.Combine(v030ForDowngrade, "nexora-agent.exe"));
        var installedVersion = ParseVersion(installedMetadata.ProductVersion, installedMetadata.FileVersion);
        var candidateVersion = ParseVersion(candidateMetadata.ProductVersion, candidateMetadata.FileVersion);
        Assert.NotNull(installedVersion);
        Assert.NotNull(candidateVersion);
        Assert.True(candidateVersion < installedVersion,
            $"Fixture is not a downgrade: installed ProductVersion={installedMetadata.ProductVersion}, FileVersion={installedMetadata.FileVersion}; candidate ProductVersion={candidateMetadata.ProductVersion}, FileVersion={candidateMetadata.FileVersion}");
        var downgradeResult = RunUpgradeScript("-SourcePath", v030ForDowngrade, "-TargetVersion", "0.3.0");
        Assert.NotEqual(0, downgradeResult.ExitCode);
        Assert.Contains("downgrade", downgradeResult.StdErr, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("Running", GetServiceStatus());
        Assert.StartsWith("0.4.0", GetInstalledProductVersion());
        AssertProgramDataUnchanged(deviceId, credentialsBytes); // [17]

        // --- Re-baseline at a real 0.2.0 install for the main upgrade-to-0.3.0 scenarios.
        RemoveServiceAndStateIfPresent();
        var v020 = await PublishStubAsync("0.2.0", crash: false);
        InstallAndStartService(Path.Combine(v020, "nexora-agent.exe"));
        SeedProgramData(out deviceId, out credentialsBytes);
        var installedExePath = Path.Combine(InstallPath, "nexora-agent.exe");
        var baselineExeHash = Sha256OfFile(installedExePath);

        var v030 = await PublishStubAsync("0.3.0", crash: false);
        var v030Zip = Path.Combine(_work, "good-0.3.0.zip");
        CreateZip(v030, v030Zip);
        var v030Hash = Sha256OfFile(v030Zip);

        // [12][29] Bad SHA aborts before any change is made.
        var badShaResult = RunUpgradeScript("-PackagePath", v030Zip, "-ExpectedSha256", "0".PadRight(64, '0'));
        Assert.NotEqual(0, badShaResult.ExitCode);
        Assert.Contains("SHA-256 mismatch", badShaResult.StdErr, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("Running", GetServiceStatus());
        Assert.StartsWith("0.2.0", GetInstalledProductVersion());
        Assert.Equal(baselineExeHash, Sha256OfFile(installedExePath)); // [26]-equivalent: install binary untouched
        AssertProgramDataUnchanged(deviceId, credentialsBytes);

        // [2][ZIP Slip] A malicious archive is rejected and never writes outside the staging tree.
        var maliciousZip = Path.Combine(_work, "malicious.zip");
        CreateZipSlipArchive(maliciousZip);
        var maliciousHash = Sha256OfFile(maliciousZip);
        var zipSlipResult = RunUpgradeScript("-PackagePath", maliciousZip, "-ExpectedSha256", maliciousHash);
        Assert.NotEqual(0, zipSlipResult.ExitCode);
        Assert.Contains("zip-slip", zipSlipResult.StdErr, StringComparison.OrdinalIgnoreCase);
        // The staging directory is BackupRoot\Staging_<timestamp>, so a "../evil.txt" entry
        // that escaped the guard would land directly in BackupRoot; confirm it did not.
        Assert.False(File.Exists(Path.Combine(BackupRoot, "evil.txt")), "[ZIP Slip] entry must not escape the staging directory");
        Assert.False(File.Exists(Path.Combine(BackupRoot, "..", "evil.txt")), "[ZIP Slip] entry must not escape further up the tree");
        Assert.Equal("Running", GetServiceStatus());
        AssertProgramDataUnchanged(deviceId, credentialsBytes);

        // [23] Incomplete publish folder (apphost only) fails before replacement.
        var incomplete = Path.Combine(_work, "incomplete");
        Directory.CreateDirectory(incomplete);
        File.Copy(Path.Combine(v030, "nexora-agent.exe"), Path.Combine(incomplete, "nexora-agent.exe"));
        var incompleteResult = RunUpgradeScript("-SourcePath", incomplete);
        Assert.NotEqual(0, incompleteResult.ExitCode);
        Assert.Contains("self-contained", incompleteResult.StdErr, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("Running", GetServiceStatus());
        Assert.StartsWith("0.2.0", GetInstalledProductVersion());

        // [14][15][16][17] New-binary start failure rolls back completely.
        var broken = await PublishStubAsync("0.3.0", crash: true);
        var brokenZip = Path.Combine(_work, "broken-0.3.0.zip");
        CreateZip(broken, brokenZip);
        var brokenHash = Sha256OfFile(brokenZip);
        var rollbackResult = RunUpgradeScript("-PackagePath", brokenZip, "-ExpectedSha256", brokenHash);
        Assert.NotEqual(0, rollbackResult.ExitCode);
        Assert.Contains("restored", rollbackResult.StdErr, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("Running", GetServiceStatus()); // [16] old binaries restored and started
        Assert.StartsWith("0.2.0", GetInstalledProductVersion());
        AssertProgramDataUnchanged(deviceId, credentialsBytes); // [17]

        // --- Happy path: real upgrade 0.2.0 -> 0.3.0, package delivered from a path containing spaces. [20]
        var spacedDir = Path.Combine(_work, "release package with spaces");
        Directory.CreateDirectory(spacedDir);
        var spacedZip = Path.Combine(spacedDir, "nexora-agent win-x64 0.3.0.zip");
        File.Copy(v030Zip, spacedZip);
        var upgradeResult = RunUpgradeScript("-PackagePath", spacedZip, "-ExpectedSha256", v030Hash);
        Assert.Equal(0, upgradeResult.ExitCode);
        Assert.Equal("Running", GetServiceStatus()); // [09]
        Assert.Equal("Automatic", GetServiceStartType()); // [10]
        Assert.StartsWith("0.3.0", GetInstalledProductVersion()); // [11]
        AssertProgramDataUnchanged(deviceId, credentialsBytes); // [01][02][26][27]
        Assert.True(Directory.Exists(BackupRoot) && Directory.GetDirectories(BackupRoot, "Backup_*").Length > 0, "rollback evidence backup must be retained");

        // [21] Same-version rerun is deterministic and safe.
        var rerunZip = Path.Combine(_work, "good-0.3.0-rerun.zip");
        File.Copy(v030Zip, rerunZip);
        var rerunResult = RunUpgradeScript("-PackagePath", rerunZip, "-ExpectedSha256", v030Hash);
        Assert.Equal(0, rerunResult.ExitCode);
        Assert.Equal("Running", GetServiceStatus());
        Assert.StartsWith("0.3.0", GetInstalledProductVersion());
        AssertProgramDataUnchanged(deviceId, credentialsBytes);

        // [19] Interrupted previous upgrade: service left Stopped outside the script, then a
        // normal upgrade run still succeeds and ends Running.
        RunPs($"Stop-Service -Name {ServiceName} -Force");
        Assert.Equal("Stopped", GetServiceStatus());
        var recoveredZip = Path.Combine(_work, "good-0.3.0-recovered.zip");
        File.Copy(v030Zip, recoveredZip);
        var recoveredResult = RunUpgradeScript("-PackagePath", recoveredZip, "-ExpectedSha256", v030Hash);
        Assert.Equal(0, recoveredResult.ExitCode);
        Assert.Equal("Running", GetServiceStatus());
        AssertProgramDataUnchanged(deviceId, credentialsBytes);

        // [SourcePath flow] The folder-based (non-package) path also completes and preserves identity.
        var v030Extracted = Path.Combine(_work, "extracted-0.3.0");
        Directory.CreateDirectory(v030Extracted);
        foreach (var file in Directory.GetFiles(v030, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(v030, file);
            var destination = Path.Combine(v030Extracted, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(file, destination, overwrite: true);
        }
        var sourcePathResult = RunUpgradeScript("-SourcePath", v030Extracted);
        Assert.Equal(0, sourcePathResult.ExitCode);
        Assert.Equal("Running", GetServiceStatus());
        Assert.StartsWith("0.3.0", GetInstalledProductVersion());
        AssertProgramDataUnchanged(deviceId, credentialsBytes);
    }

    // ---------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        if (dir is null) throw new InvalidOperationException("Could not locate repository root (.git not found above test output directory).");
        return dir.FullName;
    }

    private async Task<string> PublishStubAsync(string version, bool crash)
    {
        var output = Path.Combine(_work, "publish-" + version + (crash ? "-crash" : "") + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(output);
        var psi = new ProcessStartInfo("dotnet") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        psi.ArgumentList.Add("publish");
        psi.ArgumentList.Add(StubProject);
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add("Release");
        psi.ArgumentList.Add("-r");
        psi.ArgumentList.Add("win-x64");
        psi.ArgumentList.Add("--self-contained");
        psi.ArgumentList.Add("true");
        psi.ArgumentList.Add("-o");
        psi.ArgumentList.Add(output);
        psi.ArgumentList.Add($"-p:Version={version}");
        psi.ArgumentList.Add($"-p:AssemblyVersion={version}.0");
        psi.ArgumentList.Add($"-p:InformationalVersion={version}");
        psi.ArgumentList.Add($"-p:FileVersion={version}.0");
        if (crash) psi.ArgumentList.Add("-p:DefineConstants=CRASH_ON_START");
        using var process = Process.Start(psi)!;
        var stdout = await process.StandardOutput.ReadToEndAsync();
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (process.ExitCode != 0) throw new InvalidOperationException($"dotnet publish failed for stub {version}: {stdout}\n{stderr}");
        return output;
    }

    private static void InstallAndStartService(string exePath)
    {
        RunPs($"New-Service -Name '{ServiceName}' -BinaryPathName '\"{exePath}\"' -DisplayName 'Nexora Agent Test' -StartupType Automatic | Out-Null; Start-Service -Name '{ServiceName}'; (Get-Service -Name '{ServiceName}').WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))");
    }

    private static void SeedProgramData(out Guid deviceId, out byte[] credentialsBytes)
    {
        Directory.CreateDirectory(DataPath);
        deviceId = Guid.NewGuid();
        File.WriteAllText(Path.Combine(DataPath, "device-id"), deviceId.ToString("D"));

        var storage = new SecureStorageService(new DpapiDataProtector());
        storage.SaveAsync(new StoredCredentials(deviceId.ToString("D"), "NX-TEST-000001", null, "test-bearer-token", null, null), CancellationToken.None).GetAwaiter().GetResult();
        credentialsBytes = File.ReadAllBytes(Path.Combine(DataPath, "credentials.dat"));
    }

    private static void AssertProgramDataUnchanged(Guid expectedDeviceId, byte[] expectedCredentialsBytes)
    {
        var deviceIdOnDisk = File.ReadAllText(Path.Combine(DataPath, "device-id")).Trim();
        Assert.Equal(expectedDeviceId.ToString("D"), deviceIdOnDisk);
        var credentialsOnDisk = File.ReadAllBytes(Path.Combine(DataPath, "credentials.dat"));
        Assert.Equal(expectedCredentialsBytes, credentialsOnDisk);
    }

    private static string GetInstalledProductVersion() =>
        FileVersionInfo.GetVersionInfo(Path.Combine(InstallPath, "nexora-agent.exe")).ProductVersion ?? string.Empty;

    private static string GetServiceStatus() => RunPs($"(Get-Service -Name {ServiceName}).Status").Trim();
    private static string GetServiceStartType() => RunPs($"(Get-Service -Name {ServiceName}).StartType").Trim();

    private static (int ExitCode, string StdOut, string StdErr) RunUpgradeScript(params string[] args)
    {
        var psi = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        psi.ArgumentList.Add("-NoProfile");
        psi.ArgumentList.Add("-NonInteractive");
        psi.ArgumentList.Add("-File");
        psi.ArgumentList.Add(ScriptPath);
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        using var process = Process.Start(psi)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, stdout, stderr);
    }

    private static string RunPs(string command)
    {
        var psi = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        psi.ArgumentList.Add("-NoProfile");
        psi.ArgumentList.Add("-NonInteractive");
        psi.ArgumentList.Add("-Command");
        psi.ArgumentList.Add(command);
        using var process = Process.Start(psi)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0) throw new InvalidOperationException($"PowerShell command failed ({process.ExitCode}): {command}\n{stdout}\n{stderr}");
        return stdout;
    }

    private static Version? ParseVersion(string? productVersion, string? fileVersion)
    {
        var value = productVersion ?? fileVersion;
        if (string.IsNullOrWhiteSpace(value)) value = fileVersion;
        var match = System.Text.RegularExpressions.Regex.Match(value ?? string.Empty, @"^\d+(\.\d+){1,3}");
        return match.Success ? Version.Parse(match.Value) : null;
    }

    private static void RemoveServiceAndStateIfPresent()
    {
        try { RunPs($"if (Get-Service -Name {ServiceName} -ErrorAction SilentlyContinue) {{ Stop-Service -Name {ServiceName} -Force -ErrorAction SilentlyContinue; sc.exe delete {ServiceName} | Out-Null; Start-Sleep -Seconds 1 }}"); } catch { /* nothing to remove */ }
        try { if (Directory.Exists(InstallPath)) Directory.Delete(InstallPath, recursive: true); } catch { /* best-effort */ }
        try { if (Directory.Exists(DataPath)) Directory.Delete(DataPath, recursive: true); } catch { /* best-effort */ }
        try { if (Directory.Exists(BackupRoot)) Directory.Delete(BackupRoot, recursive: true); } catch { /* best-effort */ }
    }

    private static string Sha256OfFile(string path)
    {
        using var sha = SHA256.Create();
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(sha.ComputeHash(stream));
    }

    private static void CreateZip(string sourceDirectory, string zipPath)
    {
        if (File.Exists(zipPath)) File.Delete(zipPath);
        ZipFile.CreateFromDirectory(sourceDirectory, zipPath, CompressionLevel.Fastest, includeBaseDirectory: false);
    }

    private static void CreateZipSlipArchive(string zipPath)
    {
        if (File.Exists(zipPath)) File.Delete(zipPath);
        using var stream = File.Create(zipPath);
        using var archive = new ZipArchive(stream, ZipArchiveMode.Create);

        var legit = archive.CreateEntry("nexora-agent.exe");
        using (var entryStream = legit.Open())
        {
            var bytes = Encoding.UTF8.GetBytes("not a real executable");
            entryStream.Write(bytes, 0, bytes.Length);
        }

        var evil = archive.CreateEntry("../evil.txt");
        using (var entryStream = evil.Open())
        {
            var bytes = Encoding.UTF8.GetBytes("zip-slip probe");
            entryStream.Write(bytes, 0, bytes.Length);
        }
    }
}
