using Nexora.Agent.Collectors;
using Nexora.Agent.Configuration;
using Nexora.Agent.Models;

namespace Nexora.Agent.Services;

public sealed class MetricsService(NexoraApiClient api, AgentOptions options, CpuCollector cpu, MemoryCollector memory, DiskCollector disks, UserCollector user, BackoffPolicy backoff, ILogger<MetricsService> logger)
{
    public async Task RunAsync(string token, CancellationToken cancellationToken)
    {
        var attempt = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            TimeSpan delay;
            try
            {
                var memorySnapshot = memory.Collect();
                var diskPercent = disks.Collect().Select(disk => disk.UsedPercent).DefaultIfEmpty(0).Max();
                var payload = new MetricsPayload(DateTimeOffset.UtcNow, cpu.Collect(), memorySnapshot.UsedPercent, memorySnapshot.UsedBytes, memorySnapshot.AvailableBytes, diskPercent, user.UptimeSeconds);
                await api.SendMetricsAsync(token, payload, cancellationToken);
                logger.LogDebug("MetricsSucceeded");
                attempt = 0;
                delay = TimeSpan.FromSeconds(options.MetricsIntervalSeconds);
            }
            catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
            {
                delay = backoff.Delay(attempt++);
                logger.LogWarning(exception, "MetricsFailed RetryScheduled DelaySeconds={DelaySeconds}", delay.TotalSeconds);
            }
            await Task.Delay(delay, cancellationToken);
        }
    }
}
