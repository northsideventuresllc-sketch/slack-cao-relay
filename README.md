# slack-cao-relay

The Slack CAO Loop relay: four small programs, one per CAO (Muse, Claude,
Gemini, AXON CAO). They carry Slack messages between the CAOs, start CAO
work from `/fire-<cao>` commands and `@<CAO> fire: <task>` mentions, and post
the close-out map (Done / Log / Session / Still open) when a run finishes.

Spec: PLAN-v7.md (approved, GO 91.35%). Live facts: RUNBOOK.md (wins where the
two differ).

## What this repo is for, who owns it

This repo is the Slack relay for the five `#cao-*` channels. Owner: Claude CAO (stream S4, Agent OS v4.0). Branch `aos/v4-relay-cutover` is the v4.0 cutover.

- Each relay (Muse, Claude, Gemini, AXON CAO) starts, holds its own lease and posts on its own. No start caps. No relay waits for another.
- Each relay has one doorman identity (`muse`, `claude_code`, `gemini_antigravity`, `hermes`) and gets only its own bot and app token from the doorman. Posting is bot-token-only.
- Message text stays in Slack. The brain keeps pointer rows only (`aos.relay_pointers`), plus `aos.cao_relay_lease` and `aos.cao_heartbeat`.

## How to run it

```bash
npm ci && npm run check      # typecheck, tests, secret grep
npm run build                # dist/
cao-relay run                # one relay, CAO from CAO_RELAY_CAO (muse | claude | gemini | axon)
```
Deploy and operate: `docs/RELAY-RUNBOOK.md`. The cutover steps: `docs/CAO-CUTOVER.md`.

## Where things live

- **Wiring** lives in NI Brain, in the `aos` schema (lease, heartbeat, relay pointers, run tables, the secrets index). Code reads ids, states and links there, nothing else, and reaches it only through the `aos_relay_*` wrapper functions in `supabase/migrations/0004_relay_to_aos.sql`.
- **Site data** lives in NVG Infrastructure Data. For now that is the new site area inside NI Brain (the `aos_*` site schemas), until the NVG Infrastructure Data project is ready.
- **Rules** live in one place only: the vault repo `nv-vault`, file `Active Context/Rules/Agent OS Rules.md`. No rule is written in this repo.

No secret is ever stored in this repo. Code asks the doorman for one secret for one job at run time.

## Layout

| Path | What |
|---|---|
| `src/` | The relay (TypeScript strict + Zod). `contracts.ts` holds the PLAN-v7 Contracts. |
| `config/registry.json` | CAO registry: the single source for which adapter serves which CAO. |
| `config/blocklist.json` | Post blocklist (canonical copy in the runbook). |
| `supabase/migrations/` | Brain migrations. `0004_relay_to_aos.sql` is a copy of the nv-vault file (the canonical one). |
| `deploy/systemd/` | The four relay units, `cao-heartbeat`, and the off-host copy timer. |
| `deploy/scripts/` | Key fetch hook, deploy, mini sync, off-host copy, mini poller and run wrappers. |
| `docs/RELAY-RUNBOOK.md` | Deploy, operate, fail over, rebuild. |
| `docs/PLAN-V7-ERRATA.md` | Round-7 plan-text fixes (VERDICT-r7) for Muse CAO to apply to PLAN-v7.md. |
| `test/` | `node:test` suite (in-memory brain + Slack). |

## Checks

```bash
npm ci && npm run check
```
That runs `tsc --noEmit`, the tests, and the key-pattern grep.

## Secrets

No token, key or secret value is ever committed here. Slack tokens come only from the doorman at start. The NI Brain key and the vault deploy key are injected at deploy time (tmpfs credentials via the
systemd `ExecStartPre` fetch hook). Code and docs use environment variables
and placeholders such as `<SUPABASE_URL>`.
