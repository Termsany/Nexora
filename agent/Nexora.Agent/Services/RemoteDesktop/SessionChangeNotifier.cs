using System.Runtime.Versioning;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>What the operating system told us about an interactive session.</summary>
public enum InteractiveSessionEvent { Logon, Logoff, Lock, Unlock, ConsoleConnect, ConsoleDisconnect, RemoteConnect, RemoteDisconnect, Other }

/// <summary>
/// Publishes Windows session-change notifications to whatever cares.
///
/// This exists so Remote Desktop can react the moment a user logs off or the
/// workstation locks, rather than discovering it on the next supervision tick.
/// The supervision tick stays as a backstop - notifications can be missed, and
/// a helper crash produces no notification at all - but it means the common
/// cases are immediate instead of polled.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SessionChangeNotifier
{
    /// <summary>Raised on the service control thread; handlers must not block.</summary>
    public event Action<InteractiveSessionEvent, uint>? Changed;

    public void Publish(InteractiveSessionEvent change, uint sessionId)
    {
        foreach (var handler in Changed?.GetInvocationList() ?? [])
        {
            try { ((Action<InteractiveSessionEvent, uint>)handler)(change, sessionId); }
            catch (Exception) { /* one bad subscriber must not stop the others */ }
        }
    }

    /// <summary>
    /// True when this change means any in-flight Remote Desktop session can no
    /// longer be serviced by its current helper.
    ///
    /// Lock is included deliberately: the lock screen is a different, secure
    /// desktop that the helper cannot capture, so continuing would stream
    /// capture failures. Ending cleanly and letting the operator start a new
    /// session after unlock is the honest behaviour.
    /// </summary>
    public static bool EndsRemoteDesktop(InteractiveSessionEvent change) => change switch
    {
        InteractiveSessionEvent.Logoff => true,
        InteractiveSessionEvent.Lock => true,
        InteractiveSessionEvent.ConsoleDisconnect => true,
        InteractiveSessionEvent.RemoteDisconnect => true,
        _ => false,
    };

    public static string ReasonCode(InteractiveSessionEvent change) => change switch
    {
        InteractiveSessionEvent.Logoff => "user_logged_off",
        InteractiveSessionEvent.Lock => "workstation_locked",
        InteractiveSessionEvent.ConsoleDisconnect => "console_disconnected",
        InteractiveSessionEvent.RemoteDisconnect => "remote_session_disconnected",
        _ => "interactive_session_changed",
    };
}
