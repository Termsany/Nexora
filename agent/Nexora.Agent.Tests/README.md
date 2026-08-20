# Nexora.Agent.Tests

The Windows-specific unit test project belongs here. The first portable agent
slice keeps identity, enrollment, heartbeat, inventory, and metrics services
separate so collectors and retry behavior can be tested without running the
Windows Service host.