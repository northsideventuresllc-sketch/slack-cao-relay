# The Relay

The relay that connects the five Slack channels the CAOs use to talk to each other: `#cao-bots`, `#cao-muse`, `#cao-claude`, `#cao-gemini`, `#cao-axon`. It uses the brain only for ids, hashes, links and states.

**Owner:** Northside Ventures Group. Operator: JB.

## How to run it

```bash
npm install
npm run build
npm test
```

Channel settings are in `config/`.

## What is live

No site. It runs as a background service.

## Where things live

- **Wiring** lives in NI Brain, in the new `aos` area (run tables, fire keys, the secrets index, mirror status). Code reads ids, states and links there, nothing else.
- **Site data** lives in NVG Infrastructure Data. For now that is the new site area inside NI Brain (the `aos_*` site schemas), until the NVG Infrastructure Data project is ready.
- **Rules** live in one place only: the vault repo `nv-vault`, file `Active Context/Rules/Agent OS Rules.md`. No rule is written in this repo.

No secret is ever stored in this repo. Code asks for one secret for one job at run time.
