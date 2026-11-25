#!/usr/bin/env bash
# mini-checkin.sh — Claude CAO's 9am check-in report (R7-NEW-5 dead-alerter fallback).
# Run on the mini as cao-relay-muse (directly, or over SSH: ssh <MINI_SSH_DEST> /opt/cao-relay/deploy/scripts/mini-checkin.sh).
# Shows Muse CAO's and the poller's heartbeat ages and every unread alert in
# /var/lib/cao-relay/mini/alerts.jsonl. The brain key reaches node on stdin only.
set -euo pipefail
brain=$(security find-generic-password -s "cao-relay-muse" -w)
# shellcheck source=/dev/null
[ -f /etc/cao-relay/relay.env ] && set -a && . /etc/cao-relay/relay.env && set +a
printf '{"brainKey":"%s"}' "$brain" | node /opt/cao-relay/dist/index.js checkin-report
