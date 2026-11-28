#!/usr/bin/env bash
# mini-poller.sh — the 1-minute cron on the mini (PLAN-v7 D6). crontab of user cao-relay-muse:
#   * * * * * /opt/cao-relay/deploy/scripts/mini-poller.sh >> /var/log/cao-relay-poller.log 2>&1
# The shared brain key comes from that user's login keychain and reaches the poller on stdin only.
# The fallback sweep's Slack read token is not read here: the poller asks the doorman for it with the `muse` identity
# (keychain item nvg-doorman-identity, account muse; CAO_RELAY_DOORMAN_URL and SUPABASE_PUBLISHABLE_KEY come from relay.env).
set -euo pipefail
brain=$(security find-generic-password -s "cto-relay-muse" -w)
# shellcheck source=/dev/null
[ -f /etc/cao-relay/relay.env ] && set -a && . /etc/cao-relay/relay.env && set +a
export CAO_RELAY_VM_LAN="${CAO_RELAY_VM_LAN:-198.19.0.2}"
# printf is a shell builtin: the value never appears on any process's argv.
printf '{"brainKey":"%s"}' "$brain" | node /opt/cao-relay/dist/index.js poller
