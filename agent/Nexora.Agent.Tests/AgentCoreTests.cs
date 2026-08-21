using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Nexora.Agent.Models;
using Nexora.Agent.Security;
using Nexora.Agent.Services;
using Nexora.Agent.Utilities;
using Xunit;

namespace Nexora.Agent.Tests;

public sealed class AgentCoreTests
{
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
}
