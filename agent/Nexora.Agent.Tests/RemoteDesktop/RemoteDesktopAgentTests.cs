using System.Reflection;
using Nexora.Agent.Services;
using Nexora.Agent.Services.RemoteDesktop;
using Xunit;

namespace Nexora.Agent.Tests.RemoteDesktop;

/// <summary>
/// Agent-side Remote Desktop contract. The input allow-list and the capability
/// advertisement are asserted here because both are security boundaries: one
/// decides what a remote operator can press, the other decides whether the
/// server will offer this device a session at all.
/// </summary>
public sealed class RemoteDesktopAgentTests
{
    [Fact]
    public void RemoteDesktop_Advertises_Capability_Without_Dropping_RemoteCommand()
    {
        var source = File.ReadAllText(SourcePath("Nexora.Agent/Services/HeartbeatService.cs"));
        Assert.Contains("remote_desktop_v1", source);
        // Older servers and the existing feature must both keep working.
        Assert.Contains("remote_command_v1", source);
    }

    [Theory]
    [InlineData("KeyA")]
    [InlineData("Digit0")]
    [InlineData("F12")]
    [InlineData("ControlLeft")]
    [InlineData("MetaLeft")]
    [InlineData("ArrowUp")]
    [InlineData("Escape")]
    public void KnownKeys_Are_Accepted(string code) => Assert.True(InputInjector.IsKnownKey(code));

    [Theory]
    [InlineData("")]
    [InlineData("Key A")]
    [InlineData("keya")]
    [InlineData("../../etc/passwd")]
    [InlineData("shutdown /s")]
    [InlineData("Key;rm -rf")]
    [InlineData("F13")]
    [InlineData("Unknown")]
    public void UnknownKeys_Are_Refused(string code) => Assert.False(InputInjector.IsKnownKey(code));

    [Fact]
    public void Input_Never_Reaches_A_Shell()
    {
        // The value of this assertion is structural: if someone later routes a
        // key name through a process launch, this fails.
        var injector = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktop/InputInjector.cs"));
        foreach (var forbidden in new[] { "Process", "cmd.exe", "powershell", "ProcessStartInfo", "ShellExecute" })
            Assert.DoesNotContain(forbidden, injector);
    }

    [Fact]
    public void Capture_Refuses_Rather_Than_Streaming_Black_Frames()
    {
        var service = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktopService.cs"));
        // A session-0 service sees a black desktop; reporting it is the only
        // honest behaviour, so the guard must be consulted before capture.
        Assert.Contains("DesktopSession.BlockingReason()", service);
        Assert.Contains("agent.error", service);
        var blockIndex = service.IndexOf("BlockingReason()", StringComparison.Ordinal);
        var captureIndex = service.IndexOf("new ScreenCapture(", StringComparison.Ordinal);
        Assert.True(blockIndex > 0 && captureIndex > blockIndex, "the isolation guard must run before capture starts");
    }

    [Fact]
    public void Channel_Is_Outbound_And_Carries_No_Listening_Port()
    {
        var service = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktopService.cs"));
        Assert.Contains("ClientWebSocket", service);
        // Nothing may listen on the customer machine.
        foreach (var forbidden in new[] { "HttpListener", "TcpListener", "Bind(", "WebSocketServer" })
            Assert.DoesNotContain(forbidden, service);
    }

    [Fact]
    public void Channel_Token_Travels_As_A_Header_Not_In_The_Url()
    {
        var service = File.ReadAllText(SourcePath("Nexora.Agent/Services/RemoteDesktopService.cs"));
        Assert.Contains("X-Nexora-Session-Token", service);
        Assert.DoesNotContain("?token=", service);
    }

    [Fact]
    public void Channel_Uri_Upgrades_Https_To_Wss()
    {
        var method = typeof(RemoteDesktopService).GetMethod("BuildChannelUri", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(method);
        var options = new Nexora.Agent.Configuration.AgentOptions("https://nexora.example.test/api/", null);
        var service = (RemoteDesktopService)Activator.CreateInstance(typeof(RemoteDesktopService), null!, null!, options, null!)!;

        var secure = method!.Invoke(service, ["/api/v1/agent/remote-desktop/abc/channel"]) as Uri;
        Assert.Equal("wss://nexora.example.test/api/v1/agent/remote-desktop/abc/channel", secure?.ToString());

        // A path that did not come from the server is refused rather than dialled.
        Assert.Null(method.Invoke(service, ["https://evil.example/steal"]));
        Assert.Null(method.Invoke(service, [""]));
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
