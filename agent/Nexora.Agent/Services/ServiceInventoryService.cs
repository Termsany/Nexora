using Nexora.Agent.Collectors;
using Nexora.Agent.Configuration;

namespace Nexora.Agent.Services;

public sealed class ServiceInventoryService(ServiceCollector collector, NexoraApiClient api, AgentOptions options, BackoffPolicy backoff, ILogger<ServiceInventoryService> logger)
{
    public async Task RunAsync(string token, CancellationToken cancellationToken)
    {
        var attempt = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            TimeSpan delay;
            try
            {
                var snapshot = await Task.Run(() => collector.Collect(), cancellationToken).WaitAsync(TimeSpan.FromSeconds(20), cancellationToken);
                await api.SendServicesAsync(token, snapshot, cancellationToken);
                logger.LogInformation("ServicesSnapshotSucceeded SnapshotId={SnapshotId} Status={Status} Count={Count}", snapshot.SnapshotId, snapshot.CollectionStatus, snapshot.ItemCount);
                attempt = 0; delay = TimeSpan.FromSeconds(options.ServicesIntervalSeconds);
            }
            catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
            {
                delay = backoff.Delay(attempt++); logger.LogWarning(exception, "ServicesSnapshotFailed RetrySeconds={RetrySeconds}", delay.TotalSeconds);
            }
            await Task.Delay(delay, cancellationToken);
        }
    }
}
