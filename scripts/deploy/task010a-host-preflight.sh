#!/usr/bin/env bash
set -euo pipefail
host="${NEXORA_HOSTNAME:-nexora.design.local}"
url="https://${host}/api/healthz"
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
command -v getent >/dev/null && getent hosts "$host" || true
timeout 3 bash -c "</dev/tcp/${host}/443" 2>/dev/null || { echo "TCP 443 is not reachable" >&2; exit 1; }
body=$(curl --fail --silent --show-error --max-time 15 --tlsv1.2 "$url")
grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body" || { echo "unexpected health response" >&2; exit 1; }
loopback=$(curl --fail --silent --show-error --max-time 15 --tlsv1.2 --resolve "${host}:443:127.0.0.1" "$url")
grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$loopback" || { echo "unexpected loopback response" >&2; exit 1; }
headers=$(curl --fail --silent --show-error --head --max-time 15 --tlsv1.2 "$url")
grep -qi '^strict-transport-security:' <<<"$headers" || { echo "HSTS header missing" >&2; exit 1; }
printf 'HTTPS preflight PASS: %s (hostname and loopback TLS verified)\n' "$url"
