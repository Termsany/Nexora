using System.Text.Json;
using Nexora.Agent.Security;

namespace Nexora.Agent.Configuration;

public static class AgentConfiguration
{
    public static string DataDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Nexora", "Agent");
    public static string ConfigurationPath => Path.Combine(DataDirectory, "config.json");

    public static AgentOptions Load()
    {
        AgentOptions? file = null;
        if (File.Exists(ConfigurationPath))
            file = JsonSerializer.Deserialize<AgentOptions>(File.ReadAllText(ConfigurationPath));

        var apiUrl = Environment.GetEnvironmentVariable("NEXORA_API_URL") ?? file?.ApiBaseUrl;
        if (string.IsNullOrWhiteSpace(apiUrl))
            throw new InvalidOperationException("ApiBaseUrl is required. Run nexora-agent.exe --configure first.");

        return new AgentOptions(
            apiUrl,
            Environment.GetEnvironmentVariable("NEXORA_ENROLLMENT_TOKEN") ?? file?.EnrollmentToken,
            ReadInt("NEXORA_HEARTBEAT_INTERVAL_SECONDS", file?.HeartbeatIntervalSeconds ?? 30),
            ReadInt("NEXORA_METRICS_INTERVAL_SECONDS", file?.MetricsIntervalSeconds ?? 30),
            ReadInt("NEXORA_INVENTORY_INTERVAL_HOURS", file?.InventoryIntervalHours ?? 6),
            ReadInt("NEXORA_REQUEST_TIMEOUT_SECONDS", file?.RequestTimeoutSeconds ?? 30));
    }

    public static async Task ConfigureAsync(string[] args)
    {
        var apiUrl = Argument(args, "--api-base-url") ?? throw new ArgumentException("--api-base-url is required");
        var enrollmentToken = Argument(args, "--enrollment-token") ?? throw new ArgumentException("--enrollment-token is required");
        if (!Uri.TryCreate(apiUrl, UriKind.Absolute, out var uri) || (uri.Scheme != "https" && !uri.IsLoopback))
            throw new ArgumentException("ApiBaseUrl must use HTTPS unless it targets loopback.");

        Directory.CreateDirectory(DataDirectory);
        var options = new AgentOptions(apiUrl.TrimEnd('/'), null);
        await File.WriteAllTextAsync(ConfigurationPath, JsonSerializer.Serialize(options, new JsonSerializerOptions { WriteIndented = true }));
        var storage = new SecureStorageService(new DpapiDataProtector());
        await storage.SaveAsync(new StoredCredentials(null, null, enrollmentToken), CancellationToken.None);
        Console.WriteLine("Nexora Agent configuration saved.");
    }

    private static string? Argument(string[] args, string name)
    {
        var index = Array.FindIndex(args, value => value.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static int ReadInt(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;
}
