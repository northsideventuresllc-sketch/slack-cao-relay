#!/usr/bin/env bash
# cao-relay-mini-sync.sh — the CHECKED failover step (PLAN-v7 D6). Owner: Muse CAO
# (Claude CAO when Muse CAO is offline). Run on the mini.
#
#   cao-relay-mini-sync.sh            verify only: prints PROCEED or ABORT
#   cao-relay-mini-sync.sh --start    verify, then start the four mini relays
#   cao-relay-mini-sync.sh --retire-old  stop + remove the old com.northside.cto-relay.* launchd units (CTO -> CAO cutover)
#   cao-relay-mini-sync.sh --nightly  nightly pull (fast-forward to origin/main) + verify, no start
#
# Verification: the mini's repo commit + config hash must equal the expected
# commit + config hash in the vault file cao-relay-expected.json (updated by
# every deploy). If the mini is behind (or different), ABORT the failover and alert.
set -euo pipefail
REPO="${CAO_RELAY_MINI_REPO:-/opt/cao-relay}"
VAULT_DIR="${CAO_RELAY_MINI_VAULT_DIR:-<MINI_VAULT_CHECKOUT_DIR>}"
EXPECTED_REL="${CAO_RELAY_EXPECTED_PATH:-<VAULT_PATH_TO>/cao-relay-expected.json}"
ALERTS=/var/lib/cao-relay/mini/alerts.jsonl
mode="${1:-verify}"

alert() { # capped (R7-NEW-5): rotate past 1 MiB by rename, keep 3; read by Claude CAO's check-in report
  mkdir -p "$(dirname "$ALERTS")"
  if [ -f "$ALERTS" ] && [ "$(wc -c < "$ALERTS")" -gt 1048576 ]; then
    rm -f "$ALERTS.3"; [ -f "$ALERTS.2" ] && mv "$ALERTS.2" "$ALERTS.3"; [ -f "$ALERTS.1" ] && mv "$ALERTS.1" "$ALERTS.2"; mv "$ALERTS" "$ALERTS.1"
  fi
  printf '{"at":"%s","code":"%s","detail":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$ALERTS"
  echo "ABORT: $1 ($2)" >&2
}

if [ "$mode" = "--retire-old" ]; then
  # Idempotent. Leaves the old macOS users and /var/lib/cto-relay data in place (state is moved, not deleted).
  for c in muse claude gemini axon-hermes; do
    old="/Library/LaunchDaemons/com.northside.cto-relay.$c.plist"
    sudo launchctl bootout "system/com.northside.cto-relay.$c" 2>/dev/null || true
    [ -e "$old" ] && sudo rm -f "$old" && echo "removed $old"
  done
  if [ -d /var/lib/cto-relay ] && [ ! -e /var/lib/cao-relay ]; then sudo mv /var/lib/cto-relay /var/lib/cao-relay && echo "moved /var/lib/cto-relay -> /var/lib/cao-relay"; fi
  echo "Old cto-relay launchd units retired. Install the new ones: copy deploy/launchd/com.northside.cao-relay.CAO.plist.template to /Library/LaunchDaemons/com.northside.cao-relay.<key>.plist (replace CAO_KEY)."
  exit 0
fi

case "$VAULT_DIR$EXPECTED_REL" in *"<"*) alert mini-sync-not-configured "set CAO_RELAY_MINI_VAULT_DIR and CAO_RELAY_EXPECTED_PATH"; exit 2 ;; esac

git -C "$VAULT_DIR" fetch --quiet origin main || { alert vault-fetch-failed "$VAULT_DIR"; exit 2; }
expected_json=$(git -C "$VAULT_DIR" show "origin/main:$EXPECTED_REL") || { alert expected-file-missing "$EXPECTED_REL"; exit 2; }
exp_commit=$(printf '%s' "$expected_json" | sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p')
exp_hash=$(printf '%s' "$expected_json" | sed -n 's/.*"configHash"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p')
[ -n "$exp_commit" ] && [ -n "$exp_hash" ] || { alert expected-file-bad "$EXPECTED_REL"; exit 2; }

if [ "$mode" = "--nightly" ]; then
  git -C "$REPO" fetch --quiet origin main && git -C "$REPO" merge --ff-only --quiet origin/main || alert nightly-pull-failed "$REPO"
fi

mini_commit=$(git -C "$REPO" rev-parse HEAD)
mini_hash=$("$REPO/deploy/scripts/config-hash.sh" "$REPO")
if [ "$mini_commit" != "$exp_commit" ] || [ "$mini_hash" != "$exp_hash" ]; then
  alert mini-behind-expected "mini $mini_commit/$mini_hash expected $exp_commit/$exp_hash"
  exit 1
fi

# The off-host journal copies must be present for each CAO (takeover reads them).
for c in muse claude gemini axon-hermes; do
  d="/var/lib/cao-relay/$c"
  if [ -f "$d/journal.jsonl.sha256" ]; then
    ( cd "$d" && { sha256sum -c journal.jsonl.sha256 >/dev/null 2>&1 || shasum -a 256 -c journal.jsonl.sha256 >/dev/null; } ) || { alert offhost-copy-checksum-bad "$c"; exit 1; }
  else
    alert offhost-copy-missing "$c"; exit 1
  fi
done

echo "PROCEED: mini at expected commit $mini_commit, config hash $mini_hash"
if [ "$mode" = "--start" ]; then
  for c in muse claude gemini axon-hermes; do
    sudo launchctl bootstrap system "/Library/LaunchDaemons/com.northside.cao-relay.$c.plist" 2>/dev/null || sudo launchctl kickstart -k "system/com.northside.cao-relay.$c"
  done
  echo "Mini relays started. Each acquires its lease with epoch+1 once the VM lease has expired (90 s)."
fi
