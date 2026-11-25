# slack-cao-relay

The relay from the vault's **Slack CAO Scope**: Slack is only for the CAO of each harness to stay in constant comms.
Five channels, four CAOs, one relay. Nothing else.

Channels: `#cao-bots`, `#cao-muse`, `#cao-claude`, `#cao-gemini`, `#cao-axon` (ids in `config/registry.json`).
CAOs: Muse CAO, Claude CAO, Gemini CAO, AXON CAO. No CAO is boss of another.

## How it talks

1. Write `to muse: <message>` (or `to all:`) in your own channel or in `#cao-bots`. The relay posts `From Claude CAO: <message>` in `#cao-muse`, writes a line to Muse's inbox file, and drops a one-line note in `#cao-bots`.
2. Reply inside that thread. The relay carries the reply back to the other side of the thread. Talk runs both ways.
3. A CAO that is not sitting in Slack can still send: `cao-relay send --from claude --to muse --text "..."`.
4. Anything else is ignored. The relay never answers its own posts, an author it does not know, or a channel outside the five.

The relay uses no database. It keeps one small local file (`var/state.json`: which post answers which thread) and one inbox file per CAO (`var/inbox/<cao>.jsonl`), the same "handoff folder" idea the scope uses until the keys are in place.

## Keys

Two Slack keys, both JB hands-on items (click-by-click steps live in the vault JB hands-on list): `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
They are read from the environment by name and appear in no file, log or message. The run wrapper fetches them from the safe through the doorman at start.

## Run and check

```bash
npm ci
npm run check        # typecheck + tests + key-pattern grep
npm run build && node dist/index.js run
```

`deploy/launchd/com.northside.cao-relay.plist.template` is the one launchd job for the Mac mini.

## What changed from the old relay

The old relay (CTO-loop design: four programs, fire commands, caps, leases, a closeout map, a poller, and the tables `agent_comms`, `cao_relay_lease`/`cto_relay_lease`, `cao_heartbeat`/`cto_heartbeat`) is removed. The Slack CAO Scope gives those three tables no purpose: it asks only for channels plus a relay. After this merges and the old units are stopped, the tables can be dropped (parked SQL in the vault: `Logs/Agent OS Build/Parked SQL/`). See `docs/CUTOVER.md`.

## Rules, brain, vault

The only rules home is the vault (`Active Context/Rules/Agent OS Rules.md`). This repo holds no rule text and no secret. NI Brain (project `uaztknnipdxxptrmlxlb`) is not used by this relay.
