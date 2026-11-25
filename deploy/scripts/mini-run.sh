#!/usr/bin/env bash
# mini-run.sh <cao> — start one relay on the mini (launchd). Keys are read from the
# per-CAO macOS user's login keychain into a private temp dir (0700, removed on exit).
# Keychain items (C1-FU-3), one login keychain per macOS user cao-relay-<cao>, created at failover setup
# with the SAME names as the Secure Vault labels (unchanged by the CAO rename; they name live secrets): cto-relay-<cao>-slack-app, cto-relay-<cao>-slack-bot,
# and (Muse only) cto-relay-muse for the brain key.
set -euo pipefail
cao="$1"
key_dir=$(mktemp -d); chmod 0700 "$key_dir"; trap 'rm -rf "$key_dir"' EXIT
umask 0277
security find-generic-password -s "cto-relay-$cao-slack-app" -w > "$key_dir/slack-app-token"
security find-generic-password -s "cto-relay-$cao-slack-bot" -w > "$key_dir/slack-bot-token"
if [ "$cao" = muse ]; then security find-generic-password -s "cto-relay-muse" -w > "$key_dir/brain-key"; fi
export CAO_RELAY_CAO="$cao" CAO_RELAY_KEY_DIR="$key_dir" CAO_RELAY_HOLDER=mini \
  CAO_RELAY_STATE_DIR="/var/lib/cao-relay/$cao" CAO_RELAY_RUN_DIR=/var/run/cao-relay \
  CAO_RELAY_HEALTH_BIND="${CAO_RELAY_MINI_HEALTH_BIND:-127.0.0.1}"
# shellcheck source=/dev/null
[ -f /etc/cao-relay/relay.env ] && set -a && . /etc/cao-relay/relay.env && set +a
node /opt/cao-relay/dist/index.js run
