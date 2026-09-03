# Trusting the Nexora Internal Root CA on Windows

Nexora's HTTPS endpoint (`https://nexora.design.local`) is secured with a
certificate issued by a private internal Root CA (`Nexora Internal Root CA`),
not a public CA. Windows machines must explicitly trust this Root CA before
the browser or the Nexora Agent will accept the connection without warnings
or errors. **No certificate validation is bypassed anywhere in this
process** — this document establishes real trust, the way an organizational
CA normally would.

## What you need

The public Root CA certificate only: `nexora-root-ca.crt`. This file
contains no private key material and is safe to copy to client machines.

For the pilot, it is published at:

```text
/home/mustafa/Nexora/pilot/certificates/nexora-root-ca.crt
```

Copy this single file to the Windows pilot machine (e.g. via a file share,
USB, or scp/SFTP). **Never copy `nexora-root-ca.key`** — it does not leave
the Nexora server and is not present in this directory.

## Pilot: manual trust (single machine)

From an **elevated PowerShell** session on the Windows pilot machine, with
`nexora-root-ca.crt` in the current directory:

```powershell
Import-Certificate `
  -FilePath ".\nexora-root-ca.crt" `
  -CertStoreLocation "Cert:\LocalMachine\Root"
```

Verify it was imported:

```powershell
Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*Nexora*" }
```

You should see one certificate with:

```text
Subject: CN=Nexora Internal Root CA, O=Nexora, OU=Nexora IT Operations
```

After this, opening `https://nexora.design.local` in any browser on that
machine should show a normal, valid padlock with no certificate warning, and
the Nexora Agent (once installed) will be able to complete its normal .NET
TLS handshake against the API without any code-level certificate bypass.

## Bootstrap limitation: downloading the package itself

The Windows Agent pilot package (`nexora-agent-pilot.zip`, which contains
`nexora-root-ca.crt` among other files) is served from
`https://nexora.design.local/downloads/nexora-agent-pilot.zip` — over the
same HTTPS endpoint the Root CA is meant to protect. A brand-new Windows
machine that does not yet trust the Nexora Root CA will see a browser
certificate warning when it first visits Nexora to download that ZIP,
**before** it has a way to obtain the Root CA through Nexora itself. This is
an inherent chicken-and-egg problem with any self-hosted internal CA and is
not solved by weakening TLS.

Supported ways to bootstrap the first Pilot machine(s):

1. **Manual trusted transfer** (used for this Pilot): copy
   `pilot/certificates/nexora-root-ca.crt` directly from the Nexora server
   to the Windows pilot machine (USB drive, SFTP, or an admin file share)
   *before* visiting the download page, then `Import-Certificate` it as
   above. Once trusted, the same machine can browse to Nexora and download
   the full package without any warning.
2. **Active Directory Group Policy** (preferred for anything beyond a
   single pilot machine): pre-distribute the Root CA to all domain
   computers via GPO (see below) before anyone needs to download the Agent
   package — trust is then already established by the time IT visits
   Nexora.
3. **Existing corporate software distribution** (SCCM, Intune, etc.): push
   `nexora-root-ca.crt` through existing enterprise tooling ahead of time,
   the same way any other internal root certificate would be distributed.
4. **USB/admin transfer for the very first Pilot machine**: functionally
   the same as (1) — an administrator with direct access to the Nexora
   server carries the public certificate to the target machine.

None of these require, and none of them permit, disabling certificate
validation in a browser or in the Agent.

## Later: enterprise-wide deployment via Group Policy

This is **not** performed as part of this task — documented here for the
next phase. Once the pilot is validated, distribute the Root CA to all
domain-joined computers via:

```text
Active Directory Group Policy
→ Computer Configuration
→ Policies
→ Windows Settings
→ Security Settings
→ Public Key Policies
→ Trusted Root Certification Authorities
```

Import the same `nexora-root-ca.crt` there. GPO will then push trust to
every domain computer automatically, and the manual `Import-Certificate`
step above will no longer be necessary for new machines.

## Troubleshooting

- **"The underlying connection was closed: Could not establish trust
  relationship"** from the Agent, or a browser certificate warning: the
  Root CA was not imported into `Cert:\LocalMachine\Root` on that machine,
  or was imported into the wrong store (must be `LocalMachine\Root`, not
  `CurrentUser\Root`, for a Windows service running as `LocalSystem` to
  trust it).
- **DNS does not resolve `nexora.design.local`**: confirm the domain DNS
  server answers correctly (`nslookup nexora.design.local`); this is
  independent of certificate trust.
- Do not work around either issue by disabling certificate validation in
  the Agent or by accepting a browser "Proceed anyway" warning — both defeat
  the purpose of this setup and are explicitly out of scope for Nexora.
