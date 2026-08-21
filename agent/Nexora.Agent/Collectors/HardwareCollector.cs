using Nexora.Agent.Models;
using Nexora.Agent.Utilities;

namespace Nexora.Agent.Collectors;

public sealed class HardwareCollector
{
    public HardwareInventory Collect()
    {
        using var system = Wmi.First("SELECT Manufacturer, Model, TotalPhysicalMemory FROM Win32_ComputerSystem");
        using var cpu = Wmi.First("SELECT Name, NumberOfLogicalProcessors FROM Win32_Processor");
        using var bios = Wmi.First("SELECT SMBIOSBIOSVersion FROM Win32_BIOS");
        return new(Wmi.Text(system, "Manufacturer"), Wmi.Text(system, "Model"), Wmi.Text(cpu, "Name"), (int)Math.Max(1, Wmi.Integer(cpu, "NumberOfLogicalProcessors")), Wmi.Integer(system, "TotalPhysicalMemory"), Wmi.Text(bios, "SMBIOSBIOSVersion"));
    }
}
