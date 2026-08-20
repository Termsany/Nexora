using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Nexora.Agent.Services;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "Nexora Agent");
builder.Services.AddHttpClient<ApiClient>();
builder.Services.AddSingleton<IdentityService>();
builder.Services.AddHostedService<AgentWorker>();
await builder.Build().RunAsync();