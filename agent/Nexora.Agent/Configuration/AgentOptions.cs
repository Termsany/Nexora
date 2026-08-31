namespace Nexora.Agent.Configuration;

public sealed record AgentOptions(
    string ApiBaseUrl,
    string? EnrollmentToken,
    int HeartbeatIntervalSeconds = 30,
    int MetricsIntervalSeconds = 30,
    int InventoryIntervalHours = 6,
    int ServicesIntervalSeconds = 300,
    int ProcessesIntervalSeconds = 60,
    int RequestTimeoutSeconds = 30);

public static class AgentVersion
{
    public const string Current = "0.3.0";
}
