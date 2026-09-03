using Nexora.Agent.Collectors;
using Nexora.Agent.Configuration;
using Nexora.Agent.Models;

namespace Nexora.Agent.Services;

public sealed class HeartbeatService(NexoraApiClient api, AgentOptions options, UserCollector user, BackoffPolicy backoff, ILogger<HeartbeatService> logger)
{
    public async Task RunAsync(string token, CancellationToken cancellationToken)
    {
        var attempt = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            TimeSpan delay;
            try
            {
                await api.SendHeartbeatAsync(token, new HeartbeatPayload(AgentVersion.Current, user.UptimeSeconds, user.CurrentUser, DateTimeOffset.UtcNow, ["remote_command_v1"]), cancellationToken);
                logger.LogDebug("HeartbeatSucceeded");
                attempt = 0;
                delay = TimeSpan.FromSeconds(options.HeartbeatIntervalSeconds);
            }
            catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
            {
                delay = backoff.Delay(attempt++);
                logger.LogWarning(exception, "HeartbeatFailed RetryScheduled DelaySeconds={DelaySeconds}", delay.TotalSeconds);
            }
            await Task.Delay(delay, cancellationToken);
        }
    }
}
