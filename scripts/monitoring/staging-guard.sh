#!/usr/bin/env bash
# Sourced only by explicit staging operator entrypoints. No bypass flag.
staging_guard() {
  [ "$EUID" -eq 0 ] || { echo 'Root operator required' >&2; return 1; }
  [ "${1:-}" = staging ] && [ "${2:-}" = "$(hostname)" ] || {
    echo 'Explicit staging environment and exact hostname required' >&2; return 1;
  }
  case "$(hostname) ${NEXORA_ENV:-} ${NODE_ENV:-}" in
    *[Pp][Rr][Oo][Dd]*) echo 'Production indicator: refusing' >&2; return 1;;
  esac
  local marker=/etc/nexora-staging-host
  [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -c '%u:%a' "$marker")" = 0:600 ] &&
    [ "$(cat "$marker")" = "$(hostname)" ] || {
      echo 'Operator-created root:root 0600 staging-host marker required' >&2; return 1;
    }
  if [ -e /etc/nexora/environment ] && grep -qi production /etc/nexora/environment; then
    echo 'Production environment marker: refusing' >&2; return 1
  fi
  local names
  names=$(docker ps -a --format '{{.Names}}') || return 1
  if grep -Eq '^nexora-(postgres|api|web)-1$' <<< "$names"; then
    echo 'Production container identity found: refusing' >&2; return 1
  fi
}
