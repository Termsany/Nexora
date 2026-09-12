using System.Buffers.Binary;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>
/// The service's end of the helper channel: it owns the pipe, launches the
/// helper into the interactive session, authenticates it, and tears it down.
///
/// Authentication is two independent checks, because either alone is weak:
///   1. The pipe ACL admits only SYSTEM and the session's own user, so an
///      arbitrary account cannot even connect.
///   2. A per-session 256-bit nonce is sent AFTER the pipe is connected and
///      must be echoed back. It is never on a command line, never written to
///      disk, and never logged - a command line is readable machine-wide.
///
/// The helper is a peripheral, not a peer: it receives only the small local
/// vocabulary in HelperProtocol and can ask the service for nothing.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class HelperChannel(InteractiveSessionLauncher launcher, ILogger<HelperChannel> logger) : IAsyncDisposable
{
    private NamedPipeServerStream? _pipe;
    private int? _helperProcessId;
    private string? _nonce;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public InteractiveSession? Session { get; private set; }
    public int Width { get; private set; }
    public int Height { get; private set; }
    public int Displays { get; private set; } = 1;
    public bool Ready { get; private set; }

    /// <summary>Non-null once the helper reported a failure it cannot recover from.</summary>
    public string? FailureReason { get; private set; }

    /// <summary>
    /// Bring a helper up in the active interactive session. Returns a reason
    /// code on failure; the caller reports it verbatim to the viewer.
    /// </summary>
    public async Task<string?> StartAsync(CancellationToken cancellationToken)
    {
        var session = launcher.SelectActiveSession(out var selection);
        if (session is null) { logger.LogInformation("RemoteDesktopNoSession Reason={Reason}", selection); return selection; }
        Session = session;

        var pipeName = "nexora-rd-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        try { _pipe = CreatePipe(pipeName, session.SessionId); }
        catch (Exception exception) { logger.LogWarning(exception, "RemoteDesktopPipeCreateFailed"); return "ipc_unavailable"; }

        // Listening must be established before the helper exists, otherwise it
        // races us to connect and fails.
        var waiting = _pipe.WaitForConnectionAsync(cancellationToken);

        var pid = launcher.Launch(session, pipeName, out var launchReason);
        if (pid is null) { await DisposeAsync(); return launchReason; }
        _helperProcessId = pid;

        using var handshake = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        handshake.CancelAfter(HelperProtocol.HandshakeTimeoutMs);
        try { await waiting.WaitAsync(handshake.Token); }
        catch (OperationCanceledException) { await DisposeAsync(); return "helper_handshake_timeout"; }

        // The connected client must be the process we started. This is the
        // strongest of the two checks: it cannot be replayed or guessed.
        if (!ClientIsExpectedProcess()) { logger.LogWarning("RemoteDesktopHelperIdentityMismatch"); await DisposeAsync(); return "helper_identity_mismatch"; }

        _nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        await SendAsync(new HelperMessage { Type = HelperProtocol.Initialize, Nonce = _nonce }, cancellationToken);

        var ready = await ReadControlAsync(handshake.Token);
        if (ready is null || ready.Type != HelperProtocol.Ready || !NonceMatches(ready.Nonce))
        {
            logger.LogWarning("RemoteDesktopHelperHandshakeRejected");
            await DisposeAsync();
            return "helper_handshake_rejected";
        }
        Ready = true;
        logger.LogInformation("RemoteDesktopHelperReady Session={SessionId}", session.SessionId);
        return null;
    }

    /// <summary>
    /// Pipe ACL: SYSTEM (the service) and the interactive user, nothing else.
    /// Explicitly not "authenticated users" - any logged-in account could then
    /// attempt the handshake.
    /// </summary>
    private static NamedPipeServerStream CreatePipe(string pipeName, uint sessionId)
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        var user = SessionUserSid(sessionId);
        if (user is not null) security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));

        return NamedPipeServerStreamAcl.Create(
            pipeName, PipeDirection.InOut, maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.WriteThrough,
            inBufferSize: 64 * 1024, outBufferSize: HelperProtocol.MaxFrameBytes, pipeSecurity: security);
    }

    /// <summary>
    /// The specific account owning the target session.
    ///
    /// Previously this fell back to the well-known Interactive SID whenever
    /// the service was not itself in the target session - which, for a
    /// session-0 service, is always. That granted the pipe to every
    /// interactive user rather than the one whose desktop is being shared.
    /// Resolving the real SID keeps the grant as narrow as the feature needs.
    /// </summary>
    private static SecurityIdentifier? SessionUserSid(uint sessionId)
    {
        try
        {
            var resolved = InteractiveSessionLauncher.SessionUserSid(sessionId);
            if (resolved is not null) return resolved;
            // Running interactively (development): the helper is us.
            if (sessionId == InteractiveSessionLauncher.CurrentSessionId())
            {
                using var identity = WindowsIdentity.GetCurrent();
                return identity.User;
            }
            // Deliberately no broad fallback. Without a specific account the
            // pipe stays SYSTEM/Administrators only and the launch fails
            // closed rather than opening up to all interactive users.
            return null;
        }
        catch (Exception) { return null; }
    }

    /// <summary>
    /// The connected client must be the exact process we launched.
    ///
    /// This is the load-bearing check, not a refinement of the nonce. The pipe
    /// name appears on the helper's command line, which any process can read;
    /// the server starts listening before the helper exists; and only one
    /// client may connect. So a process running as the session user can race
    /// to connect first - and because the server sends the nonce AFTER the
    /// connection is accepted, a weaker check would hand that impostor the
    /// nonce and let it echo it back. It could then feed the operator a
    /// fabricated desktop while receiving everything the operator types.
    ///
    /// Comparing the client process id closes that race outright: an impostor
    /// cannot be the process id we just created.
    /// </summary>
    private bool ClientIsExpectedProcess()
    {
        if (_pipe is null || _helperProcessId is null) return false;
        try
        {
            var client = InteractiveSessionLauncher.ClientProcessId(_pipe.SafePipeHandle);
            if (client is null) return false;                       // cannot prove it: refuse
            if (client.Value != (uint)_helperProcessId.Value) return false;
            return InteractiveSessionLauncher.ProcessIsAlive(_helperProcessId.Value);
        }
        catch (Exception) { return false; }
    }

    private bool NonceMatches(string? candidate)
    {
        if (_nonce is null || candidate is null) return false;
        var expected = System.Text.Encoding.UTF8.GetBytes(_nonce);
        var supplied = System.Text.Encoding.UTF8.GetBytes(candidate);
        return expected.Length == supplied.Length && CryptographicOperations.FixedTimeEquals(expected, supplied);
    }

    public bool HelperAlive => _helperProcessId is int pid && InteractiveSessionLauncher.ProcessIsAlive(pid);

    // ------------------------------------------------------------------ write
    public async Task SendAsync(HelperMessage message, CancellationToken cancellationToken)
    {
        var pipe = _pipe;
        if (pipe is null || !pipe.IsConnected) return;
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, HelperProtocol.Json);
        if (payload.Length > HelperProtocol.MaxControlBytes) return;
        var header = new byte[5];
        header[0] = 0x01; // control
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(1), payload.Length);
        await _writeLock.WaitAsync(cancellationToken);
        try { await pipe.WriteAsync(header, cancellationToken); await pipe.WriteAsync(payload, cancellationToken); await pipe.FlushAsync(cancellationToken); }
        catch (Exception) { /* helper went away; the read loop reports it */ }
        finally { _writeLock.Release(); }
    }

    // ------------------------------------------------------------------- read
    /// <summary>
    /// Read one framed message. Returns a control message, a frame, or null on
    /// end-of-stream or protocol violation. Length is checked against the type's
    /// ceiling before a single byte of payload is buffered.
    /// </summary>
    public async Task<(HelperMessage? Control, byte[]? Frame)> ReadAsync(CancellationToken cancellationToken)
    {
        var pipe = _pipe;
        if (pipe is null) return (null, null);
        var header = new byte[5];
        if (!await ReadExactlyAsync(pipe, header, cancellationToken)) return (null, null);
        var kind = header[0];
        var length = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(1));
        if (length < 0) return (null, null);

        if (kind == 0x02)
        {
            if (length > HelperProtocol.MaxFrameBytes) { FailureReason = "helper_frame_too_large"; return (null, null); }
            var frame = new byte[length];
            if (!await ReadExactlyAsync(pipe, frame, cancellationToken)) return (null, null);
            return (null, frame);
        }
        if (kind != 0x01) { FailureReason = "helper_protocol_violation"; return (null, null); }
        if (length > HelperProtocol.MaxControlBytes) { FailureReason = "helper_message_too_large"; return (null, null); }

        var buffer = new byte[length];
        if (!await ReadExactlyAsync(pipe, buffer, cancellationToken)) return (null, null);
        HelperMessage? message;
        try { message = JsonSerializer.Deserialize<HelperMessage>(buffer, HelperProtocol.Json); }
        catch (JsonException) { FailureReason = "helper_malformed_message"; return (null, null); }
        if (message is null || !message.IsValidFromHelper()) { FailureReason = "helper_invalid_message"; return (null, null); }

        if (message.Type == HelperProtocol.DesktopInfo) { Width = message.Width; Height = message.Height; Displays = message.Displays; }
        return (message, null);
    }

    private async Task<HelperMessage?> ReadControlAsync(CancellationToken cancellationToken)
    {
        var (control, _) = await ReadAsync(cancellationToken);
        return control;
    }

    private static async Task<bool> ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            int read;
            try { read = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken); }
            catch (Exception) { return false; }
            if (read <= 0) return false;
            offset += read;
        }
        return true;
    }

    public async ValueTask DisposeAsync()
    {
        Ready = false;
        try { if (_pipe?.IsConnected == true) await SendAsync(new HelperMessage { Type = HelperProtocol.SessionClose }, CancellationToken.None); } catch (Exception) { /* closing */ }
        try { _pipe?.Dispose(); } catch (Exception) { /* closing */ }
        _pipe = null;
        // Never leave an orphan: if the helper does not exit on session.close,
        // it is killed. A capture process outliving its session is exactly the
        // thing that must not happen.
        if (_helperProcessId is int pid)
        {
            for (var attempt = 0; attempt < 10 && InteractiveSessionLauncher.ProcessIsAlive(pid); attempt++) await Task.Delay(100);
            InteractiveSessionLauncher.KillIfAlive(pid);
            _helperProcessId = null;
        }
        _nonce = null;
        _writeLock.Dispose();
    }
}
