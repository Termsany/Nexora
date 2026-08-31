using System.Diagnostics;
using Nexora.Agent.Configuration;
using Nexora.Agent.Models;

namespace Nexora.Agent.Collectors;

public sealed class ProcessCollector
{
    private readonly Dictionary<(int Pid, DateTimeOffset StartedAt), CpuSample> previous = [];
    private readonly Func<Process[]> processes;

    public ProcessCollector() : this(Process.GetProcesses) { }
    internal ProcessCollector(Func<Process[]> processes) => this.processes = processes;

    public ProcessSnapshot Collect(DateTimeOffset? collectedAt = null)
    {
        var now = collectedAt ?? DateTimeOffset.UtcNow;
        var items = new List<ProcessInventory>();
        var status = CollectionStatus.Complete;
        Process[] discovered;
        try { discovered = processes(); }
        catch { return new ProcessSnapshot(Guid.NewGuid(), now, CollectionStatus.Failed, 0, AgentVersion.Current, []); }
        var next = new Dictionary<(int, DateTimeOffset), CpuSample>();
        foreach (var process in discovered)
        {
            try
            {
                if (process.Id <= 0) { status = CollectionStatus.Partial; continue; }
                var started = new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero);
                var cpu = process.TotalProcessorTime;
                var key = (process.Id, started);
                var cpuPercent = previous.TryGetValue(key, out var prior)
                    ? CalculateCpuPercent(prior.CpuTime, cpu, prior.ObservedAt, now, Environment.ProcessorCount) : null;
                next[key] = new CpuSample(cpu, now);
                items.Add(new ProcessInventory(process.Id, process.ProcessName, Safe(() => process.MainModule?.FileName), null,
                    Math.Max(0, cpu.TotalSeconds), cpuPercent, Math.Max(0, process.WorkingSet64), SafeLong(() => process.PrivateMemorySize64),
                    SafeInt(() => process.Threads.Count), SafeInt(() => process.HandleCount), started, ProcessArchitecture.Unknown, SafeInt(() => process.SessionId)));
            }
            catch { status = CollectionStatus.Partial; }
            finally { process.Dispose(); }
        }
        previous.Clear(); foreach (var sample in next) previous[sample.Key] = sample.Value;
        var ordered = items.GroupBy(x => (x.Pid, x.StartedAt)).Select(x => x.First()).OrderBy(x => x.Pid).Take(10000).ToArray();
        return new ProcessSnapshot(Guid.NewGuid(), now, status, ordered.Length, AgentVersion.Current, ordered);
    }

    public static double? CalculateCpuPercent(TimeSpan priorCpu, TimeSpan currentCpu, DateTimeOffset priorAt, DateTimeOffset currentAt, int processors)
    {
        var wall = (currentAt - priorAt).TotalSeconds;
        var delta = (currentCpu - priorCpu).TotalSeconds;
        if (wall <= 0 || delta < 0 || processors <= 0) return null;
        return Math.Clamp(delta / wall / processors * 100d, 0, 100);
    }

    private static string? Safe(Func<string?> value) { try { return value()?.Replace("\0", "", StringComparison.Ordinal).Trim(); } catch { return null; } }
    private static long? SafeLong(Func<long> value) { try { return Math.Max(0, value()); } catch { return null; } }
    private static int? SafeInt(Func<int> value) { try { return Math.Max(0, value()); } catch { return null; } }
    private sealed record CpuSample(TimeSpan CpuTime, DateTimeOffset ObservedAt);
}
