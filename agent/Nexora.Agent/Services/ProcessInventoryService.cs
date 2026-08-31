using Nexora.Agent.Collectors;
using Nexora.Agent.Configuration;

namespace Nexora.Agent.Services;

public sealed class ProcessInventoryService(ProcessCollector collector, NexoraApiClient api, AgentOptions options, BackoffPolicy backoff, ILogger<ProcessInventoryService> logger)
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
                await api.SendProcessesAsync(token, snapshot, cancellationToken);
                logger.LogInformation("ProcessesSnapshotSucceeded SnapshotId={SnapshotId} Status={Status} Count={Count}", snapshot.SnapshotId, snapshot.CollectionStatus, snapshot.ItemCount);
                attempt = 0; delay = TimeSpan.FromSeconds(options.ProcessesIntervalSeconds);
            }
            catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
            {
                delay = backoff.Delay(attempt++); logger.LogWarning(exception, "ProcessesSnapshotFailed RetrySeconds={RetrySeconds}", delay.TotalSeconds);
            }
            await Task.Delay(delay, cancellationToken);
        }
    }
}
