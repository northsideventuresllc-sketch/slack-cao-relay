# CAO cutover runbook (CTO names to CAO names)

JB approved 2026-11-25: switch the live Slack relay from CTO to CAO names (channels, bot names, settings). This is the ordered runbook. The code on this branch is backward compatible; nothing here has been run.

## What was found live (read-only checks, 2026-11-25)

**Slack** (workspace the agent's Slack connector sees):

| Channel | ID | State |
|---|---|---|
| `#cao-bots` | C0CKKGVF4P5 | exists, public, created 2026-11-20 |
| `#cao-muse` | C0CKACGNP2T | exists, public |
| `#cao-claude` | C0CKVEVM1QU | exists, public |
| `#cao-gemini` | C0CKTLCEJ49 | exists, public |
| `#cao-axon` | C0CKTLCH49X | exists, public |

No `#cto-*` channel exists, active or archived. So there is nothing to rename or create in Slack. `config/registry.json` now carries these IDs. The registry's old `ctoBotsChannelId` (C0CEU7SMCHE) is not one of them. The connector could not resolve the four bot user IDs in the registry (`user_not_found`), so it cannot confirm today's bot display names or channel membership of the relay bots.

**NI Brain** (`uaztknnipdxxptrmlxlb`, schema `public`):
- `cto_relay_lease` and `cto_heartbeat` exist as base tables, both empty. `cao_relay_lease` and `cao_heartbeat` do not exist. RLS on, no policies.
- `agent_comms` has 15 columns; triggers `trg_agent_comms_guard_insert`, `_guard_transition`, `_wake`. Old names in use: `Claude CTO` (51 from, 231 to), `AXON-Hermes CTO` (9 from, 68 to), `Gemini CTO` (2 to), `MUSE CTO` (17 to). `Claude CAO` appears once as `from_agent`. `CTO Monitor` (270 from) is a separate monitor agent and is left alone.
- Functions that matter: `fn_comms_canonical_agent` accepts only names found in `nvg_routine_state.agent_name`. That table holds `Claude CTO`, `Gemini CTO`, `AXON-Hermes CTO`, `MUSE CTO`, `MUSE`, and no CAO names. Until the migration renames them, `comms_send` to `Claude CAO` fails with "unknown agent name". The migration handles this.
- Muse stays `MUSE` (the registry's agentName, no CTO in it). The old `MUSE CTO` is read as `MUSE`.

**Where it runs.** Primary: a VM, systemd units `cto-relay-{muse,claude,gemini,axon-hermes}.service`, `cto-heartbeat.timer`, `cto-relay-offhost-copy.timer`, code in `/opt/cto-relay`, config in `/etc/cto-relay`, state in `/var/lib/cto-relay`. Failover and poller: the Mac mini, launchd `com.northside.cto-relay.<cao>` (not loaded at boot) plus a 1-minute poller cron. Config: non-secret settings in `relay.env` (`CTO_RELAY_*`); secrets are fetched from the Secure Vault into tmpfs at each start, never in a file.

**Deliberately not renamed:** the Secure Vault labels and mini keychain item names (`cto-relay-muse`, `cto-relay-<cao>-slack-app`, `-slack-bot`, `cto-relay-vault-read`, `-write`). They name live secrets; renaming a secret is a separate change under rules 20.8 (new value, prove, then revoke old). The deploy keys on GitHub keep those labels too.

## Compatibility built into this branch

- `CAO_RELAY_*` is read first; `CTO_RELAY_*` fills any gap (`CTO_RELAY_CTO` maps to `CAO_RELAY_CAO`). See `src/legacy.ts`.
- New rows are written with CAO names. Reads accept old names: brain queries use `to_agent in ("Claude CAO","Claude CTO")`, the broker maps old names to new.
- Migration `0002_cao_rename.sql` leaves views named `cto_relay_lease` and `cto_heartbeat`, so the OLD build keeps working after the migration until step 5 stops it.
- The NEW build needs `cao_relay_lease` / `cao_heartbeat`, so the migration must be applied before the new code starts. Order matters.
- Remove `src/legacy.ts` and the views after the cutover is verified.

## Who can do what (honest)

- **Slack MCP** (agent): search channels, read channels and members, send a message. It cannot create bot apps, rename apps or bots, or change app settings. It has no admin rights.
- **Supabase MCP** (agent): read-only SELECTs work. `apply_migration` / `execute_sql` writes may raise a confirmation pop-up to JB. If the pop-up cannot reach JB, rules 20.11 allows the saved-key route (pg_net from inside the database), only for SQL the council gate scored 95 or higher.
- **VM and mini shell**: no tool in this run reaches either. Needs the Mini Connector or Tailscale (agent), or JB at a terminal.
- **JB-only**: Slack admin login (app display names), and anything that needs a secret value JB's own login must change.

## Steps

### 0. Before anything (WHO: JB + agent)
1. Review the branch `claude/hopeful-pasteur-lsy4kt`; merge through `scripts/nvg-merge-deploy.mjs`-style approval (JB). No PR was opened by this run.
2. Council gate on the exact SQL of `supabase/migrations/0002_cao_rename.sql`: must score 95 or higher for the 20.11 route. (agent)
3. Pick a quiet time: both tables are empty and no live relay row was seen, but confirm in step 1.

### 1. Slack (WHO as marked)
1. **Channels.** All five `#cao-*` channels already exist; no `#cto-*` exists. Nothing to rename. (agent-via-Slack-MCP: confirmed by search.)
2. **Membership.** Check the four relay bots are members of their channels and of `#cao-bots`: `slack_list_channel_members` on each ID. (agent-via-Slack-MCP). Invite any missing bot. (JB-only if the invite needs admin; otherwise `/invite @bot`.)
3. **Bot display names.** Set each Slack app's display name to `Muse CAO` (app A0CEU4GCVPS), `Claude CAO` (A0CDTGZHW2X), `Gemini CAO` (A0CDZJJF2FL), `AXON-Hermes CAO` (A0CDXR7766A): api.slack.com/apps, each app, App Home, Display Name, and the app name under Basic Information. (JB-only: Slack admin login. No agent tool can do this.)
4. Do not post test messages yet.

### 2. Apply the migration (WHO: agent-via-Supabase, gated)
1. Re-run the dependency checks (SELECT only): the four tables, the agent names in `agent_comms` and `nvg_routine_state`. (agent-via-Supabase)
2. Apply `supabase/migrations/0002_cao_rename.sql` through the saved-key route, rules 20.11: SQL is already wrapped in begin/commit; never print or copy a key. Record the request id and result in the run's Build Plan Executions row. (agent-via-Supabase)
3. Run the verify queries at the bottom of the file. Expect `cao_*` base tables with RLS on, `cto_*` views, zero old names left in `agent_comms`. (agent-via-Supabase)
4. The OLD relay build, if running, now reads the views and keeps working.

### 3. VM: install the new build (WHO: agent-on-VM needs shell access, else JB)
1. `git fetch && git checkout <merged commit>` in the source checkout, fill `<MUSE_CAO_USER>` in `deploy/sudoers/cao-relay` as before.
2. `sudo deploy/scripts/deploy.sh`. It now first stops and removes the old `cto-*` units, `/etc/sudoers.d/cto-relay`, `/etc/tmpfiles.d/cto-relay.conf`, the old `/usr/local/bin/cto-relay*` wrappers and `/opt/cto-relay`, moves `/var/lib/cto-relay` to `/var/lib/cao-relay` and `/etc/cto-relay` to `/etc/cao-relay`, creates the `cao-relay-*` users, and hands the state to them. Old `cto-relay-*` users are left; delete them later.
3. Convert settings: `sudo sed -i 's/^CTO_RELAY_/CAO_RELAY_/' /etc/cao-relay/relay.env` (optional now, old names still work). Values only, no secrets. Keep `fetch-keys.conf` labels as they are (`cto-relay-*`).
4. Update the vault file `cao-relay-expected.json` with the commit and config hash that `deploy.sh` prints (the mini sync checks it). (agent via vault write, or JB)
5. `sudo systemctl enable --now cao-heartbeat.timer cao-relay-offhost-copy.timer cao-relay-muse cao-relay-claude cao-relay-gemini cao-relay-axon-hermes`.

### 4. Mac mini (WHO: agent-on-mini needs Mini Connector or Tailscale, else JB)
1. `git -C /opt/cao-relay fetch && git -C /opt/cao-relay checkout <commit>` (or reclone to `/opt/cao-relay`).
2. `deploy/scripts/cao-relay-mini-sync.sh --retire-old` bootouts and removes the four `com.northside.cto-relay.<cao>` launchd plists and moves `/var/lib/cto-relay` to `/var/lib/cao-relay`.
3. Create the macOS users `cao-relay-<cao>` and copy each old user's keychain items (names unchanged) into the new user's login keychain. (JB-only for the secret values; no agent reads or prints them.)
4. Install the units: copy `deploy/launchd/com.northside.cao-relay.CAO.plist.template` to `/Library/LaunchDaemons/com.northside.cao-relay.<cao>.plist` replacing `CAO_KEY`. Do not load them; they start only on failover (`cao-relay-mini-sync.sh --start`).
5. Swap the cron: `* * * * * /opt/cao-relay/deploy/scripts/mini-poller.sh` for user `cao-relay-muse`.

### 5. Verify (WHO: agent-via-Supabase and agent-via-Slack-MCP)
1. Heartbeat: `select * from cao_heartbeat;` shows `MUSE` and `MINI-POLLER` within 15 min and 1 min. `select name, epoch, holder, expires_at from cao_relay_lease;` shows four rows, holders `vm`. (agent-via-Supabase)
2. Health: `curl 127.0.0.1:9101..9104/health` on the VM. (agent-on-VM)
3. One test message per channel, one at a time, text "CAO cutover test": `#cao-bots`, `#cao-muse`, `#cao-claude`, `#cao-gemini`, `#cao-axon`. Confirm each bot answers under its CAO name and a `/fire-*` test lands an `agent_comms` row with a CAO `to_agent`. (agent-via-Slack-MCP to post and read; agent-via-Supabase to read the row)
4. `select to_agent, count(*) from agent_comms where to_agent ~ 'CTO' group by 1;` returns nothing except new rows no one wrote.

### 6. Clean up, only after a quiet week (WHO: agent-via-Supabase, gated; JB for users)
1. Drop the views `cto_relay_lease`, `cto_heartbeat` in a later migration; delete `src/legacy.ts` and its test.
2. Remove the old `cto-relay-*` system and macOS users.

## Rollback

- **Before step 3 (database only):** run the rollback block at the bottom of `0002_cao_rename.sql` (drops the views, renames the tables back, restores the agent names). The old build never stopped. (agent-via-Supabase, same gate)
- **After step 3 (new build is running):** on the VM, `systemctl disable --now` the four `cao-relay-*` services and both timers; check out the previous commit in a scratch dir and run its `deploy.sh` (it reinstalls `cto-*` units; the old units read `/etc/cto-relay` and `/var/lib/cto-relay`, so `mv` those back from `/etc/cao-relay` and `/var/lib/cao-relay` first and `chown` to the `cto-relay-*` users, which were left in place). The old build runs on the compatibility views, so keep the migration applied; only roll the database back if rows were never written under CAO names. (agent-on-VM or JB)
- **Mini:** bootout the `com.northside.cao-relay.*` units, restore the old plists from the previous commit, `mv` `/var/lib/cao-relay` back. (agent-on-mini or JB)
- **Slack:** nothing to roll back for channels. Bot display names are changed back by JB in the Slack app settings.
- State (journals, queues) moved, not copied. Take a copy first: `cp -a /var/lib/cto-relay /var/lib/cto-relay.pre-cao` on the VM before step 3.
