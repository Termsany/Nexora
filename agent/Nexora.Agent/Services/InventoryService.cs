using Nexora.Agent.Collectors;
using Nexora.Agent.Configuration;
using Nexora.Agent.Models;

namespace Nexora.Agent.Services;

public sealed class InventoryService(IdentityService identity, NexoraApiClient api, AgentOptions options, OperatingSystemCollector os, HardwareCollector hardware, DiskCollector disks, NetworkCollector network, SoftwareCollector software, UserCollector user, BackoffPolicy backoff, ILogger<InventoryService> logger)
{
    public async Task RunAsync(string token, CancellationToken cancellationToken)
    {
        var attempt = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            TimeSpan delay;
            try
            {
                var started = DateTimeOffset.UtcNow;
                var softwareSnapshot = software.Collect(started);
                var payload = new InventoryPayload(await identity.GetOrCreateAsync(cancellationToken), Environment.MachineName, AgentVersion.Current, user.CurrentUser, user.Domain, os.Collect(), hardware.Collect(), disks.Collect(), network.Collect(), softwareSnapshot);
                await api.SendInventoryAsync(token, payload, cancellationToken);
                logger.LogInformation("SoftwareInventoryCollected Complete={Complete} Count={Count} DurationMs={DurationMs}", softwareSnapshot.Complete, softwareSnapshot.Entries.Count, (DateTimeOffset.UtcNow - started).TotalMilliseconds);
                logger.LogInformation("InventorySucceeded");
                attempt = 0;
                delay = TimeSpan.FromHours(options.InventoryIntervalHours) + TimeSpan.FromMinutes(Random.Shared.NextDouble() * 10);
            }
            catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
            {
                delay = backoff.Delay(attempt++);
                logger.LogWarning(exception, "InventoryFailed RetryScheduled DelaySeconds={DelaySeconds}", delay.TotalSeconds);
            }
            await Task.Delay(delay, cancellationToken);
        }
    }
}
