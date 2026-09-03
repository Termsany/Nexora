using System.Management;

namespace Nexora.Agent.Utilities;

internal static class Wmi
{
    public static ManagementObject? First(string query)
    {
        using var searcher = new ManagementObjectSearcher(query);
        using var results = searcher.Get();
        return results.Cast<ManagementObject>().FirstOrDefault();
    }

    public static string? Text(ManagementBaseObject? item, string property) => item?[property]?.ToString();
    public static long Integer(ManagementBaseObject? item, string property) => long.TryParse(Text(item, property), out var value) ? value : 0;
}
