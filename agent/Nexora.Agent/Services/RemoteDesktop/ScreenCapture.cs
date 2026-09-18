using System.Drawing;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Nexora.Agent.Services.RemoteDesktop;

/// <summary>
/// Primary-display capture, scaled and JPEG encoded.
///
/// GDI (BitBlt, via Graphics.CopyFromScreen) is deliberate for V1. Desktop
/// Duplication would give higher frame rates and dirty-rectangle updates, but
/// it is a large DXGI COM surface and this release targets a stable 10-20 FPS
/// support experience rather than an unstable fast one. The interface here is
/// the seam to swap in Desktop Duplication later without touching transport.
///
/// Encoding cost is bounded by scaling first: a 4K desktop is resampled to at
/// most MaxWidth before the encoder ever sees it.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ScreenCapture : IDisposable
{
    private int _maxWidth;
    private long _quality;
    private Bitmap? _surface;
    private Bitmap? _scaled;
    private readonly ImageCodecInfo _jpeg;
    private readonly EncoderParameters _encoderParameters;

    public int Width { get; private set; }
    public int Height { get; private set; }
    public int Displays { get; private set; } = 1;
    public double CaptureMs { get; private set; }
    public double EncodeMs { get; private set; }
    public CapturePerformance Performance { get; }

    public void ApplyPerformance()
    {
        _maxWidth = Performance.Width;
        if (_quality == Performance.Quality) return;
        _quality = Performance.Quality;
        _encoderParameters.Param[0].Dispose();
        _encoderParameters.Param[0] = new EncoderParameter(Encoder.Quality, _quality);
    }

    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    private const int SM_CXSCREEN = 0, SM_CYSCREEN = 1, SM_CMONITORS = 80;

    public ScreenCapture(int maxWidth, int quality)
    {
        _maxWidth = Math.Clamp(maxWidth, 320, 3840);
        _quality = Math.Clamp(quality, 20, 95);
        Performance = new CapturePerformance(_maxWidth, (int)_quality);
        _jpeg = ImageCodecInfo.GetImageEncoders().First(codec => codec.FormatID == ImageFormat.Jpeg.Guid);
        _encoderParameters = new EncoderParameters(1);
        _encoderParameters.Param[0] = new EncoderParameter(Encoder.Quality, _quality);
        Measure();
    }

    private void Measure()
    {
        Width = Math.Max(1, GetSystemMetrics(SM_CXSCREEN));
        Height = Math.Max(1, GetSystemMetrics(SM_CYSCREEN));
        Displays = Math.Max(1, GetSystemMetrics(SM_CMONITORS));
    }

    /// <summary>
    /// Capture one frame. Returns null if the desktop is unreachable, which the
    /// caller reports as an error rather than sending a black frame.
    /// </summary>
    public byte[]? Capture()
    {
        ApplyPerformance();
        var started = Stopwatch.GetTimestamp();
        // Resolution can change mid-session (display swap, RDP resize).
        var previousWidth = Width;
        var previousHeight = Height;
        Measure();
        if (Width != previousWidth || Height != previousHeight) { _surface?.Dispose(); _surface = null; _scaled?.Dispose(); _scaled = null; }

        try
        {
            _surface ??= new Bitmap(Width, Height, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
            using (var graphics = Graphics.FromImage(_surface))
            {
                graphics.CopyFromScreen(0, 0, 0, 0, new Size(Width, Height), CopyPixelOperation.SourceCopy);
            }

            Image source = _surface;
            if (Width > _maxWidth)
            {
                var targetHeight = Math.Max(1, (int)Math.Round(Height * (_maxWidth / (double)Width)));
                if (_scaled is null || _scaled.Width != _maxWidth || _scaled.Height != targetHeight)
                {
                    _scaled?.Dispose();
                    _scaled = new Bitmap(_maxWidth, targetHeight, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
                }
                using var scaler = Graphics.FromImage(_scaled);
                scaler.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                scaler.DrawImage(_surface, 0, 0, _maxWidth, targetHeight);
                source = _scaled;
            }

            using var buffer = new MemoryStream(capacity: 128 * 1024);
            CaptureMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            var encoding = Stopwatch.GetTimestamp();
            source.Save(buffer, _jpeg, _encoderParameters);
            EncodeMs = Stopwatch.GetElapsedTime(encoding).TotalMilliseconds;
            return buffer.ToArray();
        }
        catch (Exception)
        {
            // A desktop switch (lock screen, UAC secure desktop) makes
            // CopyFromScreen throw. Report the gap; never fabricate a frame.
            _surface?.Dispose(); _surface = null;
            _scaled?.Dispose(); _scaled = null;
            return null;
        }
    }

    public void Dispose()
    {
        _surface?.Dispose();
        _scaled?.Dispose();
        _encoderParameters.Dispose();
    }
}
