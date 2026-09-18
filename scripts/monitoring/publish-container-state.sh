#!/usr/bin/env bash
# Install root:root, non-writable by monitor. Never emit full inspect output.
set -euo pipefail
project="${NEXORA_MON_COMPOSE_PROJECT:?set explicit local/staging project}"
network="${NEXORA_MON_COMPOSE_NETWORK:?set explicit bridge network}"
[[ "$project" =~ ^[a-zA-Z0-9_-]+$ && "$network" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 64
output="${NEXORA_MON_CONTAINER_STATE:-/run/nexora-monitor/container-state.json}"
helper="$(dirname "${BASH_SOURCE[0]}")/metadata.py"
# A daemon error aborts publication, allowing the consumer's staleness guard
# to alert. A successful listing with an absent container means missing.
names=$(docker container ls -a --format '{{.Names}}')
{
  printf '['
  separator=''
  for service in api postgres maintenance notification-worker; do
    name="$project-$service-1"
    printf '%s' "$separator"; separator=,
    if ! grep -Fxq -- "$name" <<< "$names"; then
      printf '{"name":"%s","exists":false,"status":"missing","health":"none","restart_count":0,"postgres_addr":""}' "$name"
      continue
    fi
    address='""'
    if [ "$service" = postgres ]; then
      address="{{with index .NetworkSettings.Networks \"$network\"}}{{json .IPAddress}}{{else}}\"\"{{end}}"
    fi
    docker inspect --format "{\"name\":\"$name\",\"exists\":true,\"status\":{{json .State.Status}},\"health\":{{if .State.Health}}{{json .State.Health.Status}}{{else}}\"none\"{{end}},\"restart_count\":{{.RestartCount}},\"postgres_addr\":$address}" "$name"
  done
  printf ']\n'
} | python3 "$helper" publish "$output"
