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
    InteractiveSessionLauncher launcher,
    SessionChangeNotifier sessionChanges,
    ILoggerFactory loggerFactory,
    ILogger<RemoteDesktopService> logger)
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };
    private const int MaxControlBytes = 8 * 1024;
    // A stable support experience beats an unstable fast one; these bound both
    // encode cost on the endpoint and bandwidth on the wire.
    private const int CaptureFps = 12;
    private const int CaptureQuality = 60;
    private const int CaptureMaxWidth = 1600;

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

            // A service in session 0 has no desktop of its own, so capture runs
            // in a helper launched into the interactive session. Running
            // interactively (development, CI) there is nothing to hand off to -
            // and CreateProcessAsUser would not be permitted anyway - so the
            // same code captures in-process.
            //
            // Session-0 capture is never faked: if no interactive session can
            // be selected, the helper path reports the reason and stops.
            if (DesktopSession.IsIsolatedFromInteractiveDesktop())
                await RunViaHelperAsync(socket, session, cancellationToken);
            else
                await RunInProcessAsync(socket, session, cancellationToken);
        }
        catch (Exception ex) { logger.LogWarning(ex, "RemoteDesktopSessionFailed"); }
        finally
        {
            await CloseAsync(socket, "session ended");
            logger.LogInformation("RemoteDesktopSessionClosed");
        }
    }

    /// <summary>
    /// Service mode. The desktop lives in another session, so a helper is
    /// started there and this loop simply relays: frames out to Nexora, input
    /// in to the helper. The helper never sees the Remote Desktop protocol.
    /// </summary>
    private async Task RunViaHelperAsync(ClientWebSocket socket, CancellationTokenSource session, CancellationToken cancellationToken)
    {
        string? endReason = null;
        await using var helper = new HelperChannel(launcher, loggerFactory.CreateLogger<HelperChannel>());
        var failure = await helper.StartAsync(session.Token);
        if (failure is not null)
        {
            // Report the true reason instead of streaming a black desktop.
            await SendControlAsync(socket, new { type = "agent.error", code = failure }, session.Token);
            await CloseAsync(socket, "capture unavailable");
            return;
        }

        await helper.SendAsync(new HelperMessage
        {
            Type = HelperProtocol.CaptureStart, Fps = CaptureFps, Quality = CaptureQuality, MaxWidth = CaptureMaxWidth,
        }, session.Token);

        // React the instant Windows tells us, rather than waiting for the
        // supervision tick. Lock counts: the lock screen is a separate secure
        // desktop the helper cannot capture, so the session ends cleanly.
        void OnSessionChange(InteractiveSessionEvent change, uint sessionId)
        {
            if (!SessionChangeNotifier.EndsRemoteDesktop(change)) return;
            if (helper.Session is not null && sessionId != 0 && sessionId != helper.Session.SessionId) return;
            logger.LogInformation("RemoteDesktopSessionEnding Reason={Reason}", SessionChangeNotifier.ReasonCode(change));
            endReason = SessionChangeNotifier.ReasonCode(change);
            session.Cancel();
        }
        sessionChanges.Changed += OnSessionChange;

        var fromHelper = PumpHelperAsync(socket, helper, session);
        var fromServer = ReceiveLoopAsync(socket, input => ForwardToHelper(helper, input, session.Token), session, cancellationToken);
        var supervising = SuperviseHelperAsync(socket, helper, session);
        try
        {
            await Task.WhenAny(fromHelper, fromServer, supervising);
        }
        finally
        {
            sessionChanges.Changed -= OnSessionChange;
            session.Cancel();
            await Task.WhenAll(SafeAsync(fromHelper), SafeAsync(fromServer), SafeAsync(supervising));
        }
        if (endReason is not null) await SendControlAsync(socket, new { type = "agent.error", code = endReason }, CancellationToken.None);
    }

    /// <summary>Frames and status from the helper, relayed onto the session socket.</summary>
    private async Task PumpHelperAsync(ClientWebSocket socket, HelperChannel helper, CancellationTokenSource session)
    {
        var buffer = new byte[4];
        uint sequence = 0;
        while (!session.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var (control, frame) = await helper.ReadAsync(session.Token);
            if (control is null && frame is null)
            {
                // Pipe ended. Distinguish a clean stop from a crash so the
                // viewer is told something true.
                var reason = helper.FailureReason ?? (helper.HelperAlive ? "helper_channel_closed" : "helper_exited");
                await SendControlAsync(socket, new { type = "agent.error", code = reason }, CancellationToken.None);
                return;
            }
            if (frame is not null)
            {
                BinaryPrimitives.WriteUInt32BigEndian(buffer, unchecked(sequence++));
                var payload = new byte[buffer.Length + frame.Length];
                buffer.CopyTo(payload, 0);
                frame.CopyTo(payload, buffer.Length);
                try { await socket.SendAsync(payload, WebSocketMessageType.Binary, true, session.Token); }
                catch (Exception) { return; }
                continue;
            }
            switch (control!.Type)
            {
                case HelperProtocol.DesktopInfo:
                    await SendControlAsync(socket, new { type = "agent.desktop.info", width = control.Width, height = control.Height, displays = control.Displays }, session.Token);
                    break;
                case HelperProtocol.Error:
                    await SendControlAsync(socket, new { type = "agent.error", code = control.Reason ?? "helper_error" }, session.Token);
                    return;
                case HelperProtocol.Closed:
                    return;
                default:
                    break;
            }
        }
    }

    /// <summary>
    /// Detect a helper that died or a session that went away. This is what
    /// stops a crashed helper from leaving the viewer staring at a frozen
    /// last frame, and what guarantees no orphan survives the session.
    /// </summary>
    private async Task SuperviseHelperAsync(ClientWebSocket socket, HelperChannel helper, CancellationTokenSource session)
    {
        while (!session.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(2), session.Token);
            if (!helper.HelperAlive)
            {
                logger.LogWarning("RemoteDesktopHelperExited");
                await SendControlAsync(socket, new { type = "agent.error", code = "helper_exited" }, CancellationToken.None);
                return;
            }
            // The interactive session can disappear under us - logoff, switch,
            // or a lock that ends the console session.
            var current = launcher.SelectActiveSession(out var reason);
            if (current is null || current.SessionId != helper.Session?.SessionId)
            {
                logger.LogInformation("RemoteDesktopSessionChanged Reason={Reason}", reason);
                await SendControlAsync(socket, new { type = "agent.error", code = current is null ? reason : "interactive_session_changed" }, CancellationToken.None);
                return;
            }
        }
    }

    private static void ForwardToHelper(HelperChannel helper, InputEvent input, CancellationToken token)
    {
        // Translated again, into the helper's own small vocabulary. Nothing
        // from the wire is forwarded verbatim at any hop.
        var message = input.Kind switch
        {
            "mouse_move" => new HelperMessage { Type = HelperProtocol.InputMouse, Action = "move", X = input.X, Y = input.Y },
            "mouse_button" => new HelperMessage { Type = HelperProtocol.InputMouse, Action = "button", X = input.X, Y = input.Y, Button = input.Button, Pressed = input.Pressed },
            "mouse_wheel" => new HelperMessage { Type = HelperProtocol.InputMouse, Action = "wheel", X = input.X, Y = input.Y, DeltaY = input.DeltaY },
            "key" => new HelperMessage { Type = HelperProtocol.InputKeyboard, Code = input.Code, Pressed = input.Pressed },
            _ => null,
        };
        if (message is null || !message.IsValidFromService()) return;
        _ = helper.SendAsync(message, token);
    }

    /// <summary>Interactive mode (development and CI): capture in this process.</summary>
    private async Task RunInProcessAsync(ClientWebSocket socket, CancellationTokenSource session, CancellationToken cancellationToken)
    {
        using var capture = new ScreenCapture(CaptureMaxWidth, CaptureQuality);
        var injector = new InputInjector(capture.Width, capture.Height);
        await SendControlAsync(socket, new { type = "agent.desktop.info", width = capture.Width, height = capture.Height, displays = capture.Displays }, session.Token);

        var receiving = ReceiveLoopAsync(socket, input => Apply(injector, capture, input), session, cancellationToken);
        var streaming = StreamLoopAsync(socket, capture, session.Token);
        await Task.WhenAny(receiving, streaming);
        session.Cancel();
        await Task.WhenAll(SafeAsync(receiving), SafeAsync(streaming));
    }

    /// <summary>Capture, encode, send. Frame pacing adapts when encoding runs long.</summary>
    private async Task StreamLoopAsync(ClientWebSocket socket, ScreenCapture capture, CancellationToken token)
    {
        var frameInterval = TimeSpan.FromMilliseconds(1000d / CaptureFps);
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

    private async Task ReceiveLoopAsync(ClientWebSocket socket, Action<InputEvent> onInput, CancellationTokenSource session, CancellationToken token)
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
                    if (message.Event is not null) onInput(message.Event);
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

    internal sealed class InputEvent
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
