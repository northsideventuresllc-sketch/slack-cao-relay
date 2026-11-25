#!/usr/bin/env node
// cao-relay run
// cao-relay send --from <cao> --to <cao|all> --text "..."     one CAO talks to another without sitting in Slack
//
// Keys come from the environment by name only: SLACK_BOT_TOKEN and SLACK_APP_TOKEN (run); SLACK_BOT_TOKEN (send).
// Nothing here prints, logs or stores a key value.
import { WebClient } from '@slack/web-api';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRegistry } from './registry.js';
import { execute, runRelay, slackPoster } from './relay.js';
import { findCao, plan } from './router.js';
import { State } from './state.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const log = (s: string) => process.stdout.write(`${new Date().toISOString()} ${s}\n`);

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--')) { const v = argv[i + 1]; out[a.slice(2)] = v !== undefined && !v.startsWith('--') ? (i++, v) : 'true'; }
  }
  return out;
}
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) { process.stderr.write(`${name} is not set in this environment\n`); process.exit(78); }
  return v;
};

async function main(): Promise<number> {
  const [cmd = 'run', ...rest] = process.argv.slice(2);
  const reg = loadRegistry(process.env.CAO_RELAY_REGISTRY ?? join(root, 'config', 'registry.json'));
  const stateDir = process.env.CAO_RELAY_STATE_DIR ?? join(root, 'var');
  const inboxDir = process.env.CAO_RELAY_INBOX_DIR ?? join(stateDir, 'inbox');
  const state = new State(join(stateDir, 'state.json'));

  if (cmd === 'run') return runRelay({ reg, state, inboxDir, botToken: need('SLACK_BOT_TOKEN'), appToken: need('SLACK_APP_TOKEN'), log });

  if (cmd === 'send') {
    const f = flags(rest);
    const from = f.from ? findCao(reg, f.from) : undefined;
    if (!from || !f.to || !f.text) { process.stderr.write('usage: cao-relay send --from <cao> --to <cao|all> --text "..."\n'); return 64; }
    const web = new WebClient(need('SLACK_BOT_TOKEN'));
    const poster = slackPoster(web);
    // The sender's own channel shows what was sent; the router then carries it as a normal "to <cao>:" line.
    const ts = await poster.post({ channel: from.channelId, text: `To ${f.to}: ${f.text}` });
    const p = plan(reg, { channel: from.channelId, ts, text: `To ${f.to}: ${f.text}`, userId: from.botUserId ?? reg.extraAuthorIds[0] ?? reg.jbUserId }, state, 'NONE');
    const done = await execute(p, { poster, state, inboxDir, log });
    log(`send: ${p.why}; posted ${done.length}`);
    return p.posts.length ? 0 : 1;
  }
  process.stderr.write('usage: cao-relay run | send --from <cao> --to <cao|all> --text "..."\n');
  return 64;
}

main().then((c) => process.exit(c), (e) => { process.stderr.write(`cao-relay: ${(e as Error).message}\n`); process.exit(1); });
