#!/usr/bin/env bash
# Nexora PRODUCTION self-monitoring installer. PREPARED, NOT YET RUN.
#
# Fails closed: requires root, verified production identity, AND an explicit
# operator approval phrase. Installs every unit MASKED and enables NO timer -
# activation is a separate, deliberate operator step after validation.
#
# It never restarts a Production container, never runs an application
# migration, never touches customer tables, and never writes a secret value.
#
#   sudo NEXORA_PRODUCTION_DEPLOY_APPROVED='I UNDERSTAND THIS DEPLOYS MONITORING TO PRODUCTION' \
#     bash scripts/monitoring/install-production-monitoring.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$here/production-guard.sh"
production_guard
production_deploy_approved "monitoring installation"

# --- refuse to modify an identity we did not create -------------------------
for a in nexora-monitor nexora-notify; do
  if getent passwd "$a" >/dev/null; then
    [ "$(id -u "$a")" -ne 0 ] && [ "$(id -Gn "$a")" = "$a" ] &&
      [ "$(getent passwd "$a" | cut -d: -f7)" = /usr/sbin/nologin ] ||
      { echo "Existing identity '$a' violates isolation; refusing to modify it" >&2; exit 1; }
    id -nG "$a" | tr ' ' '\n' | grep -qx docker &&
      { echo "Identity '$a' is in the docker group; refusing" >&2; exit 1; }
  fi
done

# --- refuse to clobber an existing/active unit ------------------------------
for unit in "$here"/systemd/*.service "$here"/systemd/*.timer; do
  n=$(basename "$unit")
  ! systemctl is-active --quiet "$n" || { echo "Unit $n already active; refusing" >&2; exit 1; }
  case "$(systemctl is-enabled "$n" 2>/dev/null || true)" in
    enabled*|linked*) echo "Unit $n already enabled; refusing" >&2; exit 1 ;;
  esac
done
for p in /opt/nexora-monitor /etc/nexora-monitor /etc/nexora-monitor/credentials \
         /etc/nexora-notify /etc/nexora-notify/credentials /run/nexora-monitor \
         /var/lib/nexora-monitor /var/log/nexora-monitor; do
  [ ! -L "$p" ] || { echo "Symlinked installation path $p; refusing" >&2; exit 1; }
done

# --- P2: OS identity + directories (additive only) --------------------------
for a in nexora-monitor nexora-notify; do
  getent group "$a" >/dev/null || groupadd --system "$a"
  getent passwd "$a" >/dev/null || useradd --system --gid "$a" --home-dir /nonexistent \
    --no-create-home --shell /usr/sbin/nologin "$a"
done
install -d -o root -g root -m 0755 /opt/nexora-monitor /etc/nexora-monitor /etc/nexora-notify /run/nexora-monitor
install -d -o root -g root -m 0700 /etc/nexora-monitor/credentials /etc/nexora-notify/credentials
install -d -o nexora-monitor -g nexora-monitor -m 0700 /var/lib/nexora-monitor /var/log/nexora-monitor

# --- P6: monitoring scripts (no secrets; root-owned, monitor-readable) ------
for f in platform-health.sh metadata.py notify-local.sh notify.py \
         publish-container-state.sh publish-backup-state.sh; do
  install -o root -g root -m 0755 "$here/$f" "/opt/nexora-monitor/$f"
done

# --- P7: units installed MASKED, timers NOT enabled -------------------------
for unit in "$here"/systemd/*.service "$here"/systemd/*.timer; do
  install -o root -g root -m 0644 "$unit" "/usr/local/lib/systemd/system/$(basename "$unit")" 2>/dev/null ||
  install -D -o root -g root -m 0644 "$unit" "/usr/local/lib/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload
for unit in "$here"/systemd/*.service "$here"/systemd/*.timer; do
  systemctl mask "$(basename "$unit")"
done

cat <<'DONE'

Installed. Every unit is MASKED and no timer is enabled - nothing runs yet.

Still required, each as a separate deliberate step:
  * /etc/nexora-monitor/monitor.conf and publisher.conf   (non-secret config)
  * /etc/nexora-monitor/credentials/pgpass                (root:root 0600)
  * /etc/nexora-notify/credentials/webhook                (root:root 0600, optional)
  * the production monitoring DB objects (see P3)
  * bash scripts/monitoring/validate-production-monitoring.sh
  * one manual masked-unit run, then gradual timer enablement

DONE
