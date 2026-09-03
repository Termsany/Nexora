namespace Nexora.Agent.Collectors;

public sealed class UserCollector
{
    public string? CurrentUser => GetInteractiveUser()?.Split('\\').LastOrDefault();
    public string? Domain
    {
        get
        {
            var user = GetInteractiveUser();
            return user?.Contains('\\') == true ? user.Split('\\')[0] : null;
        }
    }
    public long UptimeSeconds => Math.Max(0, Environment.TickCount64 / 1000);

    private static string? GetInteractiveUser()
    {
        using var system = Utilities.Wmi.First("SELECT UserName FROM Win32_ComputerSystem");
        return Utilities.Wmi.Text(system, "UserName");
    }
}
