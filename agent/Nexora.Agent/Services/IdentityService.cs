using System.Security.Cryptography;
using System.Text.Json;

namespace Nexora.Agent.Services;

public sealed class IdentityService
{
    private readonly string directory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Nexora", "Agent");
    private string FilePath => Path.Combine(directory, "identity.json");

    public async Task<AgentIdentity> GetOrCreateAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(directory);
        if (File.Exists(FilePath))
        {
            var existing = await JsonSerializer.DeserializeAsync<AgentIdentity>(
                File.OpenRead(FilePath), cancellationToken: cancellationToken);
            if (existing is not null) return existing;
        }

        var identity = new AgentIdentity(Guid.NewGuid(), null, null);
        await File.WriteAllTextAsync(FilePath, JsonSerializer.Serialize(identity), cancellationToken);
        return identity;
    }
}

public sealed record AgentIdentity(Guid DeviceUuid, string? AgentId, string? AgentToken);