// v4.0 relay cutover: no start caps, no Muse-first gate, one doorman identity per relay, bot-token-only
// posting, pointer-only brain rows on the aos wrappers, no agent_comms, no "AXON-Hermes".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadRegistry, REPO_ROOT, CAO_KEYS, IDENTITY_FOR_CAO, RegistrySchema, type CaoKey } from '../src/config.js';
import { bootstrapRelay, Fatal, type SlackProbe } from '../src/bootstrap.js';
import { EXIT_STAY_DOWN, SlackChannel } from '../src/channel/slack.js';
import { DirectBrain, parseSlackLink, type AosRelayApi, type Filter, type RelayTable } from '../src/brain.js';
import { FireLedger } from '../src/ledger.js';
import { fetchRelayTokens, readIdentityToken, relaySecretNames, IdentityUnavailable, type DoormanApi } from '../src/doorman.js';
import { NotABotError, assertSlackTokenShapes } from '../src/slackguard.js';
import { parseAbort } from '../src/parser.js';
import { silentLogger } from '../src/util/log.js';
import { FakeBrain, FakeClock, testRegistry } from './helpers.js';

// ---- stubs ------------------------------------------------------------------------------------

/** Mirrors the vault wrappers aos_relay_select / upsert / update / delete over three tables. */
export class StubAos implements AosRelayApi {
  tables: Record<RelayTable, Array<Record<string, unknown>>> = { cao_relay_lease: [], cao_heartbeat: [], relay_pointers: [] };
  private static readonly KEY: Record<RelayTable, string> = { cao_relay_lease: 'name', cao_heartbeat: 'agent', relay_pointers: 'row_id' };
  calls: Array<{ fn: string; table: string }> = [];

  private match(row: Record<string, unknown>, filter: Filter): boolean {
    return Object.entries(filter).every(([k, v]) => {
      if (v && typeof v === 'object') {
        const [[op, val]] = Object.entries(v as Record<string, unknown>) as [[string, string | number]];
        const a = row[k] as string | number;
        return op === 'lt' ? a < val : op === 'lte' ? a <= val : op === 'gt' ? a > val : op === 'gte' ? a >= val : op === 'ne' ? a !== val : a === val;
      }
      return row[k] === v;
    });
  }
  async select(table: RelayTable, filter: Filter, limit = 100): Promise<unknown[]> {
    this.calls.push({ fn: 'select', table });
    return this.tables[table].filter((r) => this.match(r, filter)).slice(0, limit).map((r) => ({ ...r }));
  }
  async upsert(table: RelayTable, row: Record<string, unknown>, conflict: string, onConflict: 'update' | 'nothing' = 'update'): Promise<unknown[]> {
    this.calls.push({ fn: 'upsert', table });
    const cur = this.tables[table].find((r) => r[conflict] === row[conflict]);
    if (cur) {
      if (onConflict === 'nothing') return [];
      Object.assign(cur, row);
      return [{ ...cur }];
    }
    const now = new Date().toISOString();
    const fresh = table === 'relay_pointers' ? { created_at: now, updated_at: now, ...row } : { ...row };
    this.tables[table].push(fresh);
    return [{ ...fresh }];
  }
  async update(table: RelayTable, filter: Filter, patch: Record<string, unknown>): Promise<number> {
    this.calls.push({ fn: 'update', table });
    const hit = this.tables[table].filter((r) => this.match(r, filter));
    for (const r of hit) Object.assign(r, patch);
    return hit.length;
  }
  async remove(table: RelayTable, filter: Filter): Promise<number> {
    const before = this.tables[table].length;
    this.tables[table] = this.tables[table].filter((r) => !this.match(r, filter));
    return before - this.tables[table].length;
  }
}

const TOKENS = (k: CaoKey): { bot: string; app: string } => ({ bot: `xoxb-test-${k}`, app: `xapp-test-${k}` });

/** A doorman stub: answers only for the secret names it is told to, records every request. */
function stubDoorman(opts: { refuse?: (secret: string) => boolean; tokenFor?: (secret: string) => string } = {}): DoormanApi & { asked: Array<{ agent: string; secret: string; job: string }> } {
  const asked: Array<{ agent: string; secret: string; job: string }> = [];
  return {
    asked,
    async ask(req) {
      asked.push({ agent: req.agent, secret: req.secret, job: req.job });
      if (opts.refuse?.(req.secret)) return { answer: 'refused', why: 'no grant for this identity' };
      if (opts.tokenFor) return { answer: 'given', value: opts.tokenFor(req.secret) };
      const m = /^CAO_RELAY_([A-Z]+)_(BOT|APP)_TOKEN$/.exec(req.secret)!;
      const t = TOKENS(m[1]!.toLowerCase() as CaoKey);
      return { answer: 'given', value: m[2] === 'BOT' ? t.bot : t.app };
    },
  };
}

function cfgFor(cao: CaoKey) {
  const cfg = loadConfig({ CAO_RELAY_CAO: cao, CAO_RELAY_STATE_DIR: mkdtempSync(join(tmpdir(), 'cutover-')) });
  return { ...cfg, registry: { ...cfg.registry } };
}

function slackStub(cao: CaoKey, answer?: { userId?: string; botId?: string | null }): SlackProbe {
  const reg = loadRegistry();
  const me = reg.caos.find((c) => c.key === cao)!;
  return {
    async authTest() {
      if (answer?.botId === null) throw new NotABotError();
      return { userId: answer?.userId ?? me.botUserId, botId: answer?.botId ?? 'B0TEST' };
    },
  };
}

async function start(cao: CaoKey, brain: FakeBrain, doorman: DoormanApi, slack?: SlackProbe, clock = new FakeClock()) {
  const alerts: string[] = [];
  return bootstrapRelay(cfgFor(cao), { doorman, makeBrain: () => brain, makeSlack: () => slack ?? slackStub(cao), clock: clock.now, log: silentLogger, alert: (c) => void alerts.push(c) });
}

// ---- 1. no caps -------------------------------------------------------------------------------

test('registry: no cap config is needed; a registry that still has a removed cap key is rejected as unknown', () => {
  const r = loadRegistry();
  assert.deepEqual(Object.keys(r.caps).sort(), ['monthlyTokenCeiling', 'perFireTokenBudget', 'weeklyStartFloor']);
  for (const key of ['dailyStartCapTotal', 'monthlyStartCapTotal', 'perCaoWeeklyManualCap']) {
    const bad = { ...JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'registry.json'), 'utf8')) };
    bad.caps = { ...bad.caps, [key]: 1 };
    assert.throws(() => RegistrySchema.parse(bad), /unrecognized|Unrecognized/i, key);
  }
  const src = ['src/config.ts', 'src/caps.ts', 'src/core.ts', 'config/registry.json', 'docs/RELAY-RUNBOOK.md', 'docs/CAO-CUTOVER.md'].map((f) => readFileSync(join(REPO_ROOT, f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /dailyStartCapTotal|monthlyStartCapTotal|perCaoWeeklyManualCap/);
});

test('every registry entry carries its one harness identity', () => {
  const r = loadRegistry();
  assert.deepEqual(r.caos.map((c) => [c.key, c.harnessIdentity]), [['muse', 'muse'], ['claude', 'claude_code'], ['gemini', 'gemini_antigravity'], ['axon', 'hermes']]);
  const swapped = JSON.parse(JSON.stringify(r));
  swapped.caos[1].harnessIdentity = 'muse';
  assert.throws(() => RegistrySchema.parse(swapped));
});

// ---- 2. no Muse-first gate ------------------------------------------------------------------------

test('each relay starts and takes its own lease with NO heartbeats from the other relays (no Muse-first gate)', async () => {
  for (const cao of CAO_KEYS) {
    const brain = new FakeBrain(new FakeClock()); // empty: no Muse heartbeat, no other lease
    const up = await start(cao, brain, stubDoorman());
    assert.equal(up.lease.snapshot().state, 'held', cao);
    assert.equal(brain.heartbeats.size, 0);
    assert.deepEqual([...brain.leases.keys()], [cao]);
  }
  const src = readFileSync(join(REPO_ROOT, 'src', 'relay.ts'), 'utf8') + readFileSync(join(REPO_ROOT, 'src', 'bootstrap.ts'), 'utf8');
  assert.doesNotMatch(src, /getHeartbeat|BrokerServer|BrokeredBrain/);
});

// ---- 3. one doorman identity per relay ----------------------------------------------------------

test('each relay asks the doorman for its own two secrets only, job cao-relay, agent = its name', async () => {
  for (const cao of CAO_KEYS) {
    const d = stubDoorman();
    await start(cao, new FakeBrain(new FakeClock()), d);
    const names = relaySecretNames(cao);
    assert.deepEqual(d.asked, [
      { agent: cao, secret: names.bot, job: 'cao-relay' },
      { agent: cao, secret: names.app, job: 'cao-relay' },
    ]);
    assert.match(names.bot, new RegExp(`^CAO_RELAY_${cao.toUpperCase()}_BOT_TOKEN$`));
  }
  assert.deepEqual(IDENTITY_FOR_CAO, { muse: 'muse', claude: 'claude_code', gemini: 'gemini_antigravity', axon: 'hermes' });
});

test('a doorman that refuses one relay leaves only that relay down', async () => {
  const doorman = stubDoorman({ refuse: (s) => s.startsWith('CAO_RELAY_CLAUDE_') });
  const results = await Promise.allSettled(CAO_KEYS.map((c) => start(c, new FakeBrain(new FakeClock()), doorman)));
  const byCao = Object.fromEntries(CAO_KEYS.map((c, i) => [c, results[i]!.status]));
  assert.deepEqual(byCao, { muse: 'fulfilled', claude: 'rejected', gemini: 'fulfilled', axon: 'fulfilled' });
  const r = results[1] as PromiseRejectedResult;
  assert.ok(r.reason instanceof Fatal);
  assert.equal((r.reason as Fatal).exitCode, EXIT_STAY_DOWN);
  assert.doesNotMatch((r.reason as Fatal).reason, /xox/);
});

test('identity token comes from the machine store: systemd credential on the VM, keychain on the mini', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cred-'));
  writeFileSync(join(dir, 'doorman-identity'), 'tok-vm\n');
  assert.equal(readIdentityToken('hermes', { platform: 'linux', identityDir: dir }), 'tok-vm');
  assert.throws(() => readIdentityToken('hermes', { platform: 'linux', identityDir: join(dir, 'none') }), IdentityUnavailable);
  const seen: string[][] = [];
  const v = readIdentityToken('claude_code', { platform: 'darwin', exec: (_f, a) => (seen.push(a), 'tok-mini\n') });
  assert.equal(v, 'tok-mini');
  assert.deepEqual(seen[0], ['find-generic-password', '-s', 'nvg-doorman-identity', '-a', 'claude_code', '-w']);
});

test('fetchRelayTokens never builds another relay\'s secret name', async () => {
  const d = stubDoorman();
  await fetchRelayTokens('gemini', d);
  assert.ok(d.asked.every((a) => a.secret.includes('_GEMINI_') && a.agent === 'gemini'));
});

// ---- 4. bot-token-only ----------------------------------------------------------------------------

test('a user token (xoxp-), an empty token, or an auth.test answer with no bot_id each stop start-up', async () => {
  const userTok = stubDoorman({ tokenFor: (s) => (s.endsWith('BOT_TOKEN') ? 'xoxp-user-token' : 'xapp-1') });
  await assert.rejects(start('claude', new FakeBrain(new FakeClock()), userTok), (e: Fatal) => e instanceof Fatal && e.exitCode === EXIT_STAY_DOWN && /xoxp/.test(e.reason));
  // the doorman never hands back an empty value (it answers refused); a value that is empty is refused too
  const empty = stubDoorman({ tokenFor: () => '' });
  await assert.rejects(start('claude', new FakeBrain(new FakeClock()), empty), Fatal);
  await assert.rejects(start('claude', new FakeBrain(new FakeClock()), stubDoorman(), slackStub('claude', { botId: null })), (e: Fatal) => e instanceof Fatal && e.exitCode === EXIT_STAY_DOWN);
  assert.throws(() => assertSlackTokenShapes('xoxp-abc', 'xapp-abc'));
  assert.throws(() => assertSlackTokenShapes('', 'xapp-abc'));
  assert.throws(() => assertSlackTokenShapes('xoxb-abc', 'xoxb-abc'));
  assertSlackTokenShapes('xoxb-abc', 'xapp-abc');
});

test('the Slack client refuses a user token, and chat.postMessage never carries as_user or user', async () => {
  assert.throws(() => new SlackChannel({ appToken: 'xapp-1', botToken: 'xoxp-1', log: silentLogger, onFatal: () => undefined }));
  const ch = new SlackChannel({ appToken: 'xapp-1', botToken: 'xoxb-1', log: silentLogger, onFatal: () => undefined });
  const sent: Array<Record<string, unknown>> = [];
  (ch.web.chat as unknown as { postMessage: unknown }).postMessage = async (args: Record<string, unknown>) => (sent.push(args), { ts: '1762400000.000001' });
  await ch.postWithTs('C1', 'hello');
  assert.equal(sent.length, 1);
  assert.ok(!('as_user' in sent[0]!) && !('user' in sent[0]!));
});

// ---- 5. the brain client on the aos wrappers -------------------------------------------------------------------

function pointerBrain(clock = new FakeClock()) {
  const aos = new StubAos();
  const reg = testRegistry();
  const ledger = new FireLedger(null);
  const brain = new DirectBrain({
    relay: aos,
    ledger,
    clock: clock.now,
    randomHex: () => 'ab12',
    directory: { slackDomain: reg.workspace.domain, caoBotsChannelId: reg.caoBotsChannelId, caos: reg.caos },
  });
  return { aos, brain, reg, clock, ledger };
}

test('send writes one pointer row with a slack_link and no body; deliver and answer change only its state', async () => {
  const { aos, brain, reg } = pointerBrain();
  const claude = reg.caos.find((c) => c.key === 'claude')!;
  const row = await brain.insertFireRow({
    toAgent: claude.agentName,
    fromAgent: 'MUSE',
    toHarness: 'claude',
    firedAt: new Date().toISOString(),
    evidence: { v: 0, cao: 'claude', task_hash: 'h', norm_hash: 'n', idem_key: 'k', epoch: 1, slack: { channel_id: claude.channelId, ts: '1762400000.000100', permalink: null } },
  });
  assert.match(row.id, /^relay-\d{14}-ab12$/);
  const ptrs = aos.tables.relay_pointers;
  assert.equal(ptrs.length, 1);
  const p = ptrs[0]!;
  assert.deepEqual(Object.keys(p).sort(), ['created_at', 'fire_id', 'from_cao', 'row_id', 'slack_channel', 'slack_link', 'state', 'to_cao', 'updated_at']);
  assert.equal(p.state, 'posted');
  assert.equal(p.from_cao, 'muse');
  assert.equal(p.to_cao, 'claude');
  assert.equal(p.slack_channel, 'cao-claude');
  assert.equal(p.slack_link, `https://${reg.workspace.domain}/archives/${claude.channelId}/p1762400000000100`);
  assert.deepEqual(parseSlackLink(p.slack_link as string), { channelId: claude.channelId, ts: '1762400000.000100' });
  assert.ok(!('body' in p) && !('text' in p) && !('subject' in p));

  await brain.patchFireRow(row.id, { status: 'claimed' });
  assert.equal(ptrs[0]!.state, 'delivered');
  await brain.patchFireRow(row.id, { status: 'started' }); // same coarse state: no brain write
  const updatesBefore = aos.calls.filter((c) => c.fn === 'update').length;
  await brain.patchFireRow(row.id, { status: 'linked' });
  assert.equal(aos.calls.filter((c) => c.fn === 'update').length, updatesBefore);
  await brain.patchFireRow(row.id, { status: 'closed', completed_at: new Date().toISOString() });
  assert.equal(ptrs[0]!.state, 'answered');
  const row2 = await brain.insertFireRow({ toAgent: claude.agentName, fromAgent: 'MUSE', toHarness: 'claude', firedAt: '', evidence: { v: 0, cao: 'claude', task_hash: 'h', norm_hash: 'n', epoch: 1 } });
  await brain.patchFireRow(row2.id, { status: 'failed' });
  assert.equal(aos.tables.relay_pointers.find((x) => x.row_id === row2.id)!.state, 'failed');
  // only the three relay tables are ever touched
  assert.ok(aos.calls.every((c) => ['cao_relay_lease', 'cao_heartbeat', 'relay_pointers'].includes(c.table)));
});

test('a sibling relay\'s runs are visible as pointers (state only), waiting rows are selected by to_cao + state', async () => {
  const { aos, brain, reg } = pointerBrain();
  const gem = reg.caos.find((c) => c.key === 'gemini')!;
  await aos.upsert('relay_pointers', { row_id: 'relay-20261127000000-0001', from_cao: 'muse', to_cao: 'gemini', slack_channel: 'cao-gemini', slack_link: `https://x.slack.com/archives/${gem.channelId}`, fire_id: 'f', state: 'posted' }, 'row_id');
  const waiting = await brain.listFireRows(gem.agentName, ['queued']);
  assert.deepEqual(waiting.map((r) => r.id), ['relay-20261127000000-0001']);
  assert.equal(waiting[0]!.evidence, null);
  assert.equal((await brain.listFireRows(gem.agentName, ['closed'])).length, 0);
});

test('lease: compare-and-swap on name + epoch takes an expired lease, refuses a live one; insert is insert-do-nothing', async () => {
  const clock = new FakeClock();
  const { aos, brain } = pointerBrain(clock);
  const mk = (holder: string, epoch: number, expiresIn: number) => ({ name: 'axon', epoch, holder, acquired_at: new Date(clock.now()).toISOString(), heartbeat_at: new Date(clock.now()).toISOString(), expires_at: new Date(clock.now() + expiresIn).toISOString() });
  const first = await brain.insertLease(mk('vm:cao-relay-axon', 1, 90_000));
  assert.equal(first?.epoch, 1);
  assert.equal(await brain.insertLease(mk('mini:cao-relay-axon', 1, 90_000)), null, 'second insert does nothing');
  assert.equal(aos.tables.cao_relay_lease.length, 1);
  assert.equal(aos.tables.cao_relay_lease[0]!.holder, 'vm:cao-relay-axon');
  // stale epoch refuses
  assert.equal(await brain.casLease('axon', 0, mk('mini:cao-relay-axon', 1, 90_000)), null);
  // takeover at epoch + 1 wins once, the loser sees a changed epoch
  assert.equal((await brain.casLease('axon', 1, mk('mini:cao-relay-axon', 2, 90_000)))?.epoch, 2);
  assert.equal(await brain.casLease('axon', 1, mk('vm:cao-relay-axon', 2, 90_000)), null);
  // renew is fenced by epoch
  assert.ok(await brain.renewLease('axon', 2, new Date(clock.now()).toISOString(), new Date(clock.now() + 90_000).toISOString()));
  assert.equal(await brain.renewLease('axon', 1, 'x', 'y'), null);
  // heartbeat
  await brain.upsertHeartbeat('MUSE', new Date(clock.now()).toISOString());
  assert.equal((await brain.getHeartbeat('MUSE'))?.agent, 'MUSE');
});

test('LeaseManager over the wrapper client: two holders for one name, the live one is refused', async () => {
  const clock = new FakeClock();
  const { brain } = pointerBrain(clock);
  const { LeaseManager, LeaseHeldElsewhere } = await import('../src/lease.js');
  const a = new LeaseManager(brain, 'axon', 'vm:cao-relay-axon', clock.now, silentLogger, () => undefined);
  const b = new LeaseManager(brain, 'axon', 'mini:cao-relay-axon', clock.now, silentLogger, () => undefined);
  await a.acquire();
  await assert.rejects(b.acquire(), LeaseHeldElsewhere);
  clock.advance(91_000);
  assert.equal(await b.acquire(), 2);
});

// ---- the abort command takes the new fire ids ---------------------------------------------------------

test('abort accepts relay-… fire ids', () => {
  assert.equal(parseAbort('abort: relay-20261127123456-ab12'), 'relay-20261127123456-ab12');
});

// ---- 6 & 7. the tree is clean --------------------------------------------------------------------------------

function grepTree(pattern: string, ...paths: string[]): string {
  try {
    return execFileSync('grep', ['-rnI', '-E', pattern, ...paths], { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch {
    return ''; // grep exits 1 when nothing matches
  }
}

test('agent_comms appears nowhere in src, docs, config, deploy', () => {
  assert.equal(grepTree('agent_comms', 'src', 'docs', 'config', 'deploy'), '');
});

test('display names: nothing says "AXON-Hermes" (case-sensitive and the axon-hermes relay key) outside the old-unit retirement and the slash command', () => {
  assert.equal(grepTree('AXON-Hermes', 'src', 'docs', 'config', 'deploy', 'package.json', 'README.md'), '');
  const lines = grepTree('axon-hermes', 'src', 'config', 'deploy', 'docs')
    .split('\n')
    .filter((l) => l && !/fire-axon-hermes|cto-relay-axon-hermes|cto-relay-\{muse|cao-relay-axon-hermes|legacy|axon-hermes. is read as|axon-hermes\/|axon-hermes state|axon-hermes -> axon|axon-hermes`/.test(l));
  assert.deepEqual(lines, []);
});
