#!/usr/bin/env bash
# deploy.sh — install or update the relay on the VM. Run as root from a checkout
# of the commit being deployed:   sudo deploy/scripts/deploy.sh [--vault-token-stdin]
#
# - creates the four service users/groups + cao-relay-admin (idempotent)
# - installs the code at /opt/cao-relay (npm ci + build), units, tmpfiles, hooks
# - --vault-token-stdin: writes the vault-cli-machine token from STDIN to
#   /etc/cao-relay/vault-token (0400 root). Never pass it on argv.
# - prints the commit + config hash for cao-relay-expected.json (the vault file
#   the mini sync checks); every deploy must update that file.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
src="$(cd "$(dirname "$0")/../.." && pwd)"
CAOS="muse claude gemini axon"

# --- Retire the pre-rename cto-relay install (CTO -> CAO cutover; see docs/CAO-CUTOVER.md) -----
# Idempotent: does nothing when no cto-relay unit/dir exists. Stops and disables the old units,
# removes them and the old command wrappers, and moves the old state dirs to the new names so
# journals, queues and checkpoints carry over. Old system users are left in place (no data loss);
# remove them by hand after the cutover is verified: userdel cto-relay-<name>.
old_units="cto-heartbeat.timer cto-heartbeat.service cto-relay-offhost-copy.timer cto-relay-offhost-copy.service cto-relay-muse cto-relay-claude cto-relay-gemini cto-relay-axon-hermes"
for u in $old_units; do
  if systemctl list-unit-files "$u*" 2>/dev/null | grep -q "^$u"; then
    systemctl disable --now "$u" 2>/dev/null || true
  fi
done
for f in /etc/systemd/system/cto-heartbeat.service /etc/systemd/system/cto-heartbeat.timer \
         /etc/systemd/system/cto-relay-muse.service /etc/systemd/system/cto-relay-claude.service \
         /etc/systemd/system/cto-relay-gemini.service /etc/systemd/system/cto-relay-axon-hermes.service \
         /etc/systemd/system/cto-relay-offhost-copy.service /etc/systemd/system/cto-relay-offhost-copy.timer \
         /etc/sudoers.d/cto-relay /etc/tmpfiles.d/cto-relay.conf \
         /usr/local/bin/cto-relay /usr/local/bin/cto-relay-fetch-keys /usr/local/bin/cto-relay-offhost-copy.sh; do
  [ -e "$f" ] && rm -f "$f" && echo "removed old $f"
done
systemctl daemon-reload
# The AXON relay is named `axon` (it was `axon-hermes`): stop the old unit, retire its files, carry its state over.
systemctl disable --now cao-relay-axon-hermes 2>/dev/null || true
rm -f /etc/systemd/system/cao-relay-axon-hermes.service
if [ -d /var/lib/cao-relay/axon-hermes ] && [ ! -e /var/lib/cao-relay/axon ]; then mv /var/lib/cao-relay/axon-hermes /var/lib/cao-relay/axon && echo "moved axon-hermes state -> axon"; fi
if [ -d /var/lib/cto-relay ] && [ ! -e /var/lib/cao-relay ]; then mv /var/lib/cto-relay /var/lib/cao-relay && echo "moved /var/lib/cto-relay -> /var/lib/cao-relay"; fi
if [ -d /etc/cto-relay ] && [ ! -e /etc/cao-relay ]; then mv /etc/cto-relay /etc/cao-relay && echo "moved /etc/cto-relay -> /etc/cao-relay (edit CTO_RELAY_* to CAO_RELAY_* in relay.env; old names still work)"; fi
if [ -d /opt/cto-relay ]; then rm -rf /opt/cto-relay && echo "removed /opt/cto-relay"; fi
# ---------------------------------------------------------------------------------------------

getent group cao-relay-admin >/dev/null || groupadd --system cao-relay-admin
for c in $CAOS; do
  u="cao-relay-$c"
  getent group "$u" >/dev/null || groupadd --system "$u"
  id "$u" >/dev/null 2>&1 || useradd --system --gid "$u" --home-dir "/var/lib/cao-relay/$c" --no-create-home --shell /usr/sbin/nologin "$u"
done
# State moved from the old cto-relay-<name> owners: hand it to the new service users.
for c in $CAOS; do
  [ -d "/var/lib/cao-relay/$c" ] && chown -R "cao-relay-$c:cao-relay-$c" "/var/lib/cao-relay/$c"
done
# Every relay is independent (no broker, no Muse-held key): each service user reaches only the admin socket group.
for c in muse claude gemini axon; do usermod -a -G cao-relay-admin "cao-relay-$c"; done

install -d -m 0755 /etc/cao-relay
if [ "${1:-}" = "--vault-token-stdin" ]; then
  umask 0277
  cat > /etc/cao-relay/vault-token
  chown root:root /etc/cao-relay/vault-token
  chmod 0400 /etc/cao-relay/vault-token
  umask 0022
  echo "vault-token written (0400 root)"
fi
[ -f /etc/cao-relay/relay.env ] || install -m 0644 "$src/deploy/etc/relay.env.example" /etc/cao-relay/relay.env
[ -f /etc/cao-relay/fetch-keys.conf ] || install -m 0600 "$src/deploy/etc/fetch-keys.conf.example" /etc/cao-relay/fetch-keys.conf
[ -f /etc/cao-relay/offhost.env ] || install -m 0600 "$src/deploy/etc/offhost.env.example" /etc/cao-relay/offhost.env
# C2-FU-11: every config file the services read, any-case placeholders (<UPPER>, <lower>, <Mixed_Case>).
placeholder_files="/etc/cao-relay/relay.env /etc/cao-relay/fetch-keys.conf /etc/cao-relay/offhost.env $src/config/registry.json $src/deploy/sudoers/cao-relay"
if grep -n -E '<[A-Za-z][A-Za-z0-9_-]*>' $placeholder_files; then
  echo "WARNING: the lines above still hold <PLACEHOLDER> values — fill them before starting (runbook §2). The services refuse to start while they remain." >&2
fi

# Code
rsync -a --delete --exclude node_modules --exclude dist --exclude .git "$src/" /opt/cao-relay/
( cd /opt/cao-relay && npm ci --omit=dev --ignore-scripts && npm install --no-save typescript@7.0.2 @types/node@22 && npx tsc -p tsconfig.build.json && npm prune --omit=dev )
chown -R root:root /opt/cao-relay
install -m 0755 "$src/deploy/scripts/cao-relay-fetch-keys" /usr/local/bin/cao-relay-fetch-keys
install -m 0755 "$src/deploy/scripts/cao-relay-offhost-copy.sh" /usr/local/bin/cao-relay-offhost-copy.sh
# GitHub's SSH host keys for the vault deploy keys: pin them, then CHECK the fingerprints
# against GitHub's published list (docs.github.com, "GitHub's SSH key fingerprints") before use.
[ -f /etc/cao-relay/known_hosts ] || { ssh-keyscan -t ed25519,ecdsa,rsa github.com > /etc/cao-relay/known_hosts 2>/dev/null && chmod 0644 /etc/cao-relay/known_hosts && ssh-keygen -lf /etc/cao-relay/known_hosts; }
printf '#!/bin/sh\nexec /usr/bin/node /opt/cao-relay/dist/index.js "$@"\n' > /usr/local/bin/cao-relay && chmod 0755 /usr/local/bin/cao-relay

# Units + runtime dirs
install -m 0644 "$src/deploy/tmpfiles/cao-relay.conf" /etc/tmpfiles.d/cao-relay.conf
systemd-tmpfiles --create /etc/tmpfiles.d/cao-relay.conf
for f in "$src"/deploy/systemd/*.service "$src"/deploy/systemd/*.timer; do install -m 0644 "$f" /etc/systemd/system/; done
install -m 0440 "$src/deploy/sudoers/cao-relay" /etc/sudoers.d/cao-relay && visudo -cf /etc/sudoers.d/cao-relay
systemctl daemon-reload

commit=$(git -C "$src" rev-parse HEAD)
chash=$("$src/deploy/scripts/config-hash.sh" "$src")
echo
echo "Installed commit $commit, config hash $chash."
echo "Update the vault file cao-relay-expected.json to:"
printf '{ "commit": "%s", "configHash": "%s", "deployedAt": "%s" }\n' "$commit" "$chash" "$(date -u +%FT%TZ)"
echo "Then: systemctl enable --now cao-heartbeat.timer cao-relay-offhost-copy.timer cao-relay-muse cao-relay-claude cao-relay-gemini cao-relay-axon"
