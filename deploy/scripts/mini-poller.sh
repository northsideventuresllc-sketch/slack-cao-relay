#!/usr/bin/env bash
# mini-poller.sh — the 1-minute cron on the mini (PLAN-v7 D6). crontab of user cao-relay-muse:
#   * * * * * /opt/cao-relay/deploy/scripts/mini-poller.sh >> /var/log/cao-relay-poller.log 2>&1
# The cao-relay-muse brain key (and the Muse bot token, for the dead-owner fallback sweep)
# come from that user's login keychain and reach the poller on stdin only.
set -euo pipefail
brain=$(security find-generic-password -s "cto-relay-muse" -w)
bot=$(security find-generic-password -s "cto-relay-muse-slack-bot" -w 2>/dev/null || true)
# shellcheck source=/dev/null
[ -f /etc/cao-relay/relay.env ] && set -a && . /etc/cao-relay/relay.env && set +a
export CAO_RELAY_VM_LAN="${CAO_RELAY_VM_LAN:-198.19.0.2}"
# printf is a shell builtin: the values never appear on any process's argv.
if [ -n "$bot" ]; then
  printf '{"brainKey":"%s","slackBotToken":"%s"}' "$brain" "$bot" | node /opt/cao-relay/dist/index.js poller
else
  printf '{"brainKey":"%s"}' "$brain" | node /opt/cao-relay/dist/index.js poller
fi
