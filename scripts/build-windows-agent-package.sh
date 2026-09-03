#!/usr/bin/env bash
# Builds the downloadable Windows Agent pilot package:
#   pilot/downloads/nexora-agent-pilot.zip
#   pilot/downloads/nexora-agent-pilot.zip.sha256
#   pilot/downloads/agent-manifest.json
#
# Idempotent: safe to re-run, always replaces the previous package atomically.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

AGENT_EXE_SRC="$REPO_ROOT/publish/windows-agent/out/nexora-agent.exe"
INSTALL_PS1_SRC="$REPO_ROOT/scripts/windows/install-agent.ps1"
UNINSTALL_PS1_SRC="$REPO_ROOT/scripts/windows/uninstall-agent.ps1"
ROOT_CA_SRC="$REPO_ROOT/pilot/certificates/nexora-root-ca.crt"
AGENT_CSPROJ="$REPO_ROOT/agent/Nexora.Agent/Nexora.Agent.csproj"

OUT_DIR="$REPO_ROOT/pilot/downloads"
ZIP_NAME="nexora-agent-pilot.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"
SHA_PATH="$ZIP_PATH.sha256"
MANIFEST_PATH="$OUT_DIR/agent-manifest.json"

echo "==> Verifying source artifacts"
missing=0
for f in "$AGENT_EXE_SRC" "$INSTALL_PS1_SRC" "$UNINSTALL_PS1_SRC" "$ROOT_CA_SRC"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: required source file missing: $f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "ERROR: cannot build package - one or more required source files are missing. Aborting." >&2
  exit 1
fi

# The verified publish artifact must be the self-contained single-file build, not the
# small intermediate build output. A self-contained win-x64 .NET 8 executable for this
# agent is tens of megabytes; the framework-dependent intermediate build is a few MB.
AGENT_EXE_SIZE=$(stat -c%s "$AGENT_EXE_SRC")
MIN_SELF_CONTAINED_BYTES=$((30 * 1024 * 1024))
if [ "$AGENT_EXE_SIZE" -lt "$MIN_SELF_CONTAINED_BYTES" ]; then
  echo "ERROR: $AGENT_EXE_SRC is only $AGENT_EXE_SIZE bytes - this does not look like the" >&2
  echo "       self-contained single-file publish artifact. Refusing to package it." >&2
  exit 1
fi

AGENT_VERSION=$(grep -oP '(?<=<Version>)[^<]+' "$AGENT_CSPROJ" | head -n1)
if [ -z "$AGENT_VERSION" ]; then
  echo "ERROR: could not determine Agent version from $AGENT_CSPROJ" >&2
  exit 1
fi
echo "    Agent version: $AGENT_VERSION"
echo "    Agent artifact: $AGENT_EXE_SRC ($AGENT_EXE_SIZE bytes)"

echo "==> Staging package contents"
STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

cp "$AGENT_EXE_SRC" "$STAGE_DIR/nexora-agent.exe"
cp "$INSTALL_PS1_SRC" "$STAGE_DIR/install-agent.ps1"
cp "$UNINSTALL_PS1_SRC" "$STAGE_DIR/uninstall-agent.ps1"
cp "$ROOT_CA_SRC" "$STAGE_DIR/nexora-root-ca.crt"

cat > "$STAGE_DIR/README.txt" <<EOF
Nexora Windows Agent
Version: $AGENT_VERSION
Architecture: Windows x64

1. Run PowerShell as Administrator.

2. Trust the Nexora Internal Root CA:

Import-Certificate \`
  -FilePath ".\nexora-root-ca.crt" \`
  -CertStoreLocation "Cert:\LocalMachine\Root"

3. Verify:

https://nexora.design.local

opens without a certificate warning.

4. Obtain a valid Enrollment Token from:
Nexora -> Administration -> Enrollment Tokens

5. Install:

.\install-agent.ps1 \`
  -ApiBaseUrl "https://nexora.design.local/api" \`
  -EnrollmentToken "<YOUR-ENROLLMENT-TOKEN>" \`
  -SourcePath "<PACKAGE-DIRECTORY>"

6. Verify:

Get-Service NexoraAgent

Integrity check (compare against the SHA-256 shown in Nexora Administration):

Get-FileHash .\nexora-agent-pilot.zip -Algorithm SHA256
Get-FileHash .\nexora-agent.exe -Algorithm SHA256
EOF

echo "==> Scanning staged files for prohibited secret/private-key patterns"
# Belt-and-suspenders check: even though only known-safe files are staged above,
# fail closed if anything resembling key material or a credential ever ends up here.
FORBIDDEN_PATTERN='BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY|nexora-root-ca\.key|nexora\.design\.local\.key|ADMIN_API_TOKEN=|JWT_SECRET=|ENROLLMENT_SECRET=|POSTGRES_PASSWORD=|DATABASE_URL=.*:.*@'
if grep -RIlE "$FORBIDDEN_PATTERN" "$STAGE_DIR" 2>/dev/null; then
  echo "ERROR: prohibited secret/private-key pattern found in staged package contents. Aborting." >&2
  exit 1
fi
if find "$STAGE_DIR" -iname '*.key' -o -iname '.env' -o -iname '.env.*' | grep -q .; then
  echo "ERROR: prohibited file (.key or .env) found in staged package contents. Aborting." >&2
  exit 1
fi

echo "==> Building ZIP"
mkdir -p "$OUT_DIR"
TMP_ZIP="$ZIP_PATH.tmp.$$"
python3 - "$STAGE_DIR" "$TMP_ZIP" <<'PYEOF'
import os
import sys
import zipfile

stage_dir, zip_path = sys.argv[1], sys.argv[2]
files = sorted(os.listdir(stage_dir))
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for name in files:
        zf.write(os.path.join(stage_dir, name), arcname=name)
PYEOF
mv -f "$TMP_ZIP" "$ZIP_PATH"

echo "==> Verifying ZIP contents (expect exactly 5 flat entries)"
ACTUAL_ENTRIES=$(python3 -c "import zipfile,sys; print('\n'.join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))" "$ZIP_PATH")
EXPECTED_ENTRIES=$'README.txt\ninstall-agent.ps1\nnexora-agent.exe\nnexora-root-ca.crt\nuninstall-agent.ps1'
if [ "$ACTUAL_ENTRIES" != "$EXPECTED_ENTRIES" ]; then
  echo "ERROR: unexpected ZIP contents:" >&2
  echo "$ACTUAL_ENTRIES" >&2
  rm -f "$ZIP_PATH"
  exit 1
fi

echo "==> Computing checksums"
ZIP_SHA256=$(sha256sum "$ZIP_PATH" | awk '{print $1}')
AGENT_SHA256=$(sha256sum "$AGENT_EXE_SRC" | awk '{print $1}')
ZIP_SIZE=$(stat -c%s "$ZIP_PATH")
echo "$ZIP_SHA256  $ZIP_NAME" > "$SHA_PATH.tmp.$$"
mv -f "$SHA_PATH.tmp.$$" "$SHA_PATH"

PUBLISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$MANIFEST_PATH.tmp.$$" <<EOF
{
  "product": "Nexora Windows Agent",
  "version": "$AGENT_VERSION",
  "architecture": "win-x64",
  "package": "$ZIP_NAME",
  "packageSha256": "$ZIP_SHA256",
  "agentSha256": "$AGENT_SHA256",
  "packageSizeBytes": $ZIP_SIZE,
  "publishedAt": "$PUBLISHED_AT"
}
EOF
mv -f "$MANIFEST_PATH.tmp.$$" "$MANIFEST_PATH"

echo "==> Done"
echo "    Package:  $ZIP_PATH ($ZIP_SIZE bytes)"
echo "    Checksum: $SHA_PATH"
echo "    Manifest: $MANIFEST_PATH"
echo "    ZIP SHA-256:   $ZIP_SHA256"
echo "    Agent SHA-256: $AGENT_SHA256"
