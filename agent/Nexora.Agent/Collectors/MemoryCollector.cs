using Nexora.Agent.Models;
using Nexora.Agent.Utilities;

namespace Nexora.Agent.Collectors;

public sealed class MemoryCollector
{
    public MemorySnapshot Collect()
    {
        using var os = Wmi.First("SELECT TotalVisibleMemorySize, FreePhysicalMemory FROM Win32_OperatingSystem");
        return new(Math.Max(0, Wmi.Integer(os, "TotalVisibleMemorySize") * 1024), Math.Max(0, Wmi.Integer(os, "FreePhysicalMemory") * 1024));
    }
}
