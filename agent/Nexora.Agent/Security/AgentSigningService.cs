using System.Security.Cryptography;
using System.Text;

namespace Nexora.Agent.Security;

public sealed class AgentSigningService(SecureStorageService storage)
{
    public async Task<(StoredCredentials Credentials, ECDsa Key)> EnsureKeyAsync(StoredCredentials credentials, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(credentials.SigningPrivateKeyPkcs8)) return (credentials, Import(credentials.SigningPrivateKeyPkcs8));
        using var generated = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var encoded = Convert.ToBase64String(generated.ExportPkcs8PrivateKey());
        var publicKey = Convert.ToBase64String(generated.ExportSubjectPublicKeyInfo());
        var updated = credentials with { SigningPrivateKeyPkcs8 = encoded, SigningPublicKey = publicKey };
        await storage.SaveAsync(updated, cancellationToken);
        return (updated, Import(encoded));
    }

    private static ECDsa Import(string encoded) { var key = ECDsa.Create(); key.ImportPkcs8PrivateKey(Convert.FromBase64String(encoded), out _); return key; }
    public ECDsa ImportKey(string encoded) => Import(encoded);
}
