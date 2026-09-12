using System.Buffers.Binary;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Text.Json;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>
/// The helper, running inside the interactive user session.
///
/// It is intentionally tiny and intentionally dumb. It captures the desktop
/// and injects input, and that is all it can do. It has no Agent identity, no
/// device id, no signing key, no enrollment, no configuration, no network
/// client and no listener of any kind - its only channel is the inherited
/// named pipe the service created.
///
/// It also does not trust that pipe blindly: every command is re-validated
/// here, so a compromised service-side caller still cannot make it perform an
/// operation outside the Remote Desktop vocabulary.
///
/// If anything at all goes wrong, it exits. A capture process with no
/// supervisor has no reason to keep running.
/// </summary>
[SupportedOSPlatform("windows")]
public static class HelperHost
{
    private static readonly SemaphoreSlim WriteLock = new(1, 1);

    public static async Task<int> RunAsync(string[] args)
    {
        var pipeName = InteractiveSessionLauncher.PipeNameFromArgs(args);
        if (pipeName is null) return 2;

        using var lifetime = new CancellationTokenSource();
        // The helper never outlives a lost pipe, and never outlives its own
        // session: both paths end in process exit.
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try { await pipe.ConnectAsync(HelperProtocol.HandshakeTimeoutMs, lifetime.Token); }
        catch (Exception) { return 3; }

        // Handshake: the service speaks first with the per-session nonce, and
        // we echo it. A caller that cannot produce it is not our service.
        var initialize = await ReadControlAsync(pipe, lifetime.Token);
        if (initialize is null || initialize.Type != HelperProtocol.Initialize || string.IsNullOrEmpty(initialize.Nonce)) return 4;
        await SendAsync(pipe, new HelperMessage { Type = HelperProtocol.Ready, Nonce = initialize.Nonce }, lifetime.Token);

        ScreenCapture? capture = null;
        InputInjector? injector = null;
        Task? streaming = null;
        using var capturing = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);

        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var message = await ReadControlAsync(pipe, lifetime.Token);
                if (message is null) break;                        // pipe closed: supervisor is gone
                if (!message.IsValidFromService()) break;          // refuse, do not interpret

                switch (message.Type)
                {
                    case HelperProtocol.CaptureStart:
                    {
                        if (streaming is not null) break;
                        try
                        {
                            capture = new ScreenCapture(message.MaxWidth, message.Quality);
                            injector = new InputInjector(capture.Width, capture.Height);
                        }
                        catch (Exception)
                        {
                            await SendAsync(pipe, new HelperMessage { Type = HelperProtocol.Error, Reason = "capture_unavailable" }, lifetime.Token);
                            break;
                        }
                        await SendAsync(pipe, new HelperMessage
                        {
                            Type = HelperProtocol.DesktopInfo, Width = capture.Width, Height = capture.Height, Displays = capture.Displays,
                        }, lifetime.Token);
                        var fps = Math.Clamp(message.Fps, 1, 60);
                        streaming = Task.Run(() => StreamAsync(pipe, capture, fps, capturing.Token), capturing.Token);
                        break;
                    }
                    case HelperProtocol.CaptureStop:
                        capturing.Cancel();
                        break;
                    case HelperProtocol.InputMouse when injector is not null:
                        ApplyMouse(injector, message);
                        break;
                    case HelperProtocol.InputKeyboard when injector is not null:
                        // Unknown key names are dropped by the injector's table.
                        injector.Key(message.Code!, message.Pressed);
                        break;
                    case HelperProtocol.Ping:
                        await SendAsync(pipe, new HelperMessage { Type = HelperProtocol.Pong }, lifetime.Token);
                        break;
                    case HelperProtocol.SessionClose:
                        return 0;
                    default:
                        break; // known-but-not-applicable: ignore, never guess
                }
            }
        }
        catch (Exception) { /* fall through to shutdown */ }
        finally
        {
            capturing.Cancel();
            if (streaming is not null) { try { await streaming; } catch (Exception) { /* shutting down */ } }
            capture?.Dispose();
        }
        return 0;
    }

    private static void ApplyMouse(InputInjector injector, HelperMessage message)
    {
        switch (message.Action)
        {
            case "move": injector.MoveMouse(message.X, message.Y); break;
            case "button": injector.MouseButton(message.X, message.Y, message.Button!, message.Pressed); break;
            case "wheel": injector.MouseWheel(message.X, message.Y, message.DeltaY); break;
            default: break;
        }
    }

    /// <summary>
    /// Capture loop. A failed capture is reported, never substituted with a
    /// blank image: a black frame must only ever mean the desktop really is
    /// black. Repeated failure ends the session rather than streaming nothing.
    /// </summary>
    private static async Task StreamAsync(NamedPipeClientStream pipe, ScreenCapture capture, int fps, CancellationToken token)
    {
        var interval = TimeSpan.FromMilliseconds(1000d / fps);
        var failures = 0;
        while (!token.IsCancellationRequested && pipe.IsConnected)
        {
            var started = DateTime.UtcNow;
            var image = capture.Capture();
            if (image is null)
            {
                // The secure desktop (lock screen, UAC) is not capturable. That
                // is a true state to report, not something to paper over.
                if (++failures >= 5)
                {
                    await SendAsync(pipe, new HelperMessage { Type = HelperProtocol.Error, Reason = "desktop_unavailable" }, CancellationToken.None);
                    return;
                }
                await Task.Delay(interval, token);
                continue;
            }
            failures = 0;
            if (!await SendFrameAsync(pipe, image, token)) return;
            var elapsed = DateTime.UtcNow - started;
            if (elapsed < interval) await Task.Delay(interval - elapsed, token);
        }
    }

    private static async Task<bool> SendFrameAsync(NamedPipeClientStream pipe, byte[] image, CancellationToken token)
    {
        if (image.Length > HelperProtocol.MaxFrameBytes) return true; // skip, do not tear down
        var header = new byte[5];
        header[0] = 0x02; // frame
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(1), image.Length);
        await WriteLock.WaitAsync(token);
        try { await pipe.WriteAsync(header, token); await pipe.WriteAsync(image, token); await pipe.FlushAsync(token); return true; }
        catch (Exception) { return false; }
        finally { WriteLock.Release(); }
    }

    private static async Task SendAsync(PipeStream pipe, HelperMessage message, CancellationToken token)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, HelperProtocol.Json);
        if (payload.Length > HelperProtocol.MaxControlBytes) return;
        var header = new byte[5];
        header[0] = 0x01;
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(1), payload.Length);
        await WriteLock.WaitAsync(token);
        try { await pipe.WriteAsync(header, token); await pipe.WriteAsync(payload, token); await pipe.FlushAsync(token); }
        catch (Exception) { /* supervisor gone */ }
        finally { WriteLock.Release(); }
    }

    private static async Task<HelperMessage?> ReadControlAsync(PipeStream pipe, CancellationToken token)
    {
        var header = new byte[5];
        if (!await ReadExactlyAsync(pipe, header, token)) return null;
        if (header[0] != 0x01) return null;                                  // the service never sends frames
        var length = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(1));
        if (length is < 0 or > HelperProtocol.MaxControlBytes) return null;  // size checked before buffering
        var buffer = new byte[length];
        if (!await ReadExactlyAsync(pipe, buffer, token)) return null;
        try { return JsonSerializer.Deserialize<HelperMessage>(buffer, HelperProtocol.Json); }
        catch (JsonException) { return null; }
    }

    private static async Task<bool> ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken token)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            int read;
            try { read = await stream.ReadAsync(buffer.AsMemory(offset), token); }
            catch (Exception) { return false; }
            if (read <= 0) return false;
            offset += read;
        }
        return true;
    }
}
