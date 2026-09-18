#!/usr/bin/env bash
# PREPARED ONLY. Explicit root invocation on an independently approved staging host.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$here/staging-guard.sh"
[ "$#" -eq 2 ] || { echo 'usage: install-staging-monitoring.sh staging EXACT_HOSTNAME' >&2; exit 64; }
staging_guard "$1" "$2"
command -v sudo >/dev/null
sudo -n -l -U root >/dev/null 2>&1 || { echo 'Cannot verify sudo policy' >&2; exit 1; }
for account in nexora-monitor nexora-notify nexora-watch; do
  if getent passwd "$account" >/dev/null; then
    [ "$(id -u "$account")" -ne 0 ] && [ "$(id -g "$account")" -ne 0 ] && [ "$(id -Gn "$account")" = "$account" ] &&
      [ "$(getent passwd "$account" | cut -d: -f7)" = /usr/sbin/nologin ] || {
        echo 'Existing identity violates isolation; refusing to modify it' >&2; exit 1;
      }
  fi
done
for unit in "$here"/systemd/*.service "$here"/systemd/*.timer; do
  name=$(basename "$unit")
  ! systemctl is-active --quiet "$name" || { echo 'Unit already active; refusing' >&2; exit 1; }
  state=$(systemctl is-enabled "$name" 2>/dev/null || true)
  case "$state" in enabled*|linked*) echo 'Unit already enabled/linked; refusing' >&2; exit 1;; esac
  dest="/etc/systemd/system/$name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    [ -L "$dest" ] && [ "$(readlink "$dest")" = /dev/null ] || { echo 'Existing unit override: refusing' >&2; exit 1; }
  fi
done
# Reject symlinked installation ancestors before any filesystem mutation.
for path in /opt /opt/nexora-monitor /etc/nexora-monitor /etc/nexora-monitor/credentials /etc/nexora-notify /etc/nexora-notify/credentials /run/nexora-monitor /var/lib/nexora-monitor /var/lib/nexora-notify /var/lib/nexora-edge-watch /usr/local/lib/systemd/system; do
  [ ! -L "$path" ] || { echo 'Symlinked installation path: refusing' >&2; exit 1; }
done
for account in nexora-monitor nexora-notify nexora-watch; do
  getent group "$account" >/dev/null || groupadd --system "$account"
  getent passwd "$account" >/dev/null || useradd --system --gid "$account" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$account"
  if command -v sudo >/dev/null && sudo -n -l -U "$account" >/dev/null 2>&1; then
    echo 'Identity has sudo permissions; refusing' >&2; exit 1
  fi
done
install -d -o root -g root -m 0755 /opt/nexora-monitor /run/nexora-monitor /usr/local/lib/systemd/system
install -d -o root -g root -m 0755 /etc/nexora-monitor /etc/nexora-notify
install -d -o root -g root -m 0700 /etc/nexora-monitor/credentials /etc/nexora-notify/credentials
install -d -o nexora-monitor -g nexora-monitor -m 0700 /var/lib/nexora-monitor
install -d -o nexora-notify -g nexora-notify -m 0700 /var/lib/nexora-notify
install -d -o nexora-watch -g nexora-watch -m 0700 /var/lib/nexora-edge-watch
for file in platform-health.sh metadata.py publish-container-state.sh publish-backup-state.sh verify-backup.py notify-local.sh notify.py edge-watch.sh runtime-probe.sh; do
  install -o root -g root -m 0644 "$here/$file" "/opt/nexora-monitor/$file"
done
for unit in "$here"/systemd/*.service "$here"/systemd/*.timer; do
  name=$(basename "$unit")
  install -o root -g root -m 0644 "$unit" "/usr/local/lib/systemd/system/$name"
  [ -L "/etc/systemd/system/$name" ] || ln -s /dev/null "/etc/systemd/system/$name"
done
systemctl daemon-reload
echo 'Staging files prepared. All units masked; no timers enabled; no credentials created.'
