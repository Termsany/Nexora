using System.Diagnostics.Tracing;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>Local capture/transport pressure, not an estimate of viewer RTT.</summary>
public sealed class CapturePerformance
{
    private static readonly EventSource Events = new("Nexora-RemoteDesktop-Performance");
    private readonly int ceilingWidth;
    private readonly int ceilingQuality;
    private int samples, healthyWindows;
    private double captureTotal, encodeTotal, sendTotal;
    private long byteTotal;
    public int Width { get; private set; }
    public int Quality { get; private set; }

    public CapturePerformance(int width, int quality)
    {
        Width = ceilingWidth = Math.Clamp(width, 320, 3840);
        Quality = ceilingQuality = Math.Clamp(quality, 20, 95);
    }

    public void Observe(double captureMs, double encodeMs, double sendMs, int bytes)
    {
        if (!double.IsFinite(captureMs + encodeMs + sendMs) || captureMs < 0 || encodeMs < 0 || sendMs < 0 || bytes < 0) return;
        captureTotal += captureMs; encodeTotal += encodeMs; sendTotal += sendMs; byteTotal += bytes;
        if (++samples < 24) return;
        var cost = (captureTotal + encodeTotal + sendTotal) / samples;
        var size = byteTotal / samples;
        Events.Write("FrameWindow", new { CaptureMs = captureTotal / samples, EncodeMs = encodeTotal / samples,
            SendMs = sendTotal / samples, FrameBytes = size, Width, Quality });
        if (cost > 100 || size > 200 * 1024)
        {
            Quality = Math.Max(Math.Min(35, ceilingQuality), Quality - 5);
            Width = Math.Max(Math.Min(800, ceilingWidth), Width - 160);
            healthyWindows = 0;
        }
        else if (cost < 50 && size < 100 * 1024)
        {
            if (++healthyWindows >= 5)
            {
                Quality = Math.Min(ceilingQuality, Quality + 5);
                Width = Math.Min(ceilingWidth, Width + 160);
                healthyWindows = 0;
            }
        }
        else healthyWindows = 0;
        samples = 0; captureTotal = encodeTotal = sendTotal = 0; byteTotal = 0;
    }
}
