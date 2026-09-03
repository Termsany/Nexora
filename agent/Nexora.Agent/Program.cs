using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Nexora.Agent.Collectors;
using Nexora.Agent.Configuration;
using Nexora.Agent.Security;
using Nexora.Agent.Services;

if (args.Contains("--configure", StringComparer.OrdinalIgnoreCase))
{
    await AgentConfiguration.ConfigureAsync(args);
    return;
}

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "NexoraAgent");
builder.Services.AddSingleton(AgentConfiguration.Load());
builder.Services.AddSingleton<IDataProtector, DpapiDataProtector>();
builder.Services.AddSingleton<SecureStorageService>();
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
builder.Services.AddSingleton<CpuCollector>();
builder.Services.AddSingleton<MemoryCollector>();
builder.Services.AddSingleton<UserCollector>();
builder.Services.AddSingleton<EnrollmentService>();
builder.Services.AddSingleton<HeartbeatService>();
builder.Services.AddSingleton<InventoryService>();
builder.Services.AddSingleton<MetricsService>();
builder.Services.AddHostedService<AgentWorker>();
await builder.Build().RunAsync();
