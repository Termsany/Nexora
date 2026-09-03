using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Nexora.Agent.Models;

namespace Nexora.Agent.Services;

public sealed class NexoraApiClient(HttpClient httpClient)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

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
