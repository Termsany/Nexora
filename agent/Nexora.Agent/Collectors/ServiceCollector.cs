using System.Management;
using Nexora.Agent.Configuration;
using Nexora.Agent.Models;

namespace Nexora.Agent.Collectors;

public sealed class ServiceCollector
{
    public ServiceSnapshot Collect(DateTimeOffset? collectedAt = null)
    {
        var items = new Dictionary<string, ServiceInventory>(StringComparer.OrdinalIgnoreCase);
        var status = CollectionStatus.Complete;
        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT Name,DisplayName,State,StartMode,StartName,ServiceType,ProcessId,PathName,Description,DelayedAutoStart FROM Win32_Service");
            using var results = searcher.Get();
            foreach (ManagementObject service in results)
            {
                try
                {
                    var name = Text(service, "Name");
                    if (string.IsNullOrWhiteSpace(name)) { status = CollectionStatus.Partial; continue; }
                    items[name] = new ServiceInventory(name, Text(service, "DisplayName") ?? name,
                        NormalizeStatus(Text(service, "State")), NormalizeStartup(Text(service, "StartMode"), Bool(service, "DelayedAutoStart")),
                        Text(service, "StartName"), Text(service, "ServiceType"), PositiveInt(service, "ProcessId"),
                        Text(service, "PathName"), Text(service, "Description"), Bool(service, "DelayedAutoStart"));
                }
                catch { status = CollectionStatus.Partial; }
                finally { service.Dispose(); }
            }
        }
        catch { status = CollectionStatus.Failed; items.Clear(); }
        var at = collectedAt ?? DateTimeOffset.UtcNow;
        return new ServiceSnapshot(Guid.NewGuid(), at, status, items.Count, AgentVersion.Current, items.Values.OrderBy(x => x.ServiceName).ToArray());
    }

    public static ServiceState NormalizeStatus(string? value) => value?.Replace(" ", "", StringComparison.Ordinal).ToUpperInvariant() switch
    {
        "RUNNING" => ServiceState.Running, "STOPPED" => ServiceState.Stopped, "PAUSED" => ServiceState.Paused,
        "STARTPENDING" => ServiceState.StartPending, "STOPPENDING" => ServiceState.StopPending,
        "PAUSEPENDING" => ServiceState.PausePending, "CONTINUEPENDING" => ServiceState.ContinuePending, _ => ServiceState.Unknown,
    };

    public static ServiceStartupType NormalizeStartup(string? value, bool? delayed = false) => value?.Replace(" ", "", StringComparison.Ordinal).ToUpperInvariant() switch
    {
        "AUTO" or "AUTOMATIC" when delayed == true => ServiceStartupType.AutomaticDelayed,
        "AUTO" or "AUTOMATIC" => ServiceStartupType.Automatic, "MANUAL" or "DEMAND" => ServiceStartupType.Manual,
        "DISABLED" => ServiceStartupType.Disabled, "BOOT" => ServiceStartupType.Boot, "SYSTEM" => ServiceStartupType.System,
        _ => ServiceStartupType.Unknown,
    };

    private static string? Text(ManagementBaseObject item, string property) => item[property]?.ToString()?.Replace("\0", "", StringComparison.Ordinal).Trim() is { Length: > 0 } value ? value : null;
    private static bool? Bool(ManagementBaseObject item, string property) => item[property] is bool value ? value : null;
    private static int? PositiveInt(ManagementBaseObject item, string property) => int.TryParse(item[property]?.ToString(), out var value) && value > 0 ? value : null;
}
