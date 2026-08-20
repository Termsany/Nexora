using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Nexora.Agent.Services;

public sealed class AgentWorker(
    IdentityService identityService,
    ApiClient apiClient,
    ILogger<AgentWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var identity = await identityService.GetOrCreateAsync(stoppingToken);
        var backoff = TimeSpan.FromSeconds(5);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (await apiClient.EnrollAsync(identity, stoppingToken))
                {
                    await apiClient.SendHeartbeatAsync(stoppingToken);
                    backoff = TimeSpan.FromSeconds(5);
                    await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
                }
                else
                {
                    await Task.Delay(backoff, stoppingToken);
                    backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 300));
                }
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
            {
                logger.LogWarning(exception, "Nexora API unavailable; retrying with backoff");
                await Task.Delay(backoff, stoppingToken);
                backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 300));
            }
        }
    }
}