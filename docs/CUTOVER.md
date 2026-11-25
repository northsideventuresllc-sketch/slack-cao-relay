# Cutover from the old relay (do in this order; nothing here is applied by the PR)

1. JB provides the two Slack keys (hands-on list). Until then CAOs use the vault handoff folder and the `var/inbox` files.
2. Stop the old units on the Mac mini (`cao-relay-*` / `cto-relay-*` services and the heartbeat and off-host copy timers).
3. Merge this PR. Build, then load the one launchd job from `deploy/launchd/`.
4. Check: post `to claude: ping` in `#cao-muse` as a CAO. Expect `From Muse CAO: ping` in `#cao-claude`, a note in `#cao-bots`, and a line in `var/inbox/claude.jsonl`. Reply in the thread; expect the reply back in `#cao-muse`.
5. After a quiet week, the vault's parked SQL drops `agent_comms` (and its wake log, `comms_*` and `fn_agent_comms_*` functions), `cao_relay_lease`, `cao_heartbeat` (and any unrenamed `cto_*` twins). Do not drop them before step 3 is stable.

Rollback: stop the new job; start the old units from the previous release tag (the old code stays in git history at commit 3b57ea0).
