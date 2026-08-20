using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace Nexora.Agent.Services;

public sealed class ApiClient(HttpClient httpClient)
{
    private string? token;
    private string BaseUrl => Environment.GetEnvironmentVariable("NEXORA_API_URL") ?? "http://localhost:5000/api";

    public async Task<bool> EnrollAsync(AgentIdentity identity, CancellationToken cancellationToken)
    {
        var enrollmentToken = Environment.GetEnvironmentVariable("NEXORA_ENROLLMENT_TOKEN");
        if (string.IsNullOrWhiteSpace(enrollmentToken)) return false;
        var response = await httpClient.PostAsJsonAsync($"{BaseUrl}/v1/agents/enroll", new
        {
            enrollment_token = enrollmentToken,
            device_uuid = identity.DeviceUuid,
            hostname = Environment.MachineName,
            machine_guid_hash = "managed-by-agent",
            agent_version = "0.1.0"
        }, cancellationToken);
        if (!response.IsSuccessStatusCode) return false;
        var result = await response.Content.ReadFromJsonAsync<EnrollmentResult>(cancellationToken: cancellationToken);
        token = result?.AgentToken;
        return !string.IsNullOrWhiteSpace(token);
    }

    public async Task SendHeartbeatAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token)) return;
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{BaseUrl}/v1/agents/heartbeat")
        {
            Content = JsonContent.Create(new { agent_version = "0.1.0", uptime_seconds = Environment.TickCount64 / 1000, logged_in_user = Environment.UserName })
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        await httpClient.SendAsync(request, cancellationToken);
    }

    private sealed record EnrollmentResult(string AgentToken);
}