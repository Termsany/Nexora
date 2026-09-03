using Nexora.Agent.Collectors;
using Nexora.Agent.Configuration;
using Nexora.Agent.Models;

namespace Nexora.Agent.Services;

public sealed class InventoryService(IdentityService identity, NexoraApiClient api, AgentOptions options, OperatingSystemCollector os, HardwareCollector hardware, DiskCollector disks, NetworkCollector network, UserCollector user, BackoffPolicy backoff, ILogger<InventoryService> logger)
{
    public async Task RunAsync(string token, CancellationToken cancellationToken)
    {
        var attempt = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            TimeSpan delay;
            try
            {
                var payload = new InventoryPayload(await identity.GetOrCreateAsync(cancellationToken), Environment.MachineName, AgentVersion.Current, user.CurrentUser, user.Domain, os.Collect(), hardware.Collect(), disks.Collect(), network.Collect());
                await api.SendInventoryAsync(token, payload, cancellationToken);
                logger.LogInformation("InventorySucceeded");
                attempt = 0;
                delay = TimeSpan.FromHours(options.InventoryIntervalHours);
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
