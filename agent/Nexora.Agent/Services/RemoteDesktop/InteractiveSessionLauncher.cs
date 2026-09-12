using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>Which interactive session the helper should run in, or why none was chosen.</summary>
public sealed record InteractiveSession(uint SessionId, string StationName, bool IsRemote)
{
    public override string ToString() => $"session {SessionId} ({StationName}{(IsRemote ? ", rdp" : ", console")})";
}

/// <summary>
/// Launches the capture helper inside the active interactive session.
///
/// A Windows service lives in session 0, which has no desktop. The only
/// supported way to reach the user's desktop is to run code in their session,
/// so the service duplicates the session's user token and starts a fixed
/// executable with it.
///
/// Everything here is deliberately rigid: the executable path is derived from
/// the service's own location and never from configuration or protocol data,
/// no shell is involved, and the command line carries nothing secret. The
/// per-session authentication nonce travels over the ACL'd pipe after the
/// process is running, because a command line is readable by any process on
/// the machine.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class InteractiveSessionLauncher(ILogger<InteractiveSessionLauncher> logger)
{
    private const string HelperArgument = "--remote-desktop-helper";

    #region Win32

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

    [StructLayout(LayoutKind.Sequential)]
    private struct WTS_SESSION_INFO { public uint SessionId; [MarshalAs(UnmanagedType.LPWStr)] public string pWinStationName; public int State; }

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr sessionInfo, out int count);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attributes, int impersonationLevel, int tokenType, out IntPtr duplicate);

    [DllImport("userenv.dll", SetLastError = true)] private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
    [DllImport("userenv.dll", SetLastError = true)] private static extern bool DestroyEnvironmentBlock(IntPtr environment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(
        IntPtr token, string? applicationName, string? commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint creationFlags, IntPtr environment, string? currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    private const int WTSActive = 0;
    private const uint MAXIMUM_ALLOWED = 0x02000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;

    #endregion

    /// <summary>
    /// Pick the session to attach to. Deterministic by design: the active
    /// console session wins, and if it is not active we fall back to exactly
    /// one active session. If several are active we refuse rather than guess,
    /// because guessing means showing one user's desktop to an operator who
    /// asked for another's.
    /// </summary>
    public InteractiveSession? SelectActiveSession(out string reason)
    {
        var sessions = EnumerateSessions();
        if (sessions.Count == 0) { reason = "no_interactive_session"; return null; }

        var console = WTSGetActiveConsoleSessionId();
        if (console != 0xFFFFFFFF && console != 0)
        {
            var match = sessions.FirstOrDefault(session => session.SessionId == console);
            if (match is not null) { reason = "ok"; return match; }
        }

        var active = sessions.Where(session => session.SessionId != 0).ToList();
        if (active.Count == 1) { reason = "ok"; return active[0]; }
        if (active.Count == 0) { reason = "no_active_console_session"; return null; }
        reason = "ambiguous_interactive_session";
        return null;
    }

    private List<InteractiveSession> EnumerateSessions()
    {
        var results = new List<InteractiveSession>();
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var buffer, out var count)) return results;
        try
        {
            var size = Marshal.SizeOf<WTS_SESSION_INFO>();
            for (var index = 0; index < count; index++)
            {
                var info = Marshal.PtrToStructure<WTS_SESSION_INFO>(buffer + index * size);
                if (info.State != WTSActive || info.SessionId == 0) continue;
                var station = info.pWinStationName ?? "";
                results.Add(new InteractiveSession(info.SessionId, station, station.StartsWith("RDP-", StringComparison.OrdinalIgnoreCase)));
            }
        }
        finally { WTSFreeMemory(buffer); }
        return results;
    }

    /// <summary>Fixed path beside the running service binary. Never configurable, never from protocol data.</summary>
    public static string HelperExecutablePath()
    {
        // The self-contained single-file host reports the real .exe here, which
        // is the same ACL-protected file under %ProgramFiles%\Nexora\Agent.
        var path = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(path)) return path;
        return Path.Combine(AppContext.BaseDirectory, "nexora-agent.exe");
    }

    /// <summary>
    /// Start the helper in <paramref name="session"/>. Returns the process id,
    /// or null with a reason code. The caller owns the pipe and must already
    /// be listening before this is called.
    /// </summary>
    public int? Launch(InteractiveSession session, string pipeName, out string reason)
    {
        var executable = HelperExecutablePath();
        if (!File.Exists(executable)) { reason = "helper_executable_missing"; return null; }
        if (!IsProtectedLocation(executable)) { reason = "helper_executable_untrusted"; return null; }
        if (!IsSafePipeName(pipeName)) { reason = "invalid_pipe_name"; return null; }

        var userToken = IntPtr.Zero;
        var primaryToken = IntPtr.Zero;
        var environment = IntPtr.Zero;
        try
        {
            if (!WTSQueryUserToken(session.SessionId, out userToken))
            {
                logger.LogWarning("RemoteDesktopHelperTokenUnavailable Error={Error}", Marshal.GetLastWin32Error());
                reason = "user_token_unavailable"; return null;
            }
            if (!DuplicateTokenEx(userToken, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primaryToken))
            {
                reason = "token_duplication_failed"; return null;
            }
            if (!CreateEnvironmentBlock(out environment, primaryToken, false)) environment = IntPtr.Zero;

            var startup = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(),
                // The interactive desktop of the target session. Without this
                // the process starts with no desktop and cannot capture.
                lpDesktop = @"winsta0\default",
            };

            // Argument vector is fully controlled here. The pipe name is not a
            // secret - the pipe ACL and the post-connect nonce are what
            // actually authenticate the channel.
            var commandLine = $"\"{executable}\" {HelperArgument} --pipe {pipeName}";
            var created = CreateProcessAsUser(
                primaryToken, executable, commandLine,
                IntPtr.Zero, IntPtr.Zero, false,
                CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environment, Path.GetDirectoryName(executable),
                ref startup, out var information);

            if (!created)
            {
                logger.LogWarning("RemoteDesktopHelperLaunchFailed Error={Error}", Marshal.GetLastWin32Error());
                reason = "helper_launch_failed"; return null;
            }
            CloseHandle(information.hThread);
            CloseHandle(information.hProcess);
            reason = "ok";
            logger.LogInformation("RemoteDesktopHelperLaunched Session={SessionId} Pid={Pid}", session.SessionId, information.dwProcessId);
            return information.dwProcessId;
        }
        catch (Win32Exception exception)
        {
            logger.LogWarning(exception, "RemoteDesktopHelperLaunchThrew");
            reason = "helper_launch_failed";
            return null;
        }
        finally
        {
            if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
            if (userToken != IntPtr.Zero) CloseHandle(userToken);
        }
    }

    /// <summary>
    /// Refuse to launch anything a normal user could have replaced. The
    /// installer places the binary under %ProgramFiles%, which is not
    /// user-writable; a binary anywhere else is not trusted to run elevated.
    /// </summary>
    public static bool IsProtectedLocation(string executable)
    {
        var full = Path.GetFullPath(executable);
        foreach (var folder in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
        {
            var root = Environment.GetFolderPath(folder);
            if (!string.IsNullOrEmpty(root) && full.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    /// <summary>Generated by us, but validated anyway so nothing odd reaches a command line.</summary>
    public static bool IsSafePipeName(string name) =>
        name.Length is > 0 and <= 64 && name.All(c => char.IsAsciiLetterOrDigit(c) || c == '-');

    public static bool IsHelperInvocation(string[] args) =>
        args.Any(argument => string.Equals(argument, HelperArgument, StringComparison.OrdinalIgnoreCase));

    public static string? PipeNameFromArgs(string[] args)
    {
        var index = Array.FindIndex(args, argument => string.Equals(argument, "--pipe", StringComparison.OrdinalIgnoreCase));
        if (index < 0 || index + 1 >= args.Length) return null;
        var name = args[index + 1];
        return IsSafePipeName(name) ? name : null;
    }

    public static bool ProcessIsAlive(int processId)
    {
        try { using var process = Process.GetProcessById(processId); return !process.HasExited; }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    public static void KillIfAlive(int processId)
    {
        try { using var process = Process.GetProcessById(processId); if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (Exception) { /* already gone */ }
    }

    /// <summary>Current process session id, used to prove the service really is in session 0.</summary>
    public static uint CurrentSessionId() => (uint)Process.GetCurrentProcess().SessionId;

    public static bool RunningAsSystem()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.IsSystem;
    }
}
