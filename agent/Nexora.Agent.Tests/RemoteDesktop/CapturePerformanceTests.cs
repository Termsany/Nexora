using Nexora.Agent.Services.RemoteDesktop;
using Xunit;

namespace Nexora.Agent.Tests.RemoteDesktop;

public sealed class CapturePerformanceTests
{
    [Fact]
    public void PressureReducesQualityWithinBounds()
    {
        var policy = new CapturePerformance(1600, 60);
        for (var i = 0; i < 1000; i++) policy.Observe(20, 40, 150, 300_000);
        Assert.Equal(800, policy.Width); Assert.Equal(35, policy.Quality);
    }
    [Fact]
    public void RecoveryIsSlowerAndNeverExceedsOriginalProfile()
    {
        var policy = new CapturePerformance(1600, 60);
        for (var i = 0; i < 24; i++) policy.Observe(20, 40, 150, 300_000);
        Assert.Equal(1440, policy.Width);
        for (var i = 0; i < 24; i++) policy.Observe(5, 5, 5, 20_000);
        Assert.Equal(1440, policy.Width);
        for (var i = 0; i < 1000; i++) policy.Observe(5, 5, 5, 20_000);
        Assert.Equal(1600, policy.Width); Assert.Equal(60, policy.Quality);
    }
    [Fact]
    public void InvalidSamplesDoNotAffectProfile()
    {
        var policy = new CapturePerformance(1600, 60);
        for (var i = 0; i < 1000; i++) policy.Observe(double.NaN, 0, 0, 0);
        Assert.Equal(1600, policy.Width); Assert.Equal(60, policy.Quality);
    }
    [Fact]
    public void SmallRequestedProfileIsNeverRaisedByPressure()
    {
        var policy = new CapturePerformance(320, 20);
        for (var i = 0; i < 240; i++) policy.Observe(200, 0, 0, 500_000);
        Assert.Equal(320, policy.Width); Assert.Equal(20, policy.Quality);
    }
}
