#!/usr/bin/env bash
# mini-run.sh <cao> — start one relay on the mini (launchd), run as the per-CAO macOS user cao-relay-<cao>.
# Slack tokens are NOT read or copied here: the relay asks the doorman for them with its own identity token, which it reads
# itself from this user's login keychain (item nvg-doorman-identity, account = the identity: muse, claude_code,
# gemini_antigravity, hermes). The one thing this wrapper reads is the shared NI Brain key (keychain item cto-relay-muse, a
# live secret label kept as is, rule 20.8) into a private tmpfs-style temp dir (0700, removed on exit) for all four relays.
# CAO_RELAY_DOORMAN_URL and SUPABASE_PUBLISHABLE_KEY (not secret) come from /etc/cao-relay/relay.env.
set -euo pipefail
cao="$1"
case "$cao" in muse|claude|gemini|axon) ;; *) echo "mini-run.sh: unknown relay $cao" >&2; exit 64 ;; esac
key_dir=$(mktemp -d); chmod 0700 "$key_dir"; trap 'rm -rf "$key_dir"' EXIT
umask 0277
security find-generic-password -s "cto-relay-muse" -w > "$key_dir/brain-key"
export CAO_RELAY_CAO="$cao" CAO_RELAY_KEY_DIR="$key_dir" CAO_RELAY_HOLDER=mini \
  CAO_RELAY_STATE_DIR="/var/lib/cao-relay/$cao" CAO_RELAY_RUN_DIR=/var/run/cao-relay \
  CAO_RELAY_HEALTH_BIND="${CAO_RELAY_MINI_HEALTH_BIND:-127.0.0.1}"
# shellcheck source=/dev/null
[ -f /etc/cao-relay/relay.env ] && set -a && . /etc/cao-relay/relay.env && set +a
: "${CAO_RELAY_DOORMAN_URL:=${NVG_DOORMAN_URL:-}}"
: "${CAO_RELAY_DOORMAN_URL:?CAO_RELAY_DOORMAN_URL (or NVG_DOORMAN_URL) is not set in /etc/cao-relay/relay.env}"
: "${SUPABASE_PUBLISHABLE_KEY:?SUPABASE_PUBLISHABLE_KEY is not set in /etc/cao-relay/relay.env}"
export CAO_RELAY_DOORMAN_URL SUPABASE_PUBLISHABLE_KEY
node /opt/cao-relay/dist/index.js run
