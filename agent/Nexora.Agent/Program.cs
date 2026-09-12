using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Hosting;
using Nexora.Agent.Collectors;
using Nexora.Agent.Configuration;
using Nexora.Agent.Security;
using Nexora.Agent.Services;
using Nexora.Agent.Services.RemoteDesktop;

if (args.Contains("--configure", StringComparer.OrdinalIgnoreCase))
{
    await AgentConfiguration.ConfigureAsync(args);
    return;
}

// Remote Desktop interactive helper. Runs in the logged-in user's session,
// started by the service because a session-0 service has no desktop of its
// own. It builds no host, loads no configuration, reads no credentials and
// opens no network client - its only channel is the pipe named on the command
// line, and it exits the moment that pipe closes.
if (InteractiveSessionLauncher.IsHelperInvocation(args))
{
    Environment.ExitCode = await HelperHost.RunAsync(args);
    return;
}

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "NexoraAgent");
// Session-change notifications are opt-in on ServiceBase, and Remote Desktop
// needs them to react to logoff/lock immediately instead of on a poll tick.
builder.Services.AddSingleton<SessionChangeNotifier>();
if (OperatingSystem.IsWindows() && WindowsServiceHelpers.IsWindowsService())
{
    builder.Services.RemoveAll<IHostLifetime>();
    builder.Services.AddSingleton<IHostLifetime, NexoraServiceLifetime>();
}
builder.Services.AddSingleton(AgentConfiguration.Load());
builder.Services.AddSingleton<IDataProtector, DpapiDataProtector>();
builder.Services.AddSingleton<SecureStorageService>();
builder.Services.AddSingleton<AgentSigningService>();
builder.Services.AddSingleton<IdentityService>();
builder.Services.AddSingleton<BackoffPolicy>();
builder.Services.AddHttpClient<NexoraApiClient>((provider, client) =>
{
    var options = provider.GetRequiredService<AgentOptions>();
    client.BaseAddress = new Uri(options.ApiBaseUrl.TrimEnd('/') + "/");
    client.Timeout = TimeSpan.FromSeconds(options.RequestTimeoutSeconds);
});
builder.Services.AddSingleton<OperatingSystemCollector>();
builder.Services.AddSingleton<HardwareCollector>();
builder.Services.AddSingleton<DiskCollector>();
builder.Services.AddSingleton<NetworkCollector>();
builder.Services.AddSingleton<IUninstallRegistry, WindowsUninstallRegistry>();
builder.Services.AddSingleton<SoftwareCollector>();
builder.Services.AddSingleton<ServiceCollector>();
builder.Services.AddSingleton<ProcessCollector>();
builder.Services.AddSingleton<CpuCollector>();
builder.Services.AddSingleton<MemoryCollector>();
builder.Services.AddSingleton<UserCollector>();
builder.Services.AddSingleton<EnrollmentService>();
builder.Services.AddSingleton<HeartbeatService>();
builder.Services.AddSingleton<InventoryService>();
builder.Services.AddSingleton<MetricsService>();
builder.Services.AddSingleton<ServiceInventoryService>();
builder.Services.AddSingleton<ProcessInventoryService>();
builder.Services.AddSingleton<RemoteCommandExecutor>();
builder.Services.AddSingleton<RemoteCommandService>();
builder.Services.AddSingleton<InteractiveSessionLauncher>();
builder.Services.AddSingleton<RemoteDesktopService>();
builder.Services.AddHostedService<AgentWorker>();
await builder.Build().RunAsync();
