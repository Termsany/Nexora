using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace Nexora.Agent.Services;

public sealed record RemoteCommandResult(int? ExitCode, string Stdout, string Stderr, bool StdoutTruncated, bool StderrTruncated, bool TimedOut);

/// Executes only explicitly selected shells; no profile, environment injection, or stdin is supported.
public sealed class RemoteCommandExecutor
{
    private const int OutputLimit = 1024 * 1024;

    // Decoding contract for both shells. No BOM on the reader: a BOM would be
    // decoded as a leading U+FEFF and corrupt the first line of output.
    private static readonly Encoding Utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

    // The script is written WITHOUT a BOM too. cmd.exe does not skip a BOM in a
    // batch file - it tries to execute it, and the first line dies with
    // "'<BOM>@echo' is not recognized as an internal or external command",
    // leaving ECHO on so every later line is echoed into the caller's stdout.
    // The code page is established by the outer shell instead; see CmdPrologue.
    //
    // Outer cmd sets the console to UTF-8, then launches an inner cmd that
    // inherits it. Because the inner cmd starts with code page 65001 already
    // active, it reads the batch file as UTF-8 - which is what a BOM was
    // supposed to achieve. Only ASCII (the generated script path) crosses the
    // outer command line, so nothing can be mangled on the way in.
    private const string CmdPrologue = "chcp 65001>nul && cmd /d /s /c ";

    private static readonly TimeSpan StaleScriptAge = TimeSpan.FromHours(6);

    /// Agent-owned directory holding in-flight CMD scripts. Exposed for tests
    /// to assert cleanup; it contains no secrets and no user-controlled names.
    public static string ScriptDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Nexora", "Agent", "run");

    public async Task<RemoteCommandResult> ExecuteAsync(string shell, string command, int timeoutSeconds, string? workingDirectory, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(command) || command.Length > 64 * 1024) throw new ArgumentException("Command is invalid", nameof(command));
        if (timeoutSeconds is < 1 or > 900) throw new ArgumentOutOfRangeException(nameof(timeoutSeconds));

        var isCmd = shell.Equals("CMD", StringComparison.OrdinalIgnoreCase);
        if (!isCmd && !shell.Equals("POWERSHELL", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Unsupported shell", nameof(shell));

        // CMD only: the command text never touches the outer command line, so
        // cmd's startup code-page conversion cannot mangle non-ASCII literals.
        var scriptPath = isCmd ? WriteScript(command) : null;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = isCmd ? "cmd.exe" : "powershell.exe",
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                WorkingDirectory = string.IsNullOrWhiteSpace(workingDirectory) ? Environment.CurrentDirectory : workingDirectory,
                StandardOutputEncoding = Utf8NoBom,
                StandardErrorEncoding = Utf8NoBom,
            };
            if (isCmd) { psi.ArgumentList.Add("/d"); psi.ArgumentList.Add("/s"); psi.ArgumentList.Add("/c"); psi.ArgumentList.Add(CmdPrologue + scriptPath!); }
            else { psi.ArgumentList.Add("-NoProfile"); psi.ArgumentList.Add("-NonInteractive"); psi.ArgumentList.Add("-Command"); psi.ArgumentList.Add("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + command); }

            using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            process.Start();
            var stdout = ReadBoundedAsync(process.StandardOutput);
            var stderr = ReadBoundedAsync(process.StandardError);
            var timedOut = false;
            var exitTask = process.WaitForExitAsync(cancellationToken);
            var timeoutTask = Task.Delay(TimeSpan.FromSeconds(timeoutSeconds), cancellationToken);
            var completed = await Task.WhenAny(exitTask, timeoutTask);
            if (completed == timeoutTask && !exitTask.IsCompleted) { timedOut = true; try { process.Kill(entireProcessTree: true); } catch { } await process.WaitForExitAsync(CancellationToken.None); }
            var output = await stdout; var error = await stderr;
            return new RemoteCommandResult(timedOut ? null : process.ExitCode, output.Text, error.Text, output.Truncated, error.Truncated, timedOut);
        }
        finally
        {
            // Runs on success, non-zero exit, timeout, cancellation and launch
            // failure alike. Deletion is best-effort: a file we cannot remove is
            // swept later by PurgeStaleScripts rather than failing the command.
            if (scriptPath is not null) { try { File.Delete(scriptPath); } catch { } }
        }
    }

    /// Writes `command` to a freshly created, Agent-owned UTF-8 script.
    ///
    /// cmd.exe converts its /c command line to the code page that was active
    /// when it started, so a chcp inside that same line is always too late for
    /// non-ASCII literals - they arrive already replaced by '?'. Moving the
    /// command into a file keeps it off that command line entirely; the outer
    /// shell switches the console to UTF-8 first, so the inner cmd reads the
    /// file as UTF-8 and its built-ins and console-aware children both emit it.
    private static string WriteScript(string command)
    {
        var directory = EnsureScriptDirectory();
        PurgeStaleScripts(directory);

        // Cryptographically random, fixed-shape name. Nothing derived from the
        // command: a filename is visible to anything that can list the
        // directory, and command text may carry sensitive arguments.
        for (var attempt = 0; ; attempt++)
        {
            var path = Path.Combine(directory, "nexora-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant() + ".cmd");
            try
            {
                // CreateNew is the atomic part: it fails if the name exists at
                // all, so two concurrent executions can never share a file, and
                // a pre-planted file or symlink cannot be written through.
                using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                using var writer = new StreamWriter(stream, Utf8NoBom);
                // @echo off: a batch file echoes each line by default, which
                // would inject the command text into the caller's stdout.
                writer.Write("@echo off\r\n");
                writer.Write(command);
                writer.Write("\r\n");
                return path;
            }
            catch (IOException) when (File.Exists(path) && attempt < 4)
            {
                // Name collision only; any other IO failure propagates.
            }
        }
    }

    private static string EnsureScriptDirectory()
    {
        // The path is embedded unquoted in the outer command line, so a space
        // would split it into two arguments. ProgramData is space-free on every
        // standard Windows install; fail loudly rather than mis-execute if not.
        if (ScriptDirectory.Any(char.IsWhiteSpace)) throw new InvalidOperationException("Agent script directory path must not contain whitespace");
        if (Directory.Exists(ScriptDirectory)) return ScriptDirectory;
        Directory.CreateDirectory(Path.GetDirectoryName(ScriptDirectory)!);
        try
        {
            // Deliberately not %TEMP%. For a service running as LocalSystem that
            // resolves to C:\Windows\Temp, where every user may create files -
            // a poor place for anything an elevated process will execute.
            // Inheritance is severed and only SYSTEM, Administrators and the
            // Agent's own account are granted access.
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            const InheritanceFlags inherit = InheritanceFlags.ObjectInherit | InheritanceFlags.ContainerInherit;
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            using var identity = WindowsIdentity.GetCurrent();
            if (identity.User is not null) security.AddAccessRule(new FileSystemAccessRule(identity.User, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(ScriptDirectory).Create(security);
        }
        catch (UnauthorizedAccessException)
        {
            // Cannot set the ACL we want - fall back to plain creation under
            // ProgramData, which is still far better than a shared temp path.
            Directory.CreateDirectory(ScriptDirectory);
        }
        catch (PlatformNotSupportedException)
        {
            Directory.CreateDirectory(ScriptDirectory);
        }
        return ScriptDirectory;
    }

    /// A crash or hard kill between writing and deleting would otherwise leave
    /// a script behind forever. Sweep anything clearly older than any command
    /// could still be running (the executor caps a command at 900s).
    private static void PurgeStaleScripts(string directory)
    {
        try
        {
            var cutoff = DateTime.UtcNow - StaleScriptAge;
            foreach (var file in Directory.EnumerateFiles(directory, "nexora-*.cmd"))
            {
                try { if (File.GetLastWriteTimeUtc(file) < cutoff) File.Delete(file); } catch { }
            }
        }
        catch { }
    }

    private static async Task<(string Text, bool Truncated)> ReadBoundedAsync(StreamReader reader)
    {
        var buffer = new char[8192]; var builder = new StringBuilder(); var truncated = false;
        while (true) { var count = await reader.ReadAsync(buffer.AsMemory()); if (count == 0) break; if (builder.Length < OutputLimit) { var take = Math.Min(count, OutputLimit - builder.Length); builder.Append(buffer, 0, take); if (take < count) truncated = true; } else truncated = true; }
        return (builder.ToString(), truncated);
    }
}
