using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Nexora.Agent.Configuration;
using Nexora.Agent.Security;

namespace Nexora.Agent.Services;

public sealed class AgentWorker(
    EnrollmentService enrollment,
    HeartbeatService heartbeat,
    InventoryService inventory,
    MetricsService metrics,
    ServiceInventoryService services,
    ProcessInventoryService processes,
    RemoteCommandService remoteCommands,
    BackoffPolicy backoff,
    ILogger<AgentWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("AgentStarting Version={AgentVersion}", AgentVersion.Current);
        var attempt = 0;
        StoredCredentials credentials;
        while (true)
        {
            try
            {
                credentials = await enrollment.EnsureEnrolledAsync(stoppingToken);
                break;
            }
            catch (Exception exception) when (!stoppingToken.IsCancellationRequested)
            {
                var delay = backoff.Delay(attempt++);
                logger.LogWarning(exception, "EnrollmentFailed RetryScheduled DelaySeconds={DelaySeconds}", delay.TotalSeconds);
                await Task.Delay(delay, stoppingToken);
            }
        }

        await Task.WhenAll(
            heartbeat.RunAsync(credentials.AgentToken!, stoppingToken),
            inventory.RunAsync(credentials.AgentToken!, stoppingToken),
            metrics.RunAsync(credentials.AgentToken!, stoppingToken),
            services.RunAsync(credentials.AgentToken!, stoppingToken),
            processes.RunAsync(credentials.AgentToken!, stoppingToken),
            remoteCommands.RunAsync(credentials, stoppingToken));
    }

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        logger.LogInformation("AgentStopping");
        return base.StopAsync(cancellationToken);
    }
}
