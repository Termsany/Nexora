using System.Runtime.InteropServices;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>
/// Windows session-0 isolation check.
///
/// The Agent runs as a Windows service, and services live in session 0, which
/// has its own window station with no interactive desktop attached. A capture
/// attempted from there succeeds at the API level and returns a black image -
/// the worst possible failure, because it looks like it is working.
///
/// Rather than stream black frames, the Agent detects the condition and
/// reports a specific reason code so the console can say something true. The
/// fix is to run the capture in the active console session via a helper
/// process launched with CreateProcessAsUser; until that exists, Remote
/// Desktop is only functional when the Agent runs interactively.
/// </summary>
public static class DesktopSession
{
    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    public static uint CurrentSessionId()
    {
        return ProcessIdToSessionId(GetCurrentProcessId(), out var session) ? session : 0;
    }

    public static uint ActiveConsoleSessionId() => WTSGetActiveConsoleSessionId();

    /// <summary>True when this process cannot see the interactive desktop.</summary>
    public static bool IsIsolatedFromInteractiveDesktop()
    {
        var current = CurrentSessionId();
        if (current == 0) return true;
        var console = ActiveConsoleSessionId();
        // 0xFFFFFFFF means no user is currently attached to the console.
        return console == 0xFFFFFFFF || console != current;
    }

    /// <summary>Stable, non-sensitive reason code for the wire, or null when capture can proceed.</summary>
    public static string? BlockingReason()
    {
        if (CurrentSessionId() == 0) return "session0_isolation";
        if (ActiveConsoleSessionId() == 0xFFFFFFFF) return "no_active_console_session";
        if (IsIsolatedFromInteractiveDesktop()) return "session_mismatch";
        return null;
    }
}
