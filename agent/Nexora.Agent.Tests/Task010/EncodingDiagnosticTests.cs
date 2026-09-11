using System.Text;
using Nexora.Agent.Services;
using Xunit;

namespace Nexora.Agent.Tests.Task010;

/// TEMPORARY diagnostic. Dumps the raw code units the executor actually
/// returns for representative CMD commands so the encoding contract can be
/// designed from measurements rather than assumptions. Always fails, by design,
/// so the dump surfaces in the run. Delete once the contract is settled.
public sealed class EncodingDiagnosticTests
{
    [Fact]
    public async Task Task010_Diag_RawCodeUnits()
    {
        var report = new StringBuilder();
        report.Append("MachineName=").Append(Environment.MachineName).Append(" | ");

        foreach (var (label, shell, command) in new[]
                 {
                     ("cmd-hostname", "CMD", "hostname"),
                     ("cmd-echo-ascii", "CMD", "echo NEXORA-CMD-OK"),
                     ("cmd-echo-unicode", "CMD", "echo NEXORA-عربي-✓"),
                     ("cmd-chcp-probe", "CMD", "chcp"),
                 })
        {
            try
            {
                var r = await new RemoteCommandExecutor().ExecuteAsync(shell, command, 10, null, CancellationToken.None);
                var units = string.Join(",", r.Stdout.Select(c => ((int)c).ToString("X4")));
                report.Append(label).Append(" exit=").Append(r.ExitCode)
                      .Append(" len=").Append(r.Stdout.Length)
                      .Append(" units=[").Append(units).Append("] ");
            }
            catch (Exception ex)
            {
                report.Append(label).Append(" THREW ").Append(ex.GetType().Name).Append(' ');
            }
        }

        Assert.Fail(report.ToString());
    }
}
