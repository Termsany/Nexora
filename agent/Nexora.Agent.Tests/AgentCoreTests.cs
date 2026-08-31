using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Win32;
using Nexora.Agent.Collectors;
using Nexora.Agent.Models;
using Nexora.Agent.Security;
using Nexora.Agent.Services;
using Nexora.Agent.Utilities;
using Xunit;

namespace Nexora.Agent.Tests;

public sealed class AgentCoreTests
{
    [Theory]
    [InlineData("Running", ServiceState.Running)]
    [InlineData("Start Pending", ServiceState.StartPending)]
    [InlineData("invalid", ServiceState.Unknown)]
    public void ServiceStatusIsNormalized(string input, ServiceState expected) => Assert.Equal(expected, ServiceCollector.NormalizeStatus(input));

    [Theory]
    [InlineData("Auto", false, ServiceStartupType.Automatic)]
    [InlineData("Auto", true, ServiceStartupType.AutomaticDelayed)]
    [InlineData("Disabled", false, ServiceStartupType.Disabled)]
    public void ServiceStartupIsNormalized(string input, bool delayed, ServiceStartupType expected) => Assert.Equal(expected, ServiceCollector.NormalizeStartup(input, delayed));

    [Fact]
    public void ProcessCpuUsesDeltaWallTimeAndProcessorCount()
    {
        var at = DateTimeOffset.UtcNow;
        Assert.Null(ProcessCollector.CalculateCpuPercent(TimeSpan.Zero, TimeSpan.FromSeconds(1), at, at, 4));
        Assert.Equal(25, ProcessCollector.CalculateCpuPercent(TimeSpan.Zero, TimeSpan.FromSeconds(1), at, at.AddSeconds(1), 4));
        Assert.Equal(100, ProcessCollector.CalculateCpuPercent(TimeSpan.Zero, TimeSpan.FromSeconds(20), at, at.AddSeconds(1), 4));
    }

    [Fact]
    public void ProcessIdentityIncludesPidAndStartTime()
    {
        var first = new ProcessInventory(42, "test", null, null, 0, null, long.MaxValue, null, null, null, DateTimeOffset.UnixEpoch, ProcessArchitecture.Unknown, 0);
        var reused = first with { StartedAt = DateTimeOffset.UnixEpoch.AddSeconds(1) };
        Assert.NotEqual((first.Pid, first.StartedAt), (reused.Pid, reused.StartedAt));
        Assert.Equal(long.MaxValue, first.WorkingSetBytes);
    }

    [Fact]
    public void SoftwareCollectorDiscoversX64AndX86WithoutWin32Product()
    {
        var collector = new SoftwareCollector(new StubRegistry([
            Entry("Chrome", SoftwareArchitecture.X64, "Google Chrome", "127", "Google LLC"),
            Entry("7zip", SoftwareArchitecture.X86, "7-Zip", "24.07", "Igor Pavlov"),
        ]));
        var snapshot = collector.Collect();
        Assert.True(snapshot.Complete);
        Assert.Equal(2, snapshot.Entries.Count);
        Assert.Contains(snapshot.Entries, item => item.Architecture == SoftwareArchitecture.X64);
        Assert.Contains(snapshot.Entries, item => item.Architecture == SoftwareArchitecture.X86);
    }

    [Fact]
    public void SoftwareCollectorFiltersMissingNamesAndMarksSystemComponents()
    {
        var unnamed = Entry("hidden", SoftwareArchitecture.X64, null, null, null);
        var component = Entry("runtime", SoftwareArchitecture.X64, "Runtime", null, "Vendor", systemComponent: 1);
        var snapshot = new SoftwareCollector(new StubRegistry([unnamed, component])).Collect();
        Assert.Single(snapshot.Entries);
        Assert.True(snapshot.Entries[0].SystemComponent);
        Assert.Null(snapshot.Entries[0].Version);
    }

    [Fact]
    public void SoftwareIdentityIsNormalizedAndVersionIndependent()
    {
        var first = SoftwareCollector.Identity(" Google   Chrome ", "Google LLC", SoftwareArchitecture.X64);
        var second = SoftwareCollector.Identity("google chrome", " google llc ", SoftwareArchitecture.X64);
        Assert.Equal(first, second);
        Assert.NotEqual(first, SoftwareCollector.Identity("Google Chrome", "Google LLC", SoftwareArchitecture.X86));
    }

    [Fact]
    public void SoftwareCollectorRemovesRegistryNullCharacters()
    {
        var snapshot = new SoftwareCollector(new StubRegistry([Entry("nul", SoftwareArchitecture.X64, "App\0", "1.0\0", "Vendor\0")])).Collect();
        Assert.Equal("App", snapshot.Entries[0].Name);
        Assert.Equal("1.0", snapshot.Entries[0].Version);
        Assert.Equal("Vendor", snapshot.Entries[0].Publisher);
    }

    [Fact]
    public void DuplicateRegistryRepresentationsCollapseToRicherRecord()
    {
        var entries = new[] {
            Entry("one", SoftwareArchitecture.X64, "App", null, "Vendor"),
            Entry("two", SoftwareArchitecture.X64, "App", "2.0", "Vendor"),
        };
        var snapshot = new SoftwareCollector(new StubRegistry(entries)).Collect();
        Assert.Single(snapshot.Entries);
        Assert.Equal("2.0", snapshot.Entries[0].Version);
    }

    [Fact]
    public void RegistryFailureProducesExplicitIncompleteSnapshot()
    {
        var snapshot = new SoftwareCollector(new StubRegistry([], fail: true)).Collect();
        Assert.False(snapshot.Complete);
        Assert.Empty(snapshot.Entries);
        Assert.Equal("InvalidOperationException", snapshot.ErrorCode);
    }
    [Fact]
    public async Task IdentityPersistsAcrossServiceInstances()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"nexora-tests-{Guid.NewGuid():N}");
        var path = Path.Combine(directory, "device-id");
        try
        {
            var first = await new IdentityService(NullLogger<IdentityService>.Instance, path).GetOrCreateAsync(CancellationToken.None);
            var second = await new IdentityService(NullLogger<IdentityService>.Instance, path).GetOrCreateAsync(CancellationToken.None);
            Assert.Equal(first, second);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task SecureStorageUsesProtectorAndRoundTrips()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"nexora-tests-{Guid.NewGuid():N}");
        var path = Path.Combine(directory, "credentials.dat");
        try
        {
            var protector = new ReversingProtector();
            var storage = new SecureStorageService(protector, path);
            var expected = new StoredCredentials("device", "agent", null, "secret");
            await storage.SaveAsync(expected, CancellationToken.None);
            Assert.Equal(expected, await storage.LoadAsync(CancellationToken.None));
            Assert.DoesNotContain("secret", await File.ReadAllTextAsync(path));
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
    }

    [Fact]
    public void BackoffIsBoundedAndProgressive()
    {
        var policy = new BackoffPolicy();
        var first = policy.Delay(0, new Random(1));
        var last = policy.Delay(99, new Random(1));
        Assert.InRange(first.TotalSeconds, 5, 6);
        Assert.InRange(last.TotalSeconds, 300, 360);
    }

    [Fact]
    public void MemoryCalculationNeverBecomesNegative()
    {
        var normal = new MemorySnapshot(1000, 250);
        var invalid = new MemorySnapshot(1000, 1500);
        Assert.Equal(750, normal.UsedBytes);
        Assert.Equal(75, normal.UsedPercent);
        Assert.Equal(0, invalid.UsedBytes);
        Assert.Equal(0, invalid.UsedPercent);
    }

    [Theory]
    [InlineData(1000, 250, 75)]
    [InlineData(0, 0, 0)]
    [InlineData(1000, 2000, 0)]
    public void DiskCalculationIsBounded(long total, long free, double expected) => Assert.Equal(expected, DiskUsage.Percentage(total, free));

    [Fact]
    public void EnrollmentPayloadUsesContractFieldNames()
    {
        var payload = new EnrollmentRequest("secret", Guid.Empty, "PC", "hash", "0.1.0");
        var json = JsonSerializer.Serialize(payload);
        Assert.Contains("\"enrollment_token\"", json);
        Assert.Contains("\"device_uuid\"", json);
        Assert.DoesNotContain("EnrollmentToken", json);
    }

    [Fact]
    public async Task EnrollmentResponseIsParsed()
    {
        var handler = new StubHandler("{\"agent_id\":\"NX-000001\",\"device_id\":\"id\",\"agent_token\":\"token\",\"heartbeat_interval_seconds\":30}");
        var client = new NexoraApiClient(new HttpClient(handler) { BaseAddress = new Uri("https://nexora.example/api/") });
        var result = await client.EnrollAsync(new EnrollmentRequest("enroll", Guid.Empty, "PC", "hash", "0.1.0"), CancellationToken.None);
        Assert.Equal("NX-000001", result.AgentId);
        Assert.Equal("token", result.AgentToken);
    }

    private sealed class StubHandler(string response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.Created) { Content = new StringContent(response, Encoding.UTF8, "application/json") });
    }

    private sealed class ReversingProtector : IDataProtector
    {
        public byte[] Protect(byte[] data) => data.Reverse().ToArray();
        public byte[] Unprotect(byte[] data) => data.Reverse().ToArray();
    }

    private static UninstallRegistryEntry Entry(string key, SoftwareArchitecture architecture, string? name, string? version, string? publisher, int systemComponent = 0) =>
        new(key, architecture, new Dictionary<string, object?> { ["DisplayName"] = name, ["DisplayVersion"] = version, ["Publisher"] = publisher, ["SystemComponent"] = systemComponent, ["UninstallString"] = "present" });

    private sealed class StubRegistry(IReadOnlyList<UninstallRegistryEntry> entries, bool fail = false) : IUninstallRegistry
    {
        public IReadOnlyList<UninstallRegistryEntry> Read(RegistryView view)
        {
            if (fail) throw new InvalidOperationException("fixture failure");
            return entries.Where(item => item.Architecture == (view == RegistryView.Registry64 ? SoftwareArchitecture.X64 : SoftwareArchitecture.X86)).ToArray();
        }
    }
}
