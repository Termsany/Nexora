using System.Security.Cryptography;
using System.Text;

namespace Nexora.Agent.Security;

public sealed class AgentRequestSigner
{
    public static string CanonicalizePath(string path) =>
        path.StartsWith("/", StringComparison.Ordinal) ? path : "/" + path;

    public static (string Timestamp, string Nonce, string Signature) Sign(
        ECDsa key,
        string method,
        string path,
        ReadOnlySpan<byte> body,
        string agentId,
        string keyId)
    {
        var timestamp = DateTimeOffset.UtcNow
            .ToUnixTimeSeconds()
            .ToString(System.Globalization.CultureInfo.InvariantCulture);

        var nonce = Convert
            .ToHexString(RandomNumberGenerator.GetBytes(16))
            .ToLowerInvariant();

        var digest = Convert
            .ToHexString(SHA256.HashData(body))
            .ToLowerInvariant();

        var canonicalPath = CanonicalizePath(path);

        var canonical = string.Join(
            "\n",
            "nexora-agent-sign-v1",
            method.ToUpperInvariant(),
            canonicalPath,
            digest,
            timestamp,
            nonce,
            agentId,
            keyId);

        var signatureBytes = key.SignData(
            Encoding.UTF8.GetBytes(canonical),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);

        return (
            timestamp,
            nonce,
            Convert.ToBase64String(signatureBytes)
        );
    }
}
