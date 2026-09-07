using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

#if CRASH_ON_START
// Built only for the "new binary fails to start" rollback acceptance test: exits before
// ever registering with the Service Control Manager, so Start-Service/WaitForStatus in
// upgrade-agent.ps1 times out and the script rolls back to the previous install.
return 17;
#else

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "NexoraAgent");
builder.Services.AddHostedService<IdleService>();
await builder.Build().RunAsync();
return 0;

sealed class IdleService : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown path when the SCM stops the service.
        }
    }
}
#endif
