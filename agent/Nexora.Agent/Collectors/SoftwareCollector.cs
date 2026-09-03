using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
using Nexora.Agent.Models;

namespace Nexora.Agent.Collectors;

public sealed record UninstallRegistryEntry(string KeyName, SoftwareArchitecture Architecture, IReadOnlyDictionary<string, object?> Values);

public interface IUninstallRegistry
{
    IReadOnlyList<UninstallRegistryEntry> Read(RegistryView view);
}

public sealed class WindowsUninstallRegistry : IUninstallRegistry
{
    private const string UninstallPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

    public IReadOnlyList<UninstallRegistryEntry> Read(RegistryView view)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows registry is unavailable");
        var architecture = view == RegistryView.Registry64 ? SoftwareArchitecture.X64 : SoftwareArchitecture.X86;
        using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
        using var uninstall = baseKey.OpenSubKey(UninstallPath, false);
        if (uninstall is null) return [];
        var result = new List<UninstallRegistryEntry>();
        foreach (var name in uninstall.GetSubKeyNames())
        {
            using var key = uninstall.OpenSubKey(name, false);
            if (key is null) continue;
            var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            foreach (var valueName in new[] { "DisplayName", "DisplayVersion", "Publisher", "InstallDate", "InstallLocation", "UninstallString", "QuietUninstallString", "SystemComponent" })
                values[valueName] = key.GetValue(valueName);
            result.Add(new UninstallRegistryEntry(name, architecture, values));
        }
        return result;
    }
}

public sealed class SoftwareCollector(IUninstallRegistry registry)
{
    public SoftwareSnapshot Collect(DateTimeOffset? now = null)
    {
        var started = now ?? DateTimeOffset.UtcNow;
        try
        {
            var entries = registry.Read(RegistryView.Registry64).Concat(registry.Read(RegistryView.Registry32));
            var software = entries.Select(ToSoftware).Where(item => item is not null).Cast<SoftwareInventory>()
                .GroupBy(item => item.Identity, StringComparer.Ordinal)
                .Select(group => group.OrderByDescending(Richness).First())
                .OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
                .Take(5000)
                .ToArray();
            return new SoftwareSnapshot(true, started, null, software);
        }
        catch (Exception exception)
        {
            return new SoftwareSnapshot(false, started, exception.GetType().Name, []);
        }
    }

    public static string Normalize(string? value) => string.Join(' ', (value ?? "").Trim().ToLowerInvariant().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    public static string Identity(string name, string? publisher, SoftwareArchitecture architecture)
    {
        var input = $"{Normalize(publisher)}|{Normalize(name)}|{ArchitectureValue(architecture)}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input))).ToLowerInvariant();
    }

    private static SoftwareInventory? ToSoftware(UninstallRegistryEntry entry)
    {
        var name = Text(entry, "DisplayName");
        if (string.IsNullOrWhiteSpace(name)) return null;
        var publisher = Text(entry, "Publisher");
        var productCode = Guid.TryParse(entry.KeyName.Trim('{', '}'), out _) ? entry.KeyName : null;
        return new SoftwareInventory(
            name.Trim(), NullIfEmpty(Text(entry, "DisplayVersion")), NullIfEmpty(publisher), ParseInstallDate(Text(entry, "InstallDate")),
            NullIfEmpty(Text(entry, "InstallLocation")),
            !string.IsNullOrWhiteSpace(Text(entry, "UninstallString")) || !string.IsNullOrWhiteSpace(Text(entry, "QuietUninstallString")),
            productCode, entry.Architecture, "windows_registry", Integer(entry, "SystemComponent") == 1,
            Identity(name, publisher, entry.Architecture));
    }

    private static int Richness(SoftwareInventory item) => (item.Version is null ? 0 : 4) + (item.Publisher is null ? 0 : 2) + (item.InstallDate is null ? 0 : 1);
    private static string? Text(UninstallRegistryEntry entry, string key) => entry.Values.TryGetValue(key, out var value) ? value?.ToString()?.Replace("\0", "").Trim() : null;
    private static int Integer(UninstallRegistryEntry entry, string key) => int.TryParse(Text(entry, key), out var value) ? value : 0;
    private static string? NullIfEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    private static DateTimeOffset? ParseInstallDate(string? value) => DateTime.TryParseExact(value, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed) ? new DateTimeOffset(DateTime.SpecifyKind(parsed, DateTimeKind.Utc)) : null;
    private static string ArchitectureValue(SoftwareArchitecture value) => value switch { SoftwareArchitecture.X64 => "x64", SoftwareArchitecture.X86 => "x86", _ => "unknown" };
}
