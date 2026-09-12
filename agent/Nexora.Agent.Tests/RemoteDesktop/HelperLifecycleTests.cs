using System.Text.Json;
using Nexora.Agent.Services.RemoteDesktop;
using Xunit;

namespace Nexora.Agent.Tests.RemoteDesktop;

/// <summary>
/// Service/helper boundary. These assert the properties that make the helper
/// safe to run inside a user's session: it validates everything it is told,
/// it cannot be told to do anything outside the Remote Desktop vocabulary,
/// and it holds none of the Agent's identity.
/// </summary>
public sealed class HelperLifecycleTests
{
    private static HelperMessage Parse(string json) =>
        JsonSerializer.Deserialize<HelperMessage>(json, HelperProtocol.Json)!;

    // ---------------------------------------------------------------- protocol
    [Theory]
    [InlineData(HelperProtocol.Initialize)]
    [InlineData(HelperProtocol.CaptureStop)]
    [InlineData(HelperProtocol.SessionClose)]
    [InlineData(HelperProtocol.Ping)]
    public void Service_Commands_Are_Recognised(string type) => Assert.True(HelperProtocol.IsServiceCommand(type));

    [Theory]
    [InlineData("capture.exec")]
    [InlineData("process.start")]
    [InlineData("agent.sign")]
    [InlineData("")]
    [InlineData("READY")]
    public void Unknown_Commands_Are_Refused(string type)
    {
        Assert.False(HelperProtocol.IsServiceCommand(type));
        Assert.False(Parse($"{{\"type\":\"{type}\"}}").IsValidFromService());
    }

    [Fact]
    public void Helper_Refuses_Messages_It_Should_Never_Receive()
    {
        // The service never sends helper->service message types.
        foreach (var type in new[] { HelperProtocol.Ready, HelperProtocol.DesktopFrame, HelperProtocol.Pong })
            Assert.False(Parse($"{{\"type\":\"{type}\"}}").IsValidFromService());
    }

    [Theory]
    [InlineData(-0.1)]
    [InlineData(1.1)]
    public void Mouse_Coordinates_Outside_The_Unit_Range_Are_Refused(double x)
    {
        var message = Parse($"{{\"type\":\"input.mouse\",\"action\":\"move\",\"x\":{x},\"y\":0.5}}");
        Assert.False(message.IsValidFromService());
    }

    [Fact]
    public void Non_Finite_Coordinates_Are_Refused()
    {
        var message = new HelperMessage { Type = HelperProtocol.InputMouse, Action = "move", X = double.NaN, Y = 0.5 };
        Assert.False(message.IsValidFromService());
    }

    [Theory]
    [InlineData("LEFT", true)]
    [InlineData("RIGHT", true)]
    [InlineData("MIDDLE", true)]
    [InlineData("X1", false)]
    [InlineData("left", false)]
    [InlineData("", false)]
    public void Only_The_Three_Supported_Buttons_Are_Accepted(string button, bool expected)
    {
        var message = new HelperMessage { Type = HelperProtocol.InputMouse, Action = "button", X = 0.5, Y = 0.5, Button = button };
        Assert.Equal(expected, message.IsValidFromService());
    }

    [Fact]
    public void Wheel_Values_Are_Bounded()
    {
        Assert.True(new HelperMessage { Type = HelperProtocol.InputMouse, Action = "wheel", X = 0.5, Y = 0.5, DeltaY = 120 }.IsValidFromService());
        Assert.False(new HelperMessage { Type = HelperProtocol.InputMouse, Action = "wheel", X = 0.5, Y = 0.5, DeltaY = 1e9 }.IsValidFromService());
        Assert.False(new HelperMessage { Type = HelperProtocol.InputMouse, Action = "wheel", X = 0.5, Y = 0.5, DeltaY = double.PositiveInfinity }.IsValidFromService());
    }

    [Theory]
    [InlineData("KeyA", true)]
    [InlineData("F12", true)]
    [InlineData("Key A", false)]
    [InlineData("../../x", false)]
    [InlineData("", false)]
    public void Key_Codes_Are_Shape_Checked_At_The_Helper_Too(string code, bool expected)
    {
        var message = new HelperMessage { Type = HelperProtocol.InputKeyboard, Code = code };
        Assert.Equal(expected, message.IsValidFromService());
    }

    [Fact]
    public void Capture_Parameters_Are_Bounded()
    {
        Assert.True(new HelperMessage { Type = HelperProtocol.CaptureStart, Fps = 12, Quality = 60, MaxWidth = 1600 }.IsValidFromService());
        foreach (var bad in new[]
        {
            new HelperMessage { Type = HelperProtocol.CaptureStart, Fps = 0, Quality = 60, MaxWidth = 1600 },
            new HelperMessage { Type = HelperProtocol.CaptureStart, Fps = 12, Quality = 100, MaxWidth = 1600 },
            new HelperMessage { Type = HelperProtocol.CaptureStart, Fps = 12, Quality = 60, MaxWidth = 99999 },
        }) Assert.False(bad.IsValidFromService());
    }

    [Fact]
    public void Helper_Error_Reasons_Cannot_Carry_Paths_Or_Exception_Text()
    {
        Assert.True(new HelperMessage { Type = HelperProtocol.Error, Reason = "desktop_unavailable" }.IsValidFromHelper());
        foreach (var leak in new[] { @"C:\Users\bob\secret.txt", "System.Exception: boom", "Desktop Unavailable", "" })
            Assert.False(new HelperMessage { Type = HelperProtocol.Error, Reason = leak }.IsValidFromHelper());
    }

    [Fact]
    public void Helper_Reported_Geometry_Is_Bounded()
    {
        Assert.True(new HelperMessage { Type = HelperProtocol.DesktopInfo, Width = 1920, Height = 1080, Displays = 1 }.IsValidFromHelper());
        Assert.False(new HelperMessage { Type = HelperProtocol.DesktopInfo, Width = 0, Height = 1080, Displays = 1 }.IsValidFromHelper());
        Assert.False(new HelperMessage { Type = HelperProtocol.DesktopInfo, Width = 1920, Height = 1080, Displays = 0 }.IsValidFromHelper());
    }

    [Fact]
    public void Message_Size_Ceilings_Are_Set_Below_The_Frame_Ceiling()
    {
        Assert.True(HelperProtocol.MaxControlBytes < HelperProtocol.MaxFrameBytes);
        Assert.True(HelperProtocol.MaxControlBytes <= 8 * 1024);
    }

    // ------------------------------------------------------------ launch guard
    [Theory]
    [InlineData("nexora-rd-0123456789abcdef", true)]
    [InlineData("nexora-rd-ABC-123", true)]
    [InlineData("nexora rd", false)]
    [InlineData("../../pipe", false)]
    [InlineData("pipe;calc", false)]
    [InlineData("", false)]
    public void Pipe_Names_Are_Validated_Before_Reaching_A_Command_Line(string name, bool expected) =>
        Assert.Equal(expected, InteractiveSessionLauncher.IsSafePipeName(name));

    [Fact]
    public void Helper_Is_Only_Launched_From_A_Protected_Location()
    {
        // A user-writable path must never be executed by the privileged service.
        Assert.False(InteractiveSessionLauncher.IsProtectedLocation(@"C:\Users\bob\AppData\Local\Temp\nexora-agent.exe"));
        Assert.False(InteractiveSessionLauncher.IsProtectedLocation(@"C:\ProgramData\Nexora\Agent\nexora-agent.exe"));
        Assert.False(InteractiveSessionLauncher.IsProtectedLocation("/tmp/nexora-agent.exe"));
    }

    [Fact]
    public void Helper_Invocation_Requires_The_Explicit_Flag()
    {
        Assert.True(InteractiveSessionLauncher.IsHelperInvocation(["--remote-desktop-helper", "--pipe", "nexora-rd-abc"]));
        Assert.False(InteractiveSessionLauncher.IsHelperInvocation([]));
        Assert.False(InteractiveSessionLauncher.IsHelperInvocation(["--configure"]));
    }

    [Fact]
    public void Pipe_Name_Is_Only_Taken_From_A_Validated_Argument()
    {
        Assert.Equal("nexora-rd-abc", InteractiveSessionLauncher.PipeNameFromArgs(["--remote-desktop-helper", "--pipe", "nexora-rd-abc"]));
        Assert.Null(InteractiveSessionLauncher.PipeNameFromArgs(["--remote-desktop-helper", "--pipe", "bad name"]));
        Assert.Null(InteractiveSessionLauncher.PipeNameFromArgs(["--remote-desktop-helper", "--pipe"]));
        Assert.Null(InteractiveSessionLauncher.PipeNameFromArgs(["--remote-desktop-helper"]));
    }

    // ------------------------------------------------------------ session rules
    [Theory]
    [InlineData(InteractiveSessionEvent.Logoff, true)]
    [InlineData(InteractiveSessionEvent.Lock, true)]
    [InlineData(InteractiveSessionEvent.ConsoleDisconnect, true)]
    [InlineData(InteractiveSessionEvent.RemoteDisconnect, true)]
    [InlineData(InteractiveSessionEvent.Unlock, false)]
    [InlineData(InteractiveSessionEvent.Logon, false)]
    public void Session_Changes_That_End_A_Remote_Session_Are_Explicit(InteractiveSessionEvent change, bool ends) =>
        Assert.Equal(ends, SessionChangeNotifier.EndsRemoteDesktop(change));

    [Fact]
    public void Every_Ending_Change_Has_A_Safe_Reason_Code()
    {
        foreach (InteractiveSessionEvent change in Enum.GetValues<InteractiveSessionEvent>())
            Assert.True(HelperProtocol.IsReasonCode(SessionChangeNotifier.ReasonCode(change)), $"{change} produced an unsafe reason code");
    }

    [Fact]
    public void Notifier_Survives_A_Throwing_Subscriber()
    {
        var notifier = new SessionChangeNotifier();
        var reached = false;
        notifier.Changed += (_, _) => throw new InvalidOperationException("bad subscriber");
        notifier.Changed += (_, _) => reached = true;
        notifier.Publish(InteractiveSessionEvent.Logoff, 1);
        Assert.True(reached, "one failing handler must not stop the others");
    }

    // ------------------------------------------------- helper is not an agent
    [Fact]
    public void Helper_Holds_No_Agent_Identity_Or_Credentials()
    {
        var source = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktop/HelperHost.cs"));
        // Listed here rather than in the helper: a source-grep assertion whose
        // needles live in the file it greps always passes itself.
        foreach (var forbidden in new[]
        {
            "EnrollmentService", "AgentSigningService", "SecureStorageService", "NexoraApiClient", "IdentityService",
            "Enroll", "DeviceId", "SigningKey", "PrivateKey", "HttpClient",
        }) Assert.DoesNotContain(forbidden, source);
    }

    [Fact]
    public void Helper_Opens_No_Listener_And_No_Network_Client()
    {
        var source = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktop/HelperHost.cs"));
        foreach (var forbidden in new[] { "TcpListener", "HttpListener", "ClientWebSocket", "Socket(", "UdpClient", "NamedPipeServerStream" })
            Assert.DoesNotContain(forbidden, source);
        // Its only channel is the pipe the service handed it.
        Assert.Contains("NamedPipeClientStream", source);
    }

    [Fact]
    public void Helper_Cannot_Execute_Arbitrary_Processes()
    {
        var source = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktop/HelperHost.cs"));
        foreach (var forbidden in new[] { "Process.Start", "ProcessStartInfo", "cmd.exe", "powershell" })
            Assert.DoesNotContain(forbidden, source);
    }

    [Fact]
    public void Service_Never_Launches_The_Helper_Through_A_Shell()
    {
        var source = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktop/InteractiveSessionLauncher.cs"));
        foreach (var forbidden in new[] { "cmd.exe", "powershell", "UseShellExecute", "ShellExecute" })
            Assert.DoesNotContain(forbidden, source);
        Assert.Contains("CreateProcessAsUser", source);
    }

    [Fact]
    public void Handshake_Nonce_Is_Never_Passed_On_The_Command_Line()
    {
        // A command line is readable by any process on the machine, so the
        // per-session secret must only travel over the ACL'd pipe.
        var launcher = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktop/InteractiveSessionLauncher.cs"));
        // Assert against the code, not the prose: the launcher must never touch
        // the Nonce property, and the command line it builds carries only the
        // executable, the mode flag and the (non-secret) pipe name.
        Assert.DoesNotContain("Nonce", launcher, StringComparison.Ordinal);
        var commandLine = launcher.Split('\n').Single(line => line.Contains("var commandLine =", StringComparison.Ordinal));
        Assert.Contains("--pipe", commandLine);
        foreach (var secret in new[] { "Nonce", "secret", "token", "key" })
            Assert.DoesNotContain(secret, commandLine, StringComparison.OrdinalIgnoreCase);
        var channel = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktop/HelperChannel.cs"));
        Assert.Contains("RandomNumberGenerator.GetBytes(32)", channel);
        Assert.Contains("FixedTimeEquals", channel);
        // And it must never be logged.
        foreach (var line in channel.Split('\n').Where(l => l.Contains("Log", StringComparison.Ordinal)))
            Assert.DoesNotContain("_nonce", line);
    }

    [Fact]
    public void Pipe_Is_Restricted_And_Never_Open_To_All_Users()
    {
        var channel = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktop/HelperChannel.cs"));
        Assert.Contains("LocalSystemSid", channel);
        foreach (var forbidden in new[] { "WorldSid", "AuthenticatedUserSid", "AnonymousSid" })
            Assert.DoesNotContain(forbidden, channel);
    }

    [Fact]
    public void Helper_Is_Killed_Rather_Than_Left_Orphaned()
    {
        var channel = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktop/HelperChannel.cs"));
        Assert.Contains("KillIfAlive", channel);
        // Disposal must always reach the kill path, not only on the happy path.
        Assert.Contains("DisposeAsync", channel);
    }

    private static string SourcePath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "Nexora.Agent")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        return Path.Combine(directory!.FullName, relative);
    }
}
