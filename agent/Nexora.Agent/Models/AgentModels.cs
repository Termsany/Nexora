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
    [property: JsonPropertyName("timestamp_utc")] DateTimeOffset TimestampUtc,
    [property: JsonPropertyName("capabilities")] IReadOnlyList<string>? Capabilities = null);

public sealed record OperatingSystemInventory(string Name, string Version, string Build, string Architecture);
public sealed record HardwareInventory(string? Manufacturer, string? Model, string? CpuModel, int LogicalProcessors, long TotalRamBytes, string? BiosVersion);
public sealed record DiskInventory(string Drive, string Filesystem, long TotalBytes, long UsedBytes, long FreeBytes, double UsedPercent);
public sealed record NetworkInventory(string Name, string InterfaceType, string Ipv4, string Mac, string Gateway, IReadOnlyList<string> DnsServers);
public enum SoftwareArchitecture { Unknown, X64, X86 }
public sealed record SoftwareInventory(
    string Name,
    string? Version,
    string? Publisher,
    DateTimeOffset? InstallDate,
    string? InstallLocation,
    bool UninstallAvailable,
    string? ProductCode,
    SoftwareArchitecture Architecture,
    string Source,
    bool SystemComponent,
    string Identity);
public sealed record SoftwareSnapshot(bool Complete, DateTimeOffset CollectedAt, string? ErrorCode, IReadOnlyList<SoftwareInventory> Entries);

public enum CollectionStatus { Complete, Partial, Failed }
public enum ServiceState { Running, Stopped, Paused, StartPending, StopPending, PausePending, ContinuePending, Unknown }
public enum ServiceStartupType { Automatic, AutomaticDelayed, Manual, Disabled, Boot, System, Unknown }
public enum ProcessArchitecture { X64, X86, Arm64, Unknown }
public sealed record ServiceInventory(string ServiceName, string DisplayName, ServiceState Status, ServiceStartupType StartupType,
    string? LogonAs, string? ServiceType, int? ProcessId, string? BinaryPath, string? Description, bool? DelayedAutoStart);
public sealed record ServiceSnapshot(Guid SnapshotId, DateTimeOffset CollectedAt, CollectionStatus CollectionStatus,
    int ItemCount, string AgentVersion, IReadOnlyList<ServiceInventory> Items);
public sealed record ProcessInventory(int Pid, string ProcessName, string? ExecutablePath, string? Username,
    double CpuTimeSeconds, double? CpuPercent, long WorkingSetBytes, long? PrivateMemoryBytes, int? ThreadCount,
    int? HandleCount, DateTimeOffset StartedAt, ProcessArchitecture Architecture, int? SessionId);
public sealed record ProcessSnapshot(Guid SnapshotId, DateTimeOffset CollectedAt, CollectionStatus CollectionStatus,
    int ItemCount, string AgentVersion, IReadOnlyList<ProcessInventory> Items);

public sealed record InventoryPayload(
    Guid DeviceUuid,
    string Hostname,
    string AgentVersion,
    string? CurrentUser,
    string? Domain,
    OperatingSystemInventory Os,
    HardwareInventory Hardware,
    IReadOnlyList<DiskInventory> Disks,
    IReadOnlyList<NetworkInventory> Network,
    SoftwareSnapshot? Software = null);

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
    long UptimeSeconds,
    IReadOnlyList<DiskInventory> Disks);
