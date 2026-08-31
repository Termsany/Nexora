using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Nexora.Agent.Configuration;

namespace Nexora.Agent.Security;

public interface IDataProtector
{
    byte[] Protect(byte[] data);
    byte[] Unprotect(byte[] data);
}

public sealed class DpapiDataProtector : IDataProtector
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Nexora.Agent.V1");

    public byte[] Protect(byte[] data) => ProtectedData.Protect(data, Entropy, DataProtectionScope.LocalMachine);
    public byte[] Unprotect(byte[] data) => ProtectedData.Unprotect(data, Entropy, DataProtectionScope.LocalMachine);
}

public sealed record StoredCredentials(string? DeviceId, string? AgentId, string? EnrollmentToken, string? AgentToken = null, string? SigningPrivateKeyPkcs8 = null, string? SigningKeyId = null, string? SigningPublicKey = null);

public sealed class SecureStorageService(IDataProtector protector, string? filePath = null)
{
    private string FilePath { get; } = filePath ?? Path.Combine(AgentConfiguration.DataDirectory, "credentials.dat");

    public async Task<StoredCredentials?> LoadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(FilePath)) return null;
        var encrypted = await File.ReadAllBytesAsync(FilePath, cancellationToken);
        var json = protector.Unprotect(encrypted);
        return JsonSerializer.Deserialize<StoredCredentials>(json);
    }

    public async Task SaveAsync(StoredCredentials credentials, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath) ?? AgentConfiguration.DataDirectory);
        var encrypted = protector.Protect(JsonSerializer.SerializeToUtf8Bytes(credentials));
        var temporary = FilePath + ".tmp";
        await File.WriteAllBytesAsync(temporary, encrypted, cancellationToken);
        File.Move(temporary, FilePath, true);
    }
}
