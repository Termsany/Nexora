namespace Nexora.Agent.Services;

public sealed class BackoffPolicy
{
    private static readonly int[] Delays = [5, 10, 30, 60, 120, 300];

    public TimeSpan Delay(int attempt, Random? random = null)
    {
        random ??= Random.Shared;
        var baseSeconds = Delays[Math.Clamp(attempt, 0, Delays.Length - 1)];
        return TimeSpan.FromMilliseconds(baseSeconds * 1000 + random.Next(0, Math.Max(1, baseSeconds * 200)));
    }
}
