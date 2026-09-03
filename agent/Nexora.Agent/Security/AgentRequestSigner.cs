using System.Security.Cryptography;
using System.Text;

namespace Nexora.Agent.Security;

public sealed class AgentRequestSigner
{
    public static (string Timestamp, string Nonce, string Signature) Sign(ECDsa key, string method, string path, ReadOnlySpan<byte> body, string agentId, string keyId)
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var digest = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
        var canonical = string.Join("\n", "nexora-agent-sign-v1", method.ToUpperInvariant(), path, digest, timestamp, nonce, agentId, keyId);
        var signature = Convert.ToBase64String(key.SignData(Encoding.UTF8.GetBytes(canonical), HashAlgorithmName.SHA256));
        return (timestamp, nonce, signature);
    }
}
