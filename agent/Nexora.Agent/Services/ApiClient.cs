using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Nexora.Agent.Models;
using Nexora.Agent.Security;

namespace Nexora.Agent.Services;

public sealed class NexoraApiClient(HttpClient httpClient)
{
    public sealed record SigningKeyRegistration([property: JsonPropertyName("key_id")] string KeyId, [property: JsonPropertyName("key_fingerprint")] string KeyFingerprint, string Status);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    static NexoraApiClient() => JsonOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower));

    public async Task<EnrollmentResponse> EnrollAsync(EnrollmentRequest payload, CancellationToken cancellationToken)
    {
        using var response = await httpClient.PostAsJsonAsync("v1/agents/enroll", payload, JsonOptions, cancellationToken);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<EnrollmentResponse>(JsonOptions, cancellationToken)
            ?? throw new InvalidDataException("Enrollment response was empty");
    }

    public Task SendHeartbeatAsync(string token, HeartbeatPayload payload, CancellationToken cancellationToken) => SendAuthenticatedAsync("v1/agents/heartbeat", token, payload, cancellationToken);
    public Task SendInventoryAsync(string token, InventoryPayload payload, CancellationToken cancellationToken) => SendAuthenticatedAsync("v1/agents/inventory", token, payload, cancellationToken);
    public Task SendMetricsAsync(string token, MetricsPayload payload, CancellationToken cancellationToken) => SendAuthenticatedAsync("v1/agents/metrics", token, payload, cancellationToken);
    public Task SendServicesAsync(string token, ServiceSnapshot payload, CancellationToken cancellationToken) => SendAuthenticatedAsync("v1/agents/services/snapshot", token, payload, cancellationToken);
    public Task SendProcessesAsync(string token, ProcessSnapshot payload, CancellationToken cancellationToken) => SendAuthenticatedAsync("v1/agents/processes/snapshot", token, payload, cancellationToken);
    public async Task<SigningKeyRegistration> RegisterSigningKeyAsync(string token, string publicKey, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "v1/agent/signing-key") { Content = JsonContent.Create(new { algorithm = "ECDSA_P256_SHA256", public_key = publicKey, protocol_version = "remote_command_v1" }, options: JsonOptions) };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await httpClient.SendAsync(request, cancellationToken); response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<SigningKeyRegistration>(JsonOptions, cancellationToken) ?? throw new InvalidDataException("Signing key response was empty");
    }

    public async Task<HttpResponseMessage> SendSignedAsync(string token, string agentId, string keyId, ECDsa signingKey, HttpMethod method, string path, byte[] body, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, path) { Content = new ByteArrayContent(body) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        var signed = AgentRequestSigner.Sign(signingKey, method.Method, path, body, agentId, keyId);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("X-Nexora-Signature-Version", "nexora-agent-sign-v1"); request.Headers.Add("X-Nexora-Key-Id", keyId); request.Headers.Add("X-Nexora-Timestamp", signed.Timestamp); request.Headers.Add("X-Nexora-Nonce", signed.Nonce); request.Headers.Add("X-Nexora-Signature", signed.Signature);
        return await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
    }

    private async Task SendAuthenticatedAsync<T>(string path, string token, T payload, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(payload, options: JsonOptions),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
    }
}
