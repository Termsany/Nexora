using Nexora.Agent.Models;
using Nexora.Agent.Utilities;

namespace Nexora.Agent.Collectors;

public sealed class OperatingSystemCollector
{
    public OperatingSystemInventory Collect()
    {
        using var os = Wmi.First("SELECT Caption, Version, BuildNumber, OSArchitecture FROM Win32_OperatingSystem");
        return new(Wmi.Text(os, "Caption") ?? "Windows", Wmi.Text(os, "Version") ?? Environment.OSVersion.Version.ToString(), Wmi.Text(os, "BuildNumber") ?? Environment.OSVersion.Version.Build.ToString(), Wmi.Text(os, "OSArchitecture") ?? System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString());
    }
}
