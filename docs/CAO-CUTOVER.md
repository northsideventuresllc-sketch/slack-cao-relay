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
- Functions that matter: `fn_comms_canonical_agent` accepts only names found in `nvg_routine_state.agent_name`. That table holds `Claude CTO`, `Gemini CTO`, `AXON-Hermes CTO`, `MUSE CTO` (all `kind = cto`), `MUSE` (`kind = agent`), and no CAO names. Until 0003 renames them, `comms_send` to `Claude CAO` fails with "unknown agent name", and the moment 0003 runs, anything still sending to the old names fails the same way.
- Other places that carry the names (SELECT-only checks): `nvg_agent_presence` has one row `Claude CTO` (active, claude_code_cloud). Its trigger `fn_agent_presence_stamps_routine_last_fired` upserts `nvg_routine_state` from `presence.agent_name`, so a session still reporting as "Claude CTO" would re-create an orphan routine row; 0003 replaces the function to map old names. `nvg_routine_state.owner_agent` has 3 rows (2 `Claude CTO`, 1 `MUSE CTO`). `agent_comms_wake_log.to_agent` has 317 old-name rows (a log; left as is). `aos.fire_keys`, `aos.other_runs`, `nvg_council_decisions`, `agent_bus`, `usage_reports_*` and `secrets_audit_log` hold no old names (0003 still updates `aos.fire_keys` defensively).
- `fn_autofire_agent` wakes an agent through the secret named `AGENT_FIRE_<UPPER_SNAKE(agent name)>`. The stored key `AGENT_FIRE_CLAUDE_CTO` would stop matching `Claude CAO`; 0003 renames that key's name only (value never read or printed). No `AGENT_FIRE_*` key exists for Gemini, AXON-Hermes or Muse CTO today.
- `pg_cron`: 25 jobs, all site pings (`aos_mf_*`, `aos_ni_*`, `aos_rate_limit_cleanup`). None names an agent. No function body hardcodes an old name.
- **CTO Monitor** is not a database object. It sent 270 rows, the latest on 2026-11-18, addressed to `Claude CTO` (201), `AXON-Hermes CTO` (68) and `Gemini CTO` (1). After 0003 those sends fail. It must be stopped before 0003 and repointed to the CAO names before it is restarted; where it lives is not recorded in this repo, so its owner (Claude CAO) has to find and stop it. 0003 also refuses to run if any old-name row, or a `CTO Monitor` row, was written in the last 10 minutes.
- Muse stays `MUSE` (the registry's agentName, no CTO in it). The old `MUSE CTO` routine row is retired (`active = false`, kept), and `agent_comms` rows to `MUSE CTO` become `MUSE`.

**Where it runs.** Primary: a VM, systemd units `cto-relay-{muse,claude,gemini,axon-hermes}.service`, `cto-heartbeat.timer`, `cto-relay-offhost-copy.timer`, code in `/opt/cto-relay`, config in `/etc/cto-relay`, state in `/var/lib/cto-relay`. Failover and poller: the Mac mini, launchd `com.northside.cto-relay.<cao>` (not loaded at boot) plus a 1-minute poller cron. Config: non-secret settings in `relay.env` (`CTO_RELAY_*`); secrets are fetched from the Secure Vault into tmpfs at each start, never in a file.

**Deliberately not renamed:** the Secure Vault labels and mini keychain item names (`cto-relay-muse`, `cto-relay-<cao>-slack-app`, `-slack-bot`, `cto-relay-vault-read`, `-write`). They name live secrets; renaming a secret is a separate change under rules 20.8 (new value, prove, then revoke old). The deploy keys on GitHub keep those labels too.

## Compatibility built into this branch

- `CAO_RELAY_*` is read first; `CTO_RELAY_*` fills any gap (`CTO_RELAY_CTO` maps to `CAO_RELAY_CAO`). See `src/legacy.ts`.
- New rows are written with CAO names. Reads accept old names: brain queries use `to_agent in ("Claude CAO","Claude CTO")`, the broker maps old names to new.
- `0002_cao_rename.sql` (tables and views only, no agent names) is safe to apply now. It leaves views named `cto_relay_lease` and `cto_heartbeat`, so the OLD build keeps working. One thing not tested: the old build upserts the heartbeat with `on_conflict=agent` through the view; PostgreSQL allows ON CONFLICT on simple views, but confirm it right after applying 0002 by watching the old relay's heartbeat (agent via Supabase), and roll 0002 back if it errors.
- `0003_cao_agent_names.sql` (agent names) is applied ONLY in the cutover window, after the old relay on the VM and the mini and CTO Monitor are stopped, and right before the new relay starts.
- The NEW build needs `cao_relay_lease` / `cao_heartbeat` (0002) and the CAO names (0003).
- Remove `src/legacy.ts` and the views after the cutover is verified.

## Who can do what (honest)

- **Slack MCP** (agent): search channels, read channels and members, send a message. It cannot create bot apps, rename apps or bots, or change app settings. It has no admin rights.
- **Supabase MCP** (agent): read-only SELECTs work. `apply_migration` / `execute_sql` writes may raise a confirmation pop-up to JB. If the pop-up cannot reach JB, rules 20.11 allows the saved-key route (pg_net from inside the database), only for SQL the council gate scored 95 or higher.
- **VM and mini shell**: no tool in this run reaches either. Needs the Mini Connector or Tailscale (agent), or JB at a terminal.
- **JB-only**: Slack admin login (app display names), and anything that needs a secret value JB's own login must change.

## Steps

### 0. Before anything (WHO: JB + agent)
1. Review the branch `claude/hopeful-pasteur-lsy4kt`; merge through `scripts/nvg-merge-deploy.mjs`-style approval (JB). No PR was opened by this run.
2. Council gate on the exact SQL of `supabase/migrations/0002_cao_rename.sql` and, separately, of `0003_cao_agent_names.sql`: each must score 95 or higher for the 20.11 route. (agent)
3. Pick a quiet time: both tables are empty and no live relay row was seen, but confirm in step 1.

### 1. Slack (WHO as marked)
1. **Channels.** All five `#cao-*` channels already exist; no `#cto-*` exists. Nothing to rename. (agent-via-Slack-MCP: confirmed by search.)
2. **Membership.** Check the four relay bots are members of their channels and of `#cao-bots`: `slack_list_channel_members` on each ID. (agent-via-Slack-MCP). Invite any missing bot. (JB-only if the invite needs admin; otherwise `/invite @bot`.)
3. **Bot display names.** Set each Slack app's display name to `Muse CAO` (app A0CEU4GCVPS), `Claude CAO` (A0CDTGZHW2X), `Gemini CAO` (A0CDZJJF2FL), `AXON-Hermes CAO` (A0CDXR7766A): api.slack.com/apps, each app, App Home, Display Name, and the app name under Basic Information. (JB-only: Slack admin login. No agent tool can do this.)
4. Do not post test messages yet.

### 2. Apply 0002 now (WHO: agent-via-Supabase, gated)
`supabase/migrations/0002_cao_rename.sql` renames the two relay tables and leaves compatibility views. It changes no agent name, so it is safe while the old relay runs.
1. Re-run the dependency checks (SELECT only): the four tables exist as expected. (agent-via-Supabase)
2. Council gate on the exact SQL, 95 or higher; apply through the saved-key route, rules 20.11 (begin/commit, never print or copy a key); record the request id and result in the run's Build Plan Executions row. (agent-via-Supabase)
3. Run the verify queries at the bottom of the file. Check the old relay's heartbeat still lands (see the ON CONFLICT note above). (agent-via-Supabase)

### 3. Stage (WHO: agent-on-VM / agent-on-mini, else JB)
Get the new commit onto the VM and the mini checkout without starting anything: `git fetch && git checkout <merged commit>` in the source checkout on the VM; the same in `/opt/cao-relay` on the mini (clone if absent). Fill `<MUSE_CAO_USER>` in `deploy/sudoers/cao-relay`. Take the state copy: `cp -a /var/lib/cto-relay /var/lib/cto-relay.pre-cao` on the VM and on the mini.

### 4. Cutover window (WHO as marked; the old relay is down from 4a until 4e)
a. **Stop everything that writes the old names.** (agent-on-VM or JB)
   - VM: `sudo systemctl stop cto-relay-muse cto-relay-claude cto-relay-gemini cto-relay-axon-hermes cto-heartbeat.timer cto-relay-offhost-copy.timer`.
   - Mac mini: `sudo launchctl bootout system/com.northside.cto-relay.<cao>` for each, and remove the poller cron line. (agent-on-mini via Mini Connector or Tailscale, else JB)
   - **CTO Monitor:** stop it. Claude CAO (its owner) finds where it runs and stops it; it must not send until it addresses `Claude CAO`, `AXON-Hermes CAO` and `Gemini CAO`. (agent: Claude CAO, or JB)
b. **Confirm quiet.** `select max(created_at) from agent_comms where to_agent ~ 'CTO' or from_agent ~ 'CTO';` is more than 10 minutes old. (agent-via-Supabase) 0003 checks this itself and aborts if not.
c. **Apply 0003.** `supabase/migrations/0003_cao_agent_names.sql`: council gate 95 or higher on the exact SQL, saved-key route (rules 20.11). It backs up every row it touches into `_bak_0003_*` tables, renames the names in `nvg_routine_state`, `nvg_agent_presence`, `agent_comms`, `aos.fire_keys`, renames the secret name `AGENT_FIRE_CLAUDE_CTO` to `..._CAO`, retires the `MUSE CTO` routine row, and aborts the whole transaction if an old name survives. Run its verify queries. (agent-via-Supabase)
d. **VM install.** `sudo deploy/scripts/deploy.sh`. It removes the old `cto-*` units, `/etc/sudoers.d/cto-relay`, `/etc/tmpfiles.d/cto-relay.conf`, the old `/usr/local/bin/cto-relay*` wrappers and `/opt/cto-relay`, moves `/var/lib/cto-relay` to `/var/lib/cao-relay` and `/etc/cto-relay` to `/etc/cao-relay`, creates the `cao-relay-*` users and hands the state to them. Then `sudo sed -i 's/^CTO_RELAY_/CAO_RELAY_/' /etc/cao-relay/relay.env` (optional; old names still work; values only, no secrets; leave `fetch-keys.conf` labels as `cto-relay-*`). Update the vault file `cao-relay-expected.json` with the commit and config hash that `deploy.sh` prints. (agent-on-VM or JB; the vault write is agent or JB)
   Mini: `deploy/scripts/cao-relay-mini-sync.sh --retire-old`; create the macOS users `cao-relay-<cao>` and copy each old user's keychain items (names unchanged) into the new user's login keychain (JB-only for the secret values; no agent reads or prints them); copy `deploy/launchd/com.northside.cao-relay.CAO.plist.template` to `/Library/LaunchDaemons/com.northside.cao-relay.<cao>.plist` replacing `CAO_KEY` (do not load: failover only); install the `mini-poller.sh` cron for user `cao-relay-muse`. (agent-on-mini, else JB)
e. **Start the new relay.** `sudo systemctl enable --now cao-heartbeat.timer cao-relay-offhost-copy.timer cao-relay-muse cao-relay-claude cao-relay-gemini cao-relay-axon-hermes`. (agent-on-VM or JB)
f. **Restart CTO Monitor** only after it is repointed to the CAO names. (Claude CAO or JB)
g. Agent definitions and any session that reports presence as "Claude CTO" must switch to "Claude CAO" now. 0003's trigger function keeps a straggler from creating an orphan, but the name should be fixed at the source.

### 5. Verify (WHO: agent-via-Supabase and agent-via-Slack-MCP)
1. Heartbeat: `select * from cao_heartbeat;` shows `MUSE` and `MINI-POLLER` within 15 min and 1 min. `select name, epoch, holder, expires_at from cao_relay_lease;` shows four rows, holders `vm`. (agent-via-Supabase)
2. Health: `curl 127.0.0.1:9101..9104/health` on the VM. (agent-on-VM)
3. One test message per channel, one at a time, text "CAO cutover test": `#cao-bots`, `#cao-muse`, `#cao-claude`, `#cao-gemini`, `#cao-axon`. Confirm each bot answers under its CAO name and a `/fire-*` test lands an `agent_comms` row with a CAO `to_agent`. (agent-via-Slack-MCP to post and read; agent-via-Supabase to read the row)
4. `select to_agent, count(*) from agent_comms where to_agent ~ 'CTO' group by 1;` returns nothing. `select agent_name, active from nvg_routine_state where agent_name ~ 'CTO';` returns only the retired `MUSE CTO` (active false); any other row is an orphan from a session still using the old name. `fn_autofire_agent('Claude CAO', 0)` is NOT run in the check (it fires a real wake); instead confirm `select key from ni_platform_secrets where key ~ 'AGENT_FIRE_CLAUDE'` shows `AGENT_FIRE_CLAUDE_CAO` (names only).

### 6. Clean up, only after a quiet week (WHO: agent-via-Supabase, gated; JB for users)
1. Drop the views `cto_relay_lease`, `cto_heartbeat` and the `_bak_0003_*` tables in a later migration; delete `src/legacy.ts` and its test.
2. Remove the old `cto-relay-*` system and macOS users.

## Rollback

- **Before 4c (0003 not applied):** restart the old units on the VM (`systemctl start ...`) and re-bootout nothing on the mini (it was never started); restart CTO Monitor. If 0002 must go too, run its rollback block (drops the views, renames the tables back). (agent-on-VM or JB; agent-via-Supabase for 0002)
- **After 4c (0003 applied):** stop the new relay and CTO Monitor first. Then run the rollback block at the bottom of `0003_cao_agent_names.sql` in one transaction. It restores from the `_bak_0003_*` backups, row by row: both name columns of every backed-up `agent_comms` row (so `MUSE CTO` to `MUSE` is undone exactly and the pre-existing `Claude CAO` row is left alone), the routine-state names, the retired `MUSE CTO` row, owners, presence, `aos.fire_keys`, the secret name and the original trigger function; CAO-named rows the new relay wrote after the cutover are mapped back by `created_at`. Same gate and route as the apply. (agent-via-Supabase)
- **VM, after the database is back:** `systemctl disable --now` the four `cao-relay-*` services and both timers; `mv /etc/cao-relay /etc/cto-relay` and `mv /var/lib/cao-relay /var/lib/cto-relay`, `chown -R` each state dir back to the `cto-relay-<cao>` users (left in place); check out the previous commit and run its `deploy.sh`. The pre-cutover copy `/var/lib/cto-relay.pre-cao` is the fallback if the moved state looks wrong. (agent-on-VM or JB)
- **Mini:** bootout the `com.northside.cao-relay.*` units, restore the old plists from the previous commit, `mv` `/var/lib/cao-relay` back. (agent-on-mini or JB)
- **Slack:** nothing to roll back for channels. Bot display names are changed back by JB in the Slack app settings.
