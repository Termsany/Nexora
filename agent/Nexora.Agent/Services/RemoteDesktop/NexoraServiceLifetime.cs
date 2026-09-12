using System.Runtime.Versioning;
using System.ServiceProcess;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Options;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>
/// The standard Windows service lifetime plus session-change notifications.
///
/// ServiceBase does not deliver them unless the service asks, so
/// CanHandleSessionChangeEvent is enabled here. Nothing else about the
/// lifetime changes: heartbeat, inventory and Remote Command are unaffected.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class NexoraServiceLifetime : WindowsServiceLifetime
{
    private readonly SessionChangeNotifier _notifier;

    public NexoraServiceLifetime(
        IHostEnvironment environment,
        IHostApplicationLifetime applicationLifetime,
        ILoggerFactory loggerFactory,
        IOptions<HostOptions> optionsAccessor,
        IOptions<WindowsServiceLifetimeOptions> windowsServiceOptionsAccessor,
        SessionChangeNotifier notifier)
        : base(environment, applicationLifetime, loggerFactory, optionsAccessor, windowsServiceOptionsAccessor)
    {
        _notifier = notifier;
        CanHandleSessionChangeEvent = true;
    }

    protected override void OnSessionChange(SessionChangeDescription description)
    {
        base.OnSessionChange(description);
        var change = description.Reason switch
        {
            SessionChangeReason.SessionLogon => InteractiveSessionEvent.Logon,
            SessionChangeReason.SessionLogoff => InteractiveSessionEvent.Logoff,
            SessionChangeReason.SessionLock => InteractiveSessionEvent.Lock,
            SessionChangeReason.SessionUnlock => InteractiveSessionEvent.Unlock,
            SessionChangeReason.ConsoleConnect => InteractiveSessionEvent.ConsoleConnect,
            SessionChangeReason.ConsoleDisconnect => InteractiveSessionEvent.ConsoleDisconnect,
            SessionChangeReason.RemoteConnect => InteractiveSessionEvent.RemoteConnect,
            SessionChangeReason.RemoteDisconnect => InteractiveSessionEvent.RemoteDisconnect,
            _ => InteractiveSessionEvent.Other,
        };
        _notifier.Publish(change, (uint)description.SessionId);
    }
}
