using Nexora.Agent.Utilities;

namespace Nexora.Agent.Collectors;

public sealed class CpuCollector
{
    public double Collect()
    {
        using var cpu = Wmi.First("SELECT PercentProcessorTime FROM Win32_PerfFormattedData_PerfOS_Processor WHERE Name='_Total'");
        return Math.Clamp(Wmi.Integer(cpu, "PercentProcessorTime"), 0, 100);
    }
}
