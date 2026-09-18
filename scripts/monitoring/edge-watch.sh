#!/usr/bin/env bash
# Nexora EXTERNAL edge watcher (PR-06).
#
# MUST run on a host that is NOT the Nexora host. Its whole purpose is to
# notice a total Nexora outage — including the case where the Nexora host,
# its API and its notification-worker are all down and therefore cannot page
# anyone. It depends on nothing inside Nexora: just curl, date, and a
# notification command you supply.
#
# It checks the public endpoints, applies consecutive-failure logic, and on a
# state change calls NEXORA_WATCH_NOTIFY_CMD with a one-line message on stdin.
#
# Usage (typically from a systemd timer every 60s on the watcher host):
#   NEXORA_WATCH_URL=https://nexora.design.local \
#   NEXORA_WATCH_NOTIFY_CMD="/usr/local/bin/notify-oncall" \
#   scripts/monitoring/edge-watch.sh
#
# Env:
#   NEXORA_WATCH_URL         base URL (required), e.g. https://nexora.design.local
#   NEXORA_WATCH_NOTIFY_CMD  command run on state change; message on stdin
#                            (if unset, messages go to stdout only)
#   NEXORA_WATCH_STATE_DIR   default /var/lib/nexora-edge-watch
#   NEXORA_WATCH_WARN_FAILS  default 2
#   NEXORA_WATCH_CRIT_FAILS  default 3
#   NEXORA_WATCH_TIMEOUT     default 10 (seconds)
#   Install the public CA into the host trust store; TLS is always verified.

set -uo pipefail

URL="${NEXORA_WATCH_URL:?NEXORA_WATCH_URL is required}"
NOTIFY="${NEXORA_WATCH_NOTIFY_CMD:-}"
STATE_DIR="${NEXORA_WATCH_STATE_DIR:-/var/lib/nexora-edge-watch}"
WARN="${NEXORA_WATCH_WARN_FAILS:-2}"
CRIT="${NEXORA_WATCH_CRIT_FAILS:-3}"
TIMEOUT="${NEXORA_WATCH_TIMEOUT:-10}"
CURL_OPTS=(-s -m "$TIMEOUT" -o /dev/null)

mkdir -p "$STATE_DIR" 2>/dev/null || { echo 'CRITICAL: watcher state unavailable' >&2; exit 2; }
fails_file="$STATE_DIR/consecutive-failures"
state_file="$STATE_DIR/last-state"
prev_state="$(cat "$state_file" 2>/dev/null || echo HEALTHY)"
prev_fails="$(cat "$fails_file" 2>/dev/null || echo 0)"
[[ "$prev_fails" =~ ^[0-9]+$ ]] || { echo 'CRITICAL: invalid watcher state' >&2; exit 2; }

emit() { # <state> <message>
  local st="$1" msg="$2"
  echo "$st" > "$state_file" || { echo 'CRITICAL: watcher state unwritable' >&2; exit 2; }
  if [ "$st" != "$prev_state" ]; then
    local line
    line="[nexora-edge-watch] $(date -u +%FT%TZ) $prev_state -> $st : $msg"
    if [ -n "$NOTIFY" ]; then printf '%s\n' "$line" | "$NOTIFY" || echo "WARN: notify command failed" >&2
    else printf '%s\n' "$line"; fi
  fi
}

# Probe: DNS + TLS + connect + HTTP, distinguishing the failure kinds.
probe() { # <path> -> prints "code|curl_exit|kind"
  local path="$1" code ce
  code=$(curl "${CURL_OPTS[@]}" -w '%{http_code}' "$URL$path" 2>/dev/null); ce=$?
  local kind=ok
  case $ce in
    0) [ "$code" -ge 500 ] && kind="http_5xx"; [ "$code" = 000 ] && kind="no_response" ;;
    6) kind="dns_failure" ;;
    7) kind="connection_refused" ;;
    28) kind="timeout" ;;
    35|51|58|60|66|77|83) kind="tls_failure" ;;
    *) kind="curl_error_$ce" ;;
  esac
  [ "$ce" != 0 ] || [ "$code" -ge 400 ] || kind="ok"
  printf '%s|%s|%s' "$code" "$ce" "$kind"
}

root_r=$(probe "/")
api_r=$(probe "/api/healthz")
root_kind="${root_r##*|}"; api_kind="${api_r##*|}"
root_code="${root_r%%|*}"; api_code="${api_r%%|*}"

if [ "$root_kind" = ok ] && [ "$api_kind" = ok ]; then
  echo 0 > "$fails_file" || exit 2
  emit HEALTHY "root=$root_code healthz=$api_code"
  exit 0
fi

fails=$((prev_fails + 1)); echo "$fails" > "$fails_file" || exit 2
reason="root($root_code/$root_kind) healthz($api_code/$api_kind) consecutive=$fails"
if   [ "$fails" -ge "$CRIT" ]; then emit CRITICAL "$reason"; exit 2
elif [ "$fails" -ge "$WARN" ]; then emit WARNING  "$reason"; exit 1
else
  # first failure — do not page yet, but record
  echo "$prev_state" > "$state_file"
  echo "[nexora-edge-watch] transient failure 1/$WARN: $reason" >&2
  exit 1
fi
