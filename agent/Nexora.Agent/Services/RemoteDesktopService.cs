using System.Buffers.Binary;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Nexora.Agent.Configuration;
using Nexora.Agent.Security;
using Nexora.Agent.Services.RemoteDesktop;

namespace Nexora.Agent.Services;

/// <summary>
/// Remote Desktop V1 agent side.
///
/// Strictly outbound: the Agent polls the signed claim endpoint and, when a
/// session has been approved, dials a WSS channel back to Nexora. Nothing
/// listens on the customer machine, no firewall rule is needed, and no VNC or
/// RDP server is involved. The browser is never a peer - every frame and every
/// input event passes through Nexora.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class RemoteDesktopService(
    NexoraApiClient api,
    AgentSigningService signing,
    AgentOptions options,
    ILogger<RemoteDesktopService> logger)
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
    private const int MaxControlBytes = 8 * 1024;

    public async Task RunAsync(StoredCredentials credentials, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(credentials.AgentToken) || string.IsNullOrWhiteSpace(credentials.AgentId)
            || string.IsNullOrWhiteSpace(credentials.SigningKeyId) || string.IsNullOrWhiteSpace(credentials.SigningPrivateKeyPkcs8)) return;

        using var key = signing.ImportKey(credentials.SigningPrivateKeyPkcs8);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using var claim = await api.SendSignedAsync(credentials.AgentToken, credentials.AgentId, credentials.SigningKeyId, key,
                    HttpMethod.Post, "v1/agent/remote-desktop/claim", "{}"u8.ToArray(), cancellationToken);
                if (claim.IsSuccessStatusCode && claim.Content.Headers.ContentLength is > 0)
                {
                    var envelope = await claim.Content.ReadFromJsonAsync<SessionEnvelope>(cancellationToken: cancellationToken);
                    if (envelope is not null) await RunSessionAsync(credentials, envelope, cancellationToken);
                }
                await Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "RemoteDesktopPollFailed");
                await Task.Delay(TimeSpan.FromSeconds(30), cancellationToken);
            }
        }
    }

    private async Task RunSessionAsync(StoredCredentials credentials, SessionEnvelope envelope, CancellationToken cancellationToken)
    {
        var endpoint = BuildChannelUri(envelope.ChannelPath);
        if (endpoint is null) { logger.LogWarning("RemoteDesktopChannelUriInvalid"); return; }

        using var socket = new ClientWebSocket();
        // Unlike a browser, the Agent can present headers on the handshake, so
        // the device credential and the single-use channel token both travel
        // out of band rather than in the URL.
        socket.Options.SetRequestHeader("Authorization", "Bearer " + credentials.AgentToken);
        socket.Options.SetRequestHeader("X-Nexora-Session-Token", envelope.ChannelToken);
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);

        using var session = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        try
        {
            await socket.ConnectAsync(endpoint, session.Token);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "RemoteDesktopConnectFailed");
            return;
        }

        logger.LogInformation("RemoteDesktopSessionConnected");
        try
        {
            await SendControlAsync(socket, new { type = "agent.hello", protocol = "nexora-remote-desktop-v1", agentVersion = AgentVersion.Current }, session.Token);

            // Refuse to stream rather than send black frames from session 0.
            var blocked = DesktopSession.BlockingReason();
            if (blocked is not null)
            {
                await SendControlAsync(socket, new { type = "agent.error", code = blocked }, session.Token);
                await CloseAsync(socket, "capture unavailable");
                return;
            }

            using var capture = new ScreenCapture(maxWidth: 1600, quality: 60);
            var injector = new InputInjector(capture.Width, capture.Height);
            await SendControlAsync(socket, new { type = "agent.desktop.info", width = capture.Width, height = capture.Height, displays = capture.Displays }, session.Token);

            // Input is read on its own loop so a slow or large frame encode can
            // never delay a mouse or key event - responsiveness under load is
            // the whole point of splitting these.
            var receiving = ReceiveLoopAsync(socket, injector, capture, session, cancellationToken);
            var streaming = StreamLoopAsync(socket, capture, session.Token);
            await Task.WhenAny(receiving, streaming);
            session.Cancel();
            await Task.WhenAll(SafeAsync(receiving), SafeAsync(streaming));
        }
        catch (Exception ex) { logger.LogWarning(ex, "RemoteDesktopSessionFailed"); }
        finally
        {
            await CloseAsync(socket, "session ended");
            logger.LogInformation("RemoteDesktopSessionClosed");
        }
    }

    /// <summary>Capture, encode, send. Frame pacing adapts when encoding runs long.</summary>
    private async Task StreamLoopAsync(ClientWebSocket socket, ScreenCapture capture, CancellationToken token)
    {
        var frameInterval = TimeSpan.FromMilliseconds(1000d / 12);
        uint sequence = 0;
        var consecutiveFailures = 0;
        var buffer = new byte[4];
        while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var started = DateTime.UtcNow;
            var image = capture.Capture();
            if (image is null)
            {
                if (++consecutiveFailures >= 5)
                {
                    await SendControlAsync(socket, new { type = "agent.error", code = "capture_failed" }, token);
                    return;
                }
                await Task.Delay(frameInterval, token);
                continue;
            }
            consecutiveFailures = 0;

            BinaryPrimitives.WriteUInt32BigEndian(buffer, unchecked(sequence++));
            var payload = new byte[buffer.Length + image.Length];
            buffer.CopyTo(payload, 0);
            image.CopyTo(payload, buffer.Length);
            try { await socket.SendAsync(payload, WebSocketMessageType.Binary, true, token); }
            catch (Exception) { return; }

            // Never accumulate: if a capture+encode took longer than the budget
            // the next frame goes out immediately and the intervening ones are
            // simply never produced. Dropping beats queueing stale desktops.
            var elapsed = DateTime.UtcNow - started;
            if (elapsed < frameInterval) await Task.Delay(frameInterval - elapsed, token);
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket socket, InputInjector injector, ScreenCapture capture, CancellationTokenSource session, CancellationToken token)
    {
        var buffer = new byte[MaxControlBytes];
        while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try { result = await socket.ReceiveAsync(buffer, token); }
            catch (Exception) { return; }
            if (result.MessageType == WebSocketMessageType.Close) return;
            // Oversized or binary input is not part of the server's vocabulary.
            if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage) return;

            ServerMessage? message;
            try { message = JsonSerializer.Deserialize<ServerMessage>(buffer.AsSpan(0, result.Count), Json); }
            catch (JsonException) { continue; }
            if (message is null) continue;

            switch (message.Type)
            {
                case "agent.accepted":
                case "agent.start":
                    break;
                case "agent.stop":
                    session.Cancel();
                    return;
                case "agent.ping":
                    await SendControlAsync(socket, new { type = "agent.pong" }, token);
                    break;
                case "agent.input":
                    if (message.Event is not null) Apply(injector, capture, message.Event);
                    break;
                default:
                    // Unknown server message: ignore rather than guess.
                    break;
            }
        }
    }

    private static void Apply(InputInjector injector, ScreenCapture capture, InputEvent input)
    {
        injector.ScreenWidth = capture.Width;
        injector.ScreenHeight = capture.Height;
        switch (input.Kind)
        {
            case "mouse_move": injector.MoveMouse(input.X, input.Y); break;
            case "mouse_button": if (input.Button is not null) injector.MouseButton(input.X, input.Y, input.Button, input.Pressed); break;
            case "mouse_wheel": injector.MouseWheel(input.X, input.Y, input.DeltaY); break;
            case "key": if (input.Code is not null) injector.Key(input.Code, input.Pressed); break;
            default: break; // unknown kind is dropped, never guessed at
        }
    }

    private Uri? BuildChannelUri(string channelPath)
    {
        if (string.IsNullOrWhiteSpace(channelPath) || !channelPath.StartsWith('/')) return null;
        var baseAddress = options.ApiBaseUrl;
        if (string.IsNullOrWhiteSpace(baseAddress)) return null;
        if (!Uri.TryCreate(baseAddress, UriKind.Absolute, out var parsed)) return null;
        var scheme = parsed.Scheme == Uri.UriSchemeHttps ? "wss" : "ws";
        return new Uri($"{scheme}://{parsed.Authority}{channelPath}");
    }

    private static async Task SendControlAsync(ClientWebSocket socket, object message, CancellationToken token)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message);
        if (payload.Length > MaxControlBytes) return;
        try { await socket.SendAsync(payload, WebSocketMessageType.Text, true, token); } catch (Exception) { /* closing */ }
    }

    private static async Task CloseAsync(ClientWebSocket socket, string reason)
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived)) return;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, reason, timeout.Token); } catch (Exception) { /* already gone */ }
    }

    private static async Task SafeAsync(Task task)
    {
        try { await task; } catch (Exception) { /* shutdown races are expected */ }
    }

    private sealed record SessionEnvelope(
        [property: JsonPropertyName("session_id")] string SessionId,
        [property: JsonPropertyName("channel_token")] string ChannelToken,
        [property: JsonPropertyName("channel_path")] string ChannelPath,
        [property: JsonPropertyName("expires_at")] DateTimeOffset ExpiresAt);

    private sealed class ServerMessage
    {
        [JsonPropertyName("type")] public string Type { get; set; } = "";
        [JsonPropertyName("event")] public InputEvent? Event { get; set; }
    }

    private sealed class InputEvent
    {
        [JsonPropertyName("kind")] public string Kind { get; set; } = "";
        [JsonPropertyName("x")] public double X { get; set; }
        [JsonPropertyName("y")] public double Y { get; set; }
        [JsonPropertyName("button")] public string? Button { get; set; }
        [JsonPropertyName("pressed")] public bool Pressed { get; set; }
        [JsonPropertyName("deltaY")] public double DeltaY { get; set; }
        [JsonPropertyName("code")] public string? Code { get; set; }
    }
}
