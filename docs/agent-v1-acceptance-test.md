# Nexora Agent V1 acceptance test

This procedure requires a real Windows x64 endpoint and a Nexora deployment reachable over HTTPS. The simulator does not satisfy this test.

## Preparation

1. Create an enrollment token through `POST /api/v1/admin/enrollment-tokens` using the configured administrative bearer token.
2. Publish with `dotnet publish agent/Nexora.Agent/Nexora.Agent.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true`.
3. Copy the publish directory and `scripts/windows` to Windows.
4. From elevated PowerShell run `./install-agent.ps1 -ApiBaseUrl "https://nexora.example/api/" -EnrollmentToken "<token>" -SourcePath "<publish-directory>"`.

## Tests

1. **Install:** `Get-Service NexoraAgent` reports `Running`; exactly one device appears and becomes `ONLINE`.
2. **Inventory:** hostname, user, domain, Windows version/build, CPU, RAM, fixed disks, IPv4, and agent version match the PC.
3. **Service restart:** `Restart-Service NexoraAgent`; the same device UUID remains, no duplicate appears, and status returns to `ONLINE`.
4. **Offline:** `Stop-Service NexoraAgent`; after more than 120 seconds status becomes `OFFLINE` with one `ONLINE_TO_OFFLINE` event.
5. **Recovery:** `Start-Service NexoraAgent`; the same endpoint becomes `ONLINE` with one `OFFLINE_TO_ONLINE` event.
6. **Windows restart:** restart Windows; the service starts automatically and the same endpoint returns `ONLINE`.
7. **Network loss:** disconnect for more than 120 seconds; service stays running and endpoint becomes `OFFLINE`. Reconnect; it returns `ONLINE` without re-enrollment.
