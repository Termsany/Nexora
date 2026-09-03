using Nexora.Agent.Models;
using Nexora.Agent.Utilities;

namespace Nexora.Agent.Collectors;

public sealed class DiskCollector(ILogger<DiskCollector> logger)
{
    public IReadOnlyList<DiskInventory> Collect()
    {
        var disks = new List<DiskInventory>();
        foreach (var drive in DriveInfo.GetDrives().Where(item => item.DriveType == DriveType.Fixed))
        {
            try
            {
                if (!drive.IsReady || drive.TotalSize <= 0) continue;
                var used = Math.Max(0, drive.TotalSize - drive.AvailableFreeSpace);
                disks.Add(new(drive.Name, drive.DriveFormat, drive.TotalSize, used, drive.AvailableFreeSpace, DiskUsage.Percentage(drive.TotalSize, drive.AvailableFreeSpace)));
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                logger.LogWarning(exception, "DiskCollectionFailed Drive={Drive}", drive.Name);
            }
        }
        return disks;
    }
}
