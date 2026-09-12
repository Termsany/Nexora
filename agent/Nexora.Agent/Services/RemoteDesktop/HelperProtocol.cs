using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>
/// Service &lt;-&gt; interactive-helper IPC contract.
///
/// Deliberately NOT the Remote Desktop wire protocol. The helper speaks only
/// this small local vocabulary, so nothing a remote viewer sends can reach it
/// verbatim: the service validates the wire message, then constructs one of
/// these. The helper is a desktop peripheral, not a protocol endpoint.
///
/// Every field is bounded and every message is size-capped before parsing.
/// </summary>
public static class HelperProtocol
{
    /// <summary>Control frames are tiny; larger is malformed or hostile.</summary>
    public const int MaxControlBytes = 4 * 1024;
    /// <summary>One encoded frame. Matches the gateway's own ceiling.</summary>
    public const int MaxFrameBytes = 2 * 1024 * 1024;
    /// <summary>Handshake must complete quickly or the helper is abandoned.</summary>
    public const int HandshakeTimeoutMs = 10_000;

    public static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    // Service -> Helper
    public const string Initialize = "initialize";
    public const string CaptureStart = "capture.start";
    public const string CaptureStop = "capture.stop";
    public const string InputMouse = "input.mouse";
    public const string InputKeyboard = "input.keyboard";
    public const string SessionClose = "session.close";
    public const string Ping = "ping";

    // Helper -> Service
    public const string Ready = "ready";
    public const string DesktopInfo = "desktop.info";
    public const string DesktopFrame = "desktop.frame";
    public const string InputResult = "input.result";
    public const string Error = "error";
    public const string Closed = "closed";
    public const string Pong = "pong";

    private static readonly HashSet<string> ServiceToHelper = new(StringComparer.Ordinal)
    { Initialize, CaptureStart, CaptureStop, InputMouse, InputKeyboard, SessionClose, Ping };

    private static readonly HashSet<string> HelperToService = new(StringComparer.Ordinal)
    { Ready, DesktopInfo, DesktopFrame, InputResult, Error, Closed, Pong };

    public static bool IsServiceCommand(string? type) => type is not null && ServiceToHelper.Contains(type);
    public static bool IsHelperMessage(string? type) => type is not null && HelperToService.Contains(type);

    /// <summary>Reason codes only: no paths, no exception text, no screen content.</summary>
    public static bool IsReasonCode(string? code) =>
        code is { Length: > 0 and <= 48 } && code.All(c => (c >= 'a' && c <= 'z') || c == '_');
}

/// <summary>One IPC control message. Unknown fields are rejected by the reader.</summary>
public sealed class HelperMessage
{
    [JsonPropertyName("type")] public string Type { get; set; } = "";

    /// <summary>Handshake nonce. Present only on initialize/ready.</summary>
    [JsonPropertyName("nonce")] public string? Nonce { get; set; }

    // input.mouse
    [JsonPropertyName("action")] public string? Action { get; set; }   // move | button | wheel
    [JsonPropertyName("x")] public double X { get; set; }
    [JsonPropertyName("y")] public double Y { get; set; }
    [JsonPropertyName("button")] public string? Button { get; set; }
    [JsonPropertyName("pressed")] public bool Pressed { get; set; }
    [JsonPropertyName("deltaY")] public double DeltaY { get; set; }

    // input.keyboard
    [JsonPropertyName("code")] public string? Code { get; set; }

    // desktop.info
    [JsonPropertyName("width")] public int Width { get; set; }
    [JsonPropertyName("height")] public int Height { get; set; }
    [JsonPropertyName("displays")] public int Displays { get; set; }

    // capture.start
    [JsonPropertyName("fps")] public int Fps { get; set; }
    [JsonPropertyName("quality")] public int Quality { get; set; }
    [JsonPropertyName("maxWidth")] public int MaxWidth { get; set; }

    // error / closed
    [JsonPropertyName("reason")] public string? Reason { get; set; }

    /// <summary>
    /// Validate a message the SERVICE received from the helper. A helper that
    /// sends anything outside this shape is treated as compromised and dropped.
    /// </summary>
    public bool IsValidFromHelper() => HelperProtocol.IsHelperMessage(Type) && Type switch
    {
        HelperProtocol.DesktopInfo => Width is > 0 and <= 16384 && Height is > 0 and <= 16384 && Displays is > 0 and <= 16,
        HelperProtocol.Error or HelperProtocol.Closed => HelperProtocol.IsReasonCode(Reason),
        _ => true,
    };

    /// <summary>
    /// Validate a command the HELPER received. Re-validated here on purpose:
    /// the helper does not trust the pipe simply because the service is meant
    /// to be on the other end.
    /// </summary>
    public bool IsValidFromService() => HelperProtocol.IsServiceCommand(Type) && Type switch
    {
        HelperProtocol.InputMouse => Action is "move" or "button" or "wheel"
            && InRange(X) && InRange(Y)
            && (Action != "button" || Button is "LEFT" or "RIGHT" or "MIDDLE")
            && (Action != "wheel" || (double.IsFinite(DeltaY) && Math.Abs(DeltaY) <= 10_000)),
        HelperProtocol.InputKeyboard => Code is { Length: > 0 and <= 24 } && Code.All(char.IsLetterOrDigit),
        HelperProtocol.CaptureStart => Fps is > 0 and <= 60 && Quality is >= 20 and <= 95 && MaxWidth is >= 320 and <= 3840,
        _ => true,
    };

    private static bool InRange(double value) => double.IsFinite(value) && value >= 0d && value <= 1d;
}
