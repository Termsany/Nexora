using System.Diagnostics;
using System.Text;

namespace Nexora.Agent.Services;

public sealed record RemoteCommandResult(int? ExitCode, string Stdout, string Stderr, bool StdoutTruncated, bool StderrTruncated, bool TimedOut);

/// Executes only explicitly selected shells; no profile, environment injection, or stdin is supported.
public sealed class RemoteCommandExecutor
{
    private const int OutputLimit = 1024 * 1024;

    // One encoding contract for every redirected shell. No BOM: a BOM would be
    // decoded as a leading U+FEFF and corrupt the first line of output.
    private static readonly Encoding Utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

    // cmd.exe /u makes only cmd's own INTERNAL commands (echo, dir, set, ...)
    // write UTF-16LE. An external executable is a separate process that inherits
    // the pipe handle and writes its own bytes; cmd never transcodes it. So /u
    // produces a MIXED stream that no single decoder can read - which is exactly
    // how `hostname` (hostname.exe, 8-bit "Deploy\r\n") became U+6544 U+6C70
    // U+796F U+0A0D when the reader assumed UTF-16LE.
    //
    // Instead, make the whole session UTF-8: chcp sets the console output code
    // page for cmd AND for the console-aware children it launches, and the
    // reader decodes UTF-8. Redirected to >nul so chcp's own banner never
    // reaches the caller's stdout.
    private const string CmdUtf8Prologue = "chcp 65001>nul & ";

    public async Task<RemoteCommandResult> ExecuteAsync(string shell, string command, int timeoutSeconds, string? workingDirectory, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(command) || command.Length > 64 * 1024) throw new ArgumentException("Command is invalid", nameof(command));
        if (timeoutSeconds is < 1 or > 900) throw new ArgumentOutOfRangeException(nameof(timeoutSeconds));
        var psi = new ProcessStartInfo
        {
            FileName = shell.Equals("CMD", StringComparison.OrdinalIgnoreCase) ? "cmd.exe" : shell.Equals("POWERSHELL", StringComparison.OrdinalIgnoreCase) ? "powershell.exe" : throw new ArgumentException("Unsupported shell", nameof(shell)),
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = string.IsNullOrWhiteSpace(workingDirectory) ? Environment.CurrentDirectory : workingDirectory,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
        };
        if (shell.Equals("CMD", StringComparison.OrdinalIgnoreCase)) { psi.ArgumentList.Add("/d"); psi.ArgumentList.Add("/s"); psi.ArgumentList.Add("/c"); psi.ArgumentList.Add(CmdUtf8Prologue + command); }
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

    private static async Task<(string Text, bool Truncated)> ReadBoundedAsync(StreamReader reader)
    {
        var buffer = new char[8192]; var builder = new StringBuilder(); var truncated = false;
        while (true) { var count = await reader.ReadAsync(buffer.AsMemory()); if (count == 0) break; if (builder.Length < OutputLimit) { var take = Math.Min(count, OutputLimit - builder.Length); builder.Append(buffer, 0, take); if (take < count) truncated = true; } else truncated = true; }
        return (builder.ToString(), truncated);
    }
}
