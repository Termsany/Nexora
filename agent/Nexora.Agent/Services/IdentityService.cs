using System.Security.Cryptography;
using Microsoft.Win32;
using Nexora.Agent.Configuration;

namespace Nexora.Agent.Services;

public sealed class IdentityService(ILogger<IdentityService> logger, string? filePath = null)
{
    private string FilePath { get; } = filePath ?? Path.Combine(AgentConfiguration.DataDirectory, "device-id");

    public async Task<Guid> GetOrCreateAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath) ?? AgentConfiguration.DataDirectory);
        if (File.Exists(FilePath) && Guid.TryParse(await File.ReadAllTextAsync(FilePath, cancellationToken), out var existing))
        {
            logger.LogInformation("IdentityLoaded DeviceUuid={DeviceUuid}", existing);
            return existing;
        }
        var created = Guid.NewGuid();
        await File.WriteAllTextAsync(FilePath, created.ToString("D"), cancellationToken);
        logger.LogInformation("IdentityCreated DeviceUuid={DeviceUuid}", created);
        return created;
    }

    public string GetMachineGuidHash()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
        var machineGuid = key?.GetValue("MachineGuid")?.ToString() ?? throw new InvalidOperationException("Windows MachineGuid is unavailable");
        return Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(machineGuid))).ToLowerInvariant();
    }
}
