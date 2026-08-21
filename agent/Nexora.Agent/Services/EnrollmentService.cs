using Nexora.Agent.Configuration;
using Nexora.Agent.Models;
using Nexora.Agent.Security;

namespace Nexora.Agent.Services;

public sealed class EnrollmentService(IdentityService identity, SecureStorageService storage, NexoraApiClient api, AgentOptions options, ILogger<EnrollmentService> logger)
{
    public async Task<StoredCredentials> EnsureEnrolledAsync(CancellationToken cancellationToken)
    {
        var stored = await storage.LoadAsync(cancellationToken);
        if (!string.IsNullOrWhiteSpace(stored?.AgentToken)) return stored;
        var enrollmentToken = stored?.EnrollmentToken ?? options.EnrollmentToken;
        if (string.IsNullOrWhiteSpace(enrollmentToken)) throw new InvalidOperationException("No enrollment token is configured");

        logger.LogInformation("EnrollmentStarting");
        var deviceUuid = await identity.GetOrCreateAsync(cancellationToken);
        var result = await api.EnrollAsync(new EnrollmentRequest(enrollmentToken, deviceUuid, Environment.MachineName, identity.GetMachineGuidHash(), AgentVersion.Current), cancellationToken);
        var credentials = new StoredCredentials(result.DeviceId, result.AgentId, null, result.AgentToken);
        await storage.SaveAsync(credentials, cancellationToken);
        logger.LogInformation("EnrollmentSucceeded DeviceId={DeviceId} AgentId={AgentId}", result.DeviceId, result.AgentId);
        return credentials;
    }
}
