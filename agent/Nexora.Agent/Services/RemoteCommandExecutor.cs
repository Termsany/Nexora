using System.Diagnostics;
using System.Text;

namespace Nexora.Agent.Services;

public sealed record RemoteCommandResult(int? ExitCode, string Stdout, string Stderr, bool StdoutTruncated, bool StderrTruncated, bool TimedOut);

/// Executes only explicitly selected shells; no profile, environment injection, or stdin is supported.
public sealed class RemoteCommandExecutor
{
    private const int OutputLimit = 1024 * 1024;

    public async Task<RemoteCommandResult> ExecuteAsync(string shell, string command, int timeoutSeconds, string? workingDirectory, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(command) || command.Length > 64 * 1024) throw new ArgumentException("Command is invalid", nameof(command));
        if (timeoutSeconds is < 1 or > 900) throw new ArgumentOutOfRangeException(nameof(timeoutSeconds));
        var psi = new ProcessStartInfo
        {
            FileName = shell.Equals("CMD", StringComparison.OrdinalIgnoreCase) ? "cmd.exe" : shell.Equals("POWERSHELL", StringComparison.OrdinalIgnoreCase) ? "powershell.exe" : throw new ArgumentException("Unsupported shell", nameof(shell)),
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = string.IsNullOrWhiteSpace(workingDirectory) ? Environment.CurrentDirectory : workingDirectory,
        };
        if (shell.Equals("CMD", StringComparison.OrdinalIgnoreCase)) psi.ArgumentList.Add("/c");
        else { psi.ArgumentList.Add("-NoProfile"); psi.ArgumentList.Add("-NonInteractive"); psi.ArgumentList.Add("-Command"); }
        psi.ArgumentList.Add(command);
        using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        process.Start();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
        var stdout = ReadBoundedAsync(process.StandardOutput, timeout.Token);
        var stderr = ReadBoundedAsync(process.StandardError, timeout.Token);
        var timedOut = false;
        try { await process.WaitForExitAsync(timeout.Token); } catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { timedOut = true; try { process.Kill(entireProcessTree: true); } catch { } await process.WaitForExitAsync(CancellationToken.None); }
        var output = await stdout; var error = await stderr;
        return new RemoteCommandResult(timedOut ? null : process.ExitCode, output.Text, error.Text, output.Truncated, error.Truncated, timedOut);
    }

    private static async Task<(string Text, bool Truncated)> ReadBoundedAsync(StreamReader reader, CancellationToken token)
    {
        var buffer = new char[8192]; var builder = new StringBuilder(); var truncated = false;
        while (true) { var count = await reader.ReadAsync(buffer.AsMemory(), token); if (count == 0) break; if (builder.Length < OutputLimit) { var take = Math.Min(count, OutputLimit - builder.Length); builder.Append(buffer, 0, take); if (take < count) truncated = true; } else truncated = true; }
        return (builder.ToString(), truncated);
    }
}
