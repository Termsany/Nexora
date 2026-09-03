# Software Inventory and Change Tracking

## Windows collection

Agent 0.2.0 reads the machine-wide uninstall registry through both `RegistryView.Registry64` and `RegistryView.Registry32`. These correspond to the native x64 and WOW6432 uninstall views beneath `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`.

`Win32_Product` is never queried because it is slow and can trigger Windows Installer consistency checks or repair actions. HKCU entries are not collected in V1: a Windows Service runs outside interactive user registry contexts, so an HKCU scan would be incomplete and misleading.

Entries without `DisplayName` are discarded. Windows updates, runtimes, drivers, redistributables and browser components are otherwise retained. Registry `SystemComponent` is preserved so operators can filter or interpret these entries without losing useful data. Nexora sends uninstall-command presence only, never the uninstall command itself.

Collected metadata is limited to display name/version, publisher, Windows install date when parseable, install location, product-code-shaped registry identifier, architecture, source, system-component status and uninstall availability. It does not include product keys, licenses, credentials, application data or user documents.

## Identity

The canonical identity is lowercase hexadecimal SHA-256 of:

```text
normalize(publisher) + "|" + normalize(display_name) + "|" + architecture
```

Normalization trims, lowercases invariantly and collapses whitespace. Version is excluded, allowing an update to remain the same application. Architecture is included to avoid merging parallel x86/x64 installations. Publisher prevents similarly named applications from unrelated vendors being merged. Product code is metadata rather than identity because MSI product codes can change with versions.

The backend recalculates identity rather than trusting the agent-supplied value.

## Snapshot semantics

Software is an optional section of the existing authenticated inventory payload. Agent 0.1.0 payloads remain valid. Agent 0.2.0 sends `complete`, `collected_at`, a sanitized failure code and up to 5,000 entries.

Only `complete=true` snapshots reconcile state. Collection failures or partial snapshots cannot establish a baseline, update presence or mark software removed. Database work locks the device and executes in one transaction; a failure rolls back all inventory and change records.

The first complete snapshot for every device establishes a baseline. Applications are stored as present without generating misleading `INSTALLED` events. Subsequent snapshots produce:

- New or previously removed identity: `INSTALLED`
- Same identity with a different nullable version: `VERSION_CHANGED`
- Previously present identity absent from a complete snapshot: `REMOVED`
- Same identity and version: `last_seen_at` only

Repeated snapshots and agent retries are idempotent. Windows `install_date` remains distinct from Nexora `observed_at`, `first_seen_at` and `last_seen_at`.

## Schedule and failure behavior

Inventory runs immediately after enrollment/service startup, then every six hours plus up to ten minutes of jitter. Heartbeat and metrics remain independent 30-second loops. A registry failure produces an incomplete snapshot and does not terminate the inventory, heartbeat or metrics workers.

The API and nginx accept at most 4 MB per request, while validation limits software to 5,000 entries. Logs contain device ID, count, duration and change totals, never complete software lists.

## Database

Migration `0006_puzzling_human_robot.sql` adds:

- `nexora_device_software`, unique by device and identity, with present/removed state and observation timestamps.
- `nexora_software_changes`, containing installed, removed and version-change observations.
- `nexora_devices.software_inventory_initialized_at`, the baseline marker.

Indexes cover device/presence/name, fleet identity/presence/time, normalized name, publisher and device/identity change history. Current inventory follows device lifetime through cascade deletion. The maintenance worker retains change history for 365 days and never retention-deletes current inventory.

## APIs and UI

Administrative bearer authorization protects:

```text
GET /api/v1/devices/:device_id/software
GET /api/v1/devices/:device_id/software/changes
GET /api/v1/software
GET /api/v1/software/:software_identity/devices
```

Device inventory supports pagination, search, publisher, architecture, version, presence and sorting. Change history is paginated and filterable by change type. Fleet inventory is server-aggregated with endpoint counts and version distributions; application detail returns paginated endpoints.

Device Details includes Software inventory and change history. The global Software page provides application search, distribution and endpoint drill-down. The UI uses the administrative token held only in browser session storage after it is entered in Administration.

## Scale

At 100-300 applications per device, expected current rows are 10,000-30,000 for 100 endpoints and 50,000-150,000 for 500 endpoints. Six-hour scheduling plus jitter spreads uploads. Database and UI queries are indexed and paginated; the frontend never downloads the entire fleet inventory.

## Pilot upgrade

1. Download the Agent 0.2.0 ZIP from Administration and verify both displayed SHA-256 values.
2. Extract it on DEPLOY and run PowerShell as Administrator.
3. Stop `NexoraAgent` and run `install-agent.ps1` with the existing API URL. The installer replaces the binary while preserving `%ProgramData%\Nexora\device-id` and encrypted credentials.
4. Start the service and confirm the same device/agent ID reports version 0.2.0.
5. Confirm heartbeat, metrics, hardware inventory and the first software baseline.

Do not re-enroll or delete ProgramData during an upgrade. Real install/remove testing requires an operator-approved disposable application.

## Testing and limitations

Agent unit tests use an abstract registry reader and cover native/WOW6432 views, missing data, duplicate representations, identity normalization and collection failure without requiring a live registry. Disposable PostgreSQL tests cover baseline, idempotency, install, removal, version change, incomplete snapshots and isolation.

V1 does not collect per-user HKCU software, determine authoritative latest versions, label software vulnerable/outdated, or perform patching/install/uninstall actions. Registry metadata quality depends on each installer. Identity may keep separately branded editions together only when publisher, display name and architecture are all identical.
