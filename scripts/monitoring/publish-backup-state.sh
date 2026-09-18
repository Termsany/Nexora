#!/usr/bin/env bash
# Run as the privileged backup verifier, not as nexora-monitor.
# Input is ONLY a freshly verified four-field record, never backup-state.json
# from the existing backup job (which includes artifact locations/checksums).
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/metadata.py" publish-backup \
  "${NEXORA_MON_BACKUP_STATE:-/run/nexora-monitor/backup-state.json}"
