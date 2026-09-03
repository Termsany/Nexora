using System.Net.Http.Json;
using System.Text.Json;
using Nexora.Agent.Security;

namespace Nexora.Agent.Services;

public sealed class RemoteCommandService(NexoraApiClient api, AgentSigningService signing, ILogger<RemoteCommandService> logger)
{
    public async Task RunAsync(StoredCredentials credentials, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(credentials.AgentToken) || string.IsNullOrWhiteSpace(credentials.AgentId) || string.IsNullOrWhiteSpace(credentials.DeviceId) || string.IsNullOrWhiteSpace(credentials.SigningKeyId) || string.IsNullOrWhiteSpace(credentials.SigningPrivateKeyPkcs8)) return;
        using var key = signing.ImportKey(credentials.SigningPrivateKeyPkcs8);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var claim = await api.SendSignedAsync(credentials.AgentToken, credentials.AgentId, credentials.SigningKeyId, key, HttpMethod.Post, "v1/agent/remote-commands/claim", "{}"u8.ToArray(), cancellationToken);
                if (claim.IsSuccessStatusCode && claim.Content.Headers.ContentLength is > 0) { var job = await claim.Content.ReadFromJsonAsync<CommandEnvelope>(cancellationToken: cancellationToken); if (job is not null) await ExecuteAsync(credentials, key, job, cancellationToken); }
                await Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
            catch (Exception ex) { logger.LogWarning(ex, "RemoteCommandPollFailed"); await Task.Delay(TimeSpan.FromSeconds(30), cancellationToken); }
        }
    }
    private async Task ExecuteAsync(StoredCredentials c, System.Security.Cryptography.ECDsa key, CommandEnvelope job, CancellationToken ct)
    {
        var start = await api.SendSignedAsync(c.AgentToken!, c.AgentId!, c.SigningKeyId!, key, HttpMethod.Post, $"v1/agent/remote-commands/{job.Id}/start", JsonSerializer.SerializeToUtf8Bytes(new { execution_id = job.ExecutionId, execution_capability = job.ExecutionCapability }), ct); if (!start.IsSuccessStatusCode) return;
        using var executionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var heartbeat = Task.Run(async () => { while (!executionCts.IsCancellationRequested) { await Task.Delay(TimeSpan.FromSeconds(20), executionCts.Token); var hb = JsonSerializer.SerializeToUtf8Bytes(new { execution_id = job.ExecutionId, execution_capability = job.ExecutionCapability }); using var response = await api.SendSignedAsync(c.AgentToken!, c.AgentId!, c.SigningKeyId!, key, HttpMethod.Post, $"v1/agent/remote-commands/{job.Id}/heartbeat", hb, executionCts.Token); if (!response.IsSuccessStatusCode) break; } }, executionCts.Token);
        var cancelCheck = Task.Run(async () => { while (!executionCts.IsCancellationRequested) { await Task.Delay(TimeSpan.FromSeconds(5), executionCts.Token); var status = JsonSerializer.SerializeToUtf8Bytes(new { execution_id = job.ExecutionId, execution_capability = job.ExecutionCapability }); using var response = await api.SendSignedAsync(c.AgentToken!, c.AgentId!, c.SigningKeyId!, key, HttpMethod.Post, $"v1/agent/remote-commands/{job.Id}/status", status, executionCts.Token); if (response.IsSuccessStatusCode) { var state = await response.Content.ReadFromJsonAsync<CommandStatus>(cancellationToken: executionCts.Token); if (state?.CancelRequested == true) { executionCts.Cancel(); break; } } } }, executionCts.Token);
        var executor = new RemoteCommandExecutor(); RemoteCommandResult result; try { result = await executor.ExecuteAsync(job.Shell, job.Command, job.TimeoutSeconds, job.WorkingDirectory, executionCts.Token); } catch (OperationCanceledException) { result = new RemoteCommandResult(null, "", "", false, false, false); } finally { executionCts.Cancel(); try { await Task.WhenAll(heartbeat, cancelCheck); } catch (OperationCanceledException) { } }
        var body = JsonSerializer.SerializeToUtf8Bytes(new { execution_id = job.ExecutionId, execution_capability = job.ExecutionCapability, exit_code = result.ExitCode, stdout = result.Stdout, stderr = result.Stderr, stdout_truncated = result.StdoutTruncated, stderr_truncated = result.StderrTruncated });
        await api.SendSignedAsync(c.AgentToken!, c.AgentId!, c.SigningKeyId!, key, HttpMethod.Post, $"v1/agent/remote-commands/{job.Id}/result", body, ct);
    }
    private sealed record CommandEnvelope(string Id, [property: System.Text.Json.Serialization.JsonPropertyName("execution_id")] string ExecutionId, [property: System.Text.Json.Serialization.JsonPropertyName("execution_capability")] string ExecutionCapability, string Shell, string Command, [property: System.Text.Json.Serialization.JsonPropertyName("timeout_seconds")] int TimeoutSeconds, [property: System.Text.Json.Serialization.JsonPropertyName("working_directory")] string? WorkingDirectory);
    private sealed record CommandStatus([property: System.Text.Json.Serialization.JsonPropertyName("cancel_requested")] bool CancelRequested);
}
