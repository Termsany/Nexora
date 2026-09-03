namespace Nexora.Agent.Utilities;

public static class DiskUsage
{
    public static double Percentage(long totalBytes, long freeBytes)
    {
        if (totalBytes <= 0) return 0;
        var used = Math.Clamp(totalBytes - Math.Max(0, freeBytes), 0, totalBytes);
        return used * 100d / totalBytes;
    }
}
