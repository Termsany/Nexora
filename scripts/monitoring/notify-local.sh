#!/usr/bin/env bash
# Independent notifier; credential data never enters process arguments.
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/notify.py"
