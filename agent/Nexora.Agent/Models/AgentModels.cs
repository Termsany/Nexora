using System.Text.Json.Serialization;

namespace Nexora.Agent.Models;

public sealed record EnrollmentRequest(
    [property: JsonPropertyName("enrollment_token")] string EnrollmentToken,
    [property: JsonPropertyName("device_uuid")] Guid DeviceUuid,
    [property: JsonPropertyName("hostname")] string Hostname,
    [property: JsonPropertyName("machine_guid_hash")] string MachineGuidHash,
    [property: JsonPropertyName("agent_version")] string AgentVersion);

public sealed record EnrollmentResponse(
    [property: JsonPropertyName("agent_id")] string AgentId,
    [property: JsonPropertyName("device_id")] string DeviceId,
    [property: JsonPropertyName("agent_token")] string AgentToken,
    [property: JsonPropertyName("heartbeat_interval_seconds")] int HeartbeatIntervalSeconds);

public sealed record HeartbeatPayload(
    [property: JsonPropertyName("agent_version")] string AgentVersion,
    [property: JsonPropertyName("uptime_seconds")] long UptimeSeconds,
    [property: JsonPropertyName("logged_in_user")] string? LoggedInUser,
    [property: JsonPropertyName("timestamp_utc")] DateTimeOffset TimestampUtc);

public sealed record OperatingSystemInventory(string Name, string Version, string Build, string Architecture);
public sealed record HardwareInventory(string? Manufacturer, string? Model, string? CpuModel, int LogicalProcessors, long TotalRamBytes, string? BiosVersion);
public sealed record DiskInventory(string Drive, string Filesystem, long TotalBytes, long UsedBytes, long FreeBytes, double UsedPercent);
public sealed record NetworkInventory(string Name, string InterfaceType, string Ipv4, string Mac, string Gateway, IReadOnlyList<string> DnsServers);

public sealed record InventoryPayload(
    Guid DeviceUuid,
    string Hostname,
    string AgentVersion,
    string? CurrentUser,
    string? Domain,
    OperatingSystemInventory Os,
    HardwareInventory Hardware,
    IReadOnlyList<DiskInventory> Disks,
    IReadOnlyList<NetworkInventory> Network);

public sealed record MemorySnapshot(long TotalBytes, long AvailableBytes)
{
    public long UsedBytes => Math.Max(0, TotalBytes - AvailableBytes);
    public double UsedPercent => TotalBytes <= 0 ? 0 : Math.Clamp(UsedBytes * 100d / TotalBytes, 0, 100);
}

public sealed record MetricsPayload(
    DateTimeOffset CapturedAt,
    double CpuPercent,
    double RamPercent,
    long RamUsedBytes,
    long RamAvailableBytes,
    double DiskPercent,
    long UptimeSeconds);
