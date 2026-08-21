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
