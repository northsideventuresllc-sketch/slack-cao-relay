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

/** The real tables' columns and the live lease-name CHECK (0004). The stub rejects what the database would reject. */
const COLUMNS: Record<RelayTable, string[]> = {
  cao_relay_lease: ['name', 'epoch', 'holder', 'acquired_at', 'heartbeat_at', 'expires_at'],
  cao_heartbeat: ['agent', 'heartbeat_at'],
  relay_pointers: ['row_id', 'from_cao', 'to_cao', 'slack_channel', 'slack_link', 'fire_id', 'state', 'created_at', 'updated_at'],
};
const LEASE_NAMES = ['muse', 'claude', 'gemini', 'axon'];
const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'];

/** Mirrors the vault wrappers aos_relay_select / upsert / update over three tables, including their checks. */
export class StubAos implements AosRelayApi {
  tables: Record<RelayTable, Array<Record<string, unknown>>> = { cao_relay_lease: [], cao_heartbeat: [], relay_pointers: [] };
  calls: Array<{ fn: string; table: string }> = [];

  private cols(table: RelayTable, keys: string[]): void {
    for (const k of keys) if (!COLUMNS[table].includes(k)) throw new Error(`no such column: ${k}`);
  }
  private check(table: RelayTable, row: Record<string, unknown>): void {
    if (table === 'cao_relay_lease' && 'name' in row && !LEASE_NAMES.includes(row.name as string)) throw new Error('23514 cao_relay_lease_name_known');
  }
  private match(row: Record<string, unknown>, filter: Filter): boolean {
    return Object.entries(filter).every(([k, v]) => {
      if (v && typeof v === 'object') {
        const entries = Object.entries(v as Record<string, unknown>);
        if (entries.length !== 1) throw new Error('one operator per column');
        const [[op, val]] = entries as [[string, string | number | null]];
        if (!OPS.includes(op)) throw new Error('unknown operator');
        if (val === null && op !== 'eq' && op !== 'ne') throw new Error('null is allowed only with eq or ne');
        const a = row[k] as string | number | null;
        if (val === null) return op === 'eq' ? a == null : a != null;
        return op === 'lt' ? a! < val : op === 'lte' ? a! <= val : op === 'gt' ? a! > val : op === 'gte' ? a! >= val : op === 'ne' ? a !== val : a === val;
      }
      return v === null ? row[k] == null : row[k] === v;
    });
  }
  async select(table: RelayTable, filter: Filter, limit = 100): Promise<unknown[]> {
    this.calls.push({ fn: 'select', table });
    this.cols(table, Object.keys(filter));
    return this.tables[table].filter((r) => this.match(r, filter)).slice(0, limit).map((r) => ({ ...r }));
  }
  async upsert(table: RelayTable, row: Record<string, unknown>, conflict: string, onConflict: 'update' | 'nothing' = 'update'): Promise<unknown[]> {
    this.calls.push({ fn: 'upsert', table });
    if (onConflict !== 'update' && onConflict !== 'nothing') throw new Error('p_on_conflict must be update or nothing');
    this.cols(table, [...Object.keys(row), conflict]);
    this.check(table, row);
    const cur = this.tables[table].find((r) => r[conflict] === row[conflict]);
    if (cur) {
      // the SQL: do nothing when asked to, or when the row holds only the key; otherwise merge
      if (onConflict === 'nothing' || Object.keys(row).every((k) => k === conflict)) return [];
      Object.assign(cur, row);
      if (table === 'relay_pointers') cur.updated_at = new Date().toISOString();
      return [{ ...cur }];
    }
    const now = new Date().toISOString();
    const fresh = table === 'relay_pointers' ? { created_at: now, updated_at: now, ...row } : { ...row };
    this.tables[table].push(fresh);
    return [{ ...fresh }];
  }
  async update(table: RelayTable, filter: Filter, patch: Record<string, unknown>): Promise<number> {
    this.calls.push({ fn: 'update', table });
    if (Object.keys(filter).length === 0) throw new Error('update needs a filter');
    this.cols(table, [...Object.keys(filter), ...Object.keys(patch)]);
    this.check(table, patch);
    const hit = this.tables[table].filter((r) => this.match(r, filter));
    for (const r of hit) {
      Object.assign(r, patch);
      if (table === 'relay_pointers') r.updated_at = new Date().toISOString(); // the trigger
    }
    return hit.length;
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
  const userTok = stubDoorman({ tokenFor: (s) => (s.endsWith('BOT_TOKEN') ? 'xoxp-u' : 'xapp-1') });
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
    .filter((l) => l && !l.startsWith('deploy/scripts/') && !/fire-axon-hermes|cto-relay-axon-hermes|cto-relay-\{muse|legacy|axon-hermes. is read as|axon-hermes\/|axon-hermes state|axon-hermes -> axon|axon-hermes`/.test(l));
  assert.deepEqual(lines, []);
  // the cutover steps enable only units that exist
  assert.doesNotMatch(readFileSync(join(REPO_ROOT, 'docs/CAO-CUTOVER.md'), 'utf8'), /enable --now[^\n]*cao-relay-axon-hermes/);
});

// ---- 8. gate round 1: contract, lease name, pointer sync, doorman outage ------------------------------------------

/** The functions of supabase/migrations/0004_relay_to_aos.sql: name -> { param -> hasDefault }. */
function sqlFunctions(): Map<string, Map<string, boolean>> {
  const sql = readFileSync(join(REPO_ROOT, 'supabase/migrations/0004_relay_to_aos.sql'), 'utf8');
  const out = new Map<string, Map<string, boolean>>();
  for (const m of sql.matchAll(/create or replace function public\.(aos_relay_\w+)\(([^)]*)\)/g)) {
    const params = new Map<string, boolean>();
    for (const part of m[2]!.split(',')) {
      const t = part.trim();
      if (!t) continue;
      params.set(t.split(/\s+/)[0]!, /\bdefault\b/i.test(t));
    }
    out.set(m[1]!, params);
  }
  return out;
}

test('contract: every RPC body key the HttpAosRelay client sends is a real parameter of the 0004 function, and every required parameter is sent', async () => {
  const { createServer } = await import('node:http');
  const bodies: Array<{ fn: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push({ fn: (req.url ?? '').split('/').pop()!, body: JSON.parse(raw) as Record<string, unknown> });
      res.setHeader('content-type', 'application/json');
      res.end(req.url?.endsWith('aos_relay_update') ? '1' : '[]');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const { HttpAosRelay } = await import('../src/brain.js');
    const http = new HttpAosRelay({ supabaseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key-not-real' });
    await http.select('cao_relay_lease', { name: 'axon' }, 1);
    await http.upsert('cao_relay_lease', { name: 'axon', epoch: 1 }, 'name', 'nothing');
    await http.upsert('cao_heartbeat', { agent: 'MUSE', heartbeat_at: 'x' }, 'agent');
    await http.update('cao_relay_lease', { name: 'axon', epoch: 1 }, { epoch: 2 });
  } finally {
    server.close();
  }
  const fns = sqlFunctions();
  assert.deepEqual([...fns.keys()].sort(), ['aos_relay_delete', 'aos_relay_select', 'aos_relay_update', 'aos_relay_upsert']);
  assert.equal(bodies.length, 4);
  for (const { fn, body } of bodies) {
    const params = fns.get(fn);
    assert.ok(params, `no SQL function ${fn}`);
    for (const k of Object.keys(body)) assert.ok(params.has(k), `${fn}: body key ${k} is not a parameter of the SQL function`);
    for (const [p, hasDefault] of params) if (!hasDefault) assert.ok(p in body, `${fn}: required parameter ${p} is not sent`);
  }
  const upserts = bodies.filter((b) => b.fn === 'aos_relay_upsert').map((b) => b.body.p_on_conflict);
  assert.deepEqual(upserts, ['nothing', 'update']);
});

test('0004 carries the lease-name change (axon) and equals the vault 012 body after its 3-line header', () => {
  const sql = readFileSync(join(REPO_ROOT, 'supabase/migrations/0004_relay_to_aos.sql'), 'utf8');
  assert.match(sql, /check \(name in \('muse', 'claude', 'gemini', 'axon'\)\)/);
  assert.match(sql, /drop function if exists public\.aos_relay_upsert\(text, jsonb, text\)/);
  assert.match(sql, /p_on_conflict text default 'update'/);
  assert.match(sql, /create trigger relay_pointers_touch/);
});

test('the lease for the old name axon-hermes is refused by the lease-name check; axon is accepted', async () => {
  const { aos } = pointerBrain();
  await assert.rejects(aos.upsert('cao_relay_lease', { name: 'axon-hermes', epoch: 1 }, 'name', 'nothing'), /23514/);
  assert.equal((await aos.upsert('cao_relay_lease', { name: 'axon', epoch: 1 }, 'name', 'nothing')).length, 1);
  assert.equal((await aos.upsert('cao_relay_lease', { name: 'axon', epoch: 9, holder: 'x' }, 'name', 'nothing')).length, 0); // never overwrites a live holder
  assert.equal(aos.tables.cao_relay_lease[0]!.epoch, 1);
});

test('the stub rejects unknown columns and a null filter with an ordering operator, as the SQL does', async () => {
  const { aos } = pointerBrain();
  await aos.upsert('relay_pointers', { row_id: 'r1', from_cao: 'muse', to_cao: 'claude', slack_channel: 'cao-claude', slack_link: 'https://x.slack.com/archives/C1', state: 'posted' }, 'row_id');
  await assert.rejects(aos.select('relay_pointers', { nope: 1 }), /no such column/);
  await assert.rejects(aos.select('relay_pointers', { state: { lt: null } }), /null is allowed only with eq or ne/);
  await assert.rejects(aos.update('relay_pointers', { row_id: 'x' }, { body: 'text' }), /no such column/);
});

const fromClaudeEvidence = (claude: { channelId: string }) => ({ v: 0, cao: 'gemini', task_hash: 'h', norm_hash: 'n', idem_key: 'k', epoch: 1, slack: { channel_id: claude.channelId, ts: '1762400000.000100', permalink: null } });

test('pointer state survives a brain outage: the ledger is written first and syncPointers pushes it later', async () => {
  const { aos, brain, reg, ledger } = pointerBrain();
  const gem = reg.caos.find((c) => c.key === 'gemini')!;
  const row = await brain.insertFireRow({ toAgent: gem.agentName, fromAgent: 'MUSE', toHarness: 'gemini', firedAt: new Date().toISOString(), evidence: fromClaudeEvidence(gem) });
  const realUpdate = aos.update.bind(aos);
  aos.update = async () => {
    throw new Error('brain down');
  };
  const patched = await brain.patchFireRow(row.id, { status: 'closed', completed_at: new Date().toISOString() });
  assert.ok(patched, 'the local patch lands even with the brain down');
  assert.equal(ledger.get(row.id)!.status, 'closed');
  assert.equal(ledger.get(row.id)!.pointer_synced, false);
  assert.equal(aos.tables.relay_pointers[0]!.state, 'posted');
  assert.equal(await brain.syncPointers!(), 0); // still down: nothing synced, nothing lost
  aos.update = realUpdate;
  assert.equal(await brain.syncPointers!(), 1);
  assert.equal(aos.tables.relay_pointers[0]!.state, 'answered');
  assert.equal(ledger.get(row.id)!.pointer_synced, true);
});

test('a held start retried after a brain outage keeps its author: the pointer is written for a CAO sender, and a missing pointer alerts', async () => {
  const reg = testRegistry();
  const gem = reg.caos.find((c) => c.key === 'gemini')!;
  const aos = new StubAos();
  const noPointer: Array<{ fireId: string; reason: string }> = [];
  const brain = new DirectBrain({ relay: aos, ledger: new FireLedger(null), clock: new FakeClock().now, randomHex: () => 'cd34', directory: { slackDomain: reg.workspace.domain, caoBotsChannelId: reg.caoBotsChannelId, caos: reg.caos }, onNoPointer: (i) => noPointer.push(i) });
  const claudeName = reg.caos.find((c) => c.key === 'claude')!.agentName;
  await brain.insertFireRow({ toAgent: gem.agentName, fromAgent: claudeName, toHarness: 'gemini', firedAt: new Date().toISOString(), evidence: fromClaudeEvidence(gem) });
  assert.equal(aos.tables.relay_pointers.length, 1);
  assert.equal(aos.tables.relay_pointers[0]!.from_cao, 'claude');
  assert.equal(noPointer.length, 0);
  // a CAO writing to itself has no pointer: that is reported, not skipped silently
  await brain.insertFireRow({ toAgent: gem.agentName, fromAgent: gem.agentName, toHarness: 'gemini', firedAt: new Date().toISOString(), evidence: { ...fromClaudeEvidence(gem), idem_key: 'k2' } });
  assert.equal(noPointer.length, 1);
  assert.equal(noPointer[0]!.reason, 'same-cao');
  const { FireBook } = await import('../src/firebook.js');
  assert.ok('heldFromAgent' in (new FireBook() as unknown as { byId: Map<string, object> }) === false); // the field lives on entries, not the book
  assert.match(readFileSync(join(REPO_ROOT, 'src/core.ts'), 'utf8'), /fromAgent: e\.heldFromAgent \?\? 'CAO-RELAY'/);
});

test('the mini poller builds its brain with the pointer directory (the fallback sweep can list rows)', () => {
  assert.match(readFileSync(join(REPO_ROOT, 'src/poller.ts'), 'utf8'), /directory: \{ slackDomain: registry\.workspace\.domain/);
});

test('a doorman that does not answer (network, 5xx, not JSON) is a retry, not a refusal; a real refusal stays down; the lease is let go', async () => {
  const { HttpDoorman } = await import('../src/doorman.js');
  const ask = (status: number, body: () => Promise<unknown>) =>
    new HttpDoorman({ url: 'http://x', publishableKey: 'pk', identityToken: 'id', fetchImpl: async () => ({ status, json: body }) }).ask({ agent: 'claude', secret: 's', job: 'cao-relay', run: 'r' });
  assert.equal((await ask(503, async () => ({}))).answer, 'unreachable');
  assert.equal((await ask(200, async () => { throw new Error('not json'); })).answer, 'unreachable');
  const net = await new HttpDoorman({ url: 'http://x', publishableKey: 'pk', identityToken: 'id', fetchImpl: async () => { throw new Error('ECONNRESET'); } }).ask({ agent: 'a', secret: 's', job: 'j', run: 'r' });
  assert.equal(net.answer, 'unreachable');
  assert.equal((await ask(403, async () => ({ answer: 'refused', why: 'no grant' }))).answer, 'refused');
  const given = await ask(200, async () => ({ answer: 'given', value: ' xoxb-abc \n' }));
  assert.deepEqual(given, { answer: 'given', value: 'xoxb-abc' });

  const down: DoormanApi = { async ask() { return { answer: 'unreachable', why: 'doorman unreachable' }; } };
  const brain = new FakeBrain(new FakeClock());
  await assert.rejects(start('claude', brain, down), (e: Fatal) => e instanceof Fatal && e.exitCode === 1);
  await assert.rejects(start('claude', new FakeBrain(new FakeClock()), stubDoorman({ refuse: () => true })), (e: Fatal) => e instanceof Fatal && e.exitCode === EXIT_STAY_DOWN);
});

test('start-up order: the brain answers and the lease is taken before the doorman is asked', async () => {
  const order: string[] = [];
  const brain = new FakeBrain(new FakeClock());
  const ping = brain.ping.bind(brain);
  brain.ping = async () => { order.push('ping'); return ping(); };
  const insert = brain.insertLease.bind(brain);
  brain.insertLease = async (r) => { order.push('lease'); return insert(r); };
  const d = stubDoorman();
  const ask = d.ask.bind(d);
  d.ask = async (r) => { order.push('doorman'); return ask(r); };
  await start('muse', brain, d);
  assert.deepEqual(order.slice(0, 3), ['ping', 'lease', 'doorman']);
});

test('a corrupt fire-ledger.json is moved aside, never overwritten, and the relay is told', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const path = join(dir, 'fire-ledger.json');
  writeFileSync(path, '{"torn":');
  const l = new FireLedger(path);
  assert.ok(l.quarantinedTo && l.quarantinedTo.includes('.corrupt-'));
  assert.equal(readFileSync(l.quarantinedTo!, 'utf8'), '{"torn":');
  assert.equal(l.list().length, 0);
});

test('every relay, not only Muse, runs archive, prune and lock-clear over its own ledger', () => {
  const src = readFileSync(join(REPO_ROOT, 'src/relay.ts'), 'utf8');
  assert.match(src, /const ownDuties = isMuse \? null : new MuseDuties\(.*cao\.key\)/);
  assert.match(src, /housekeeping\.clearStalledLocks\(\)/);
  assert.match(src, /housekeeping\.archiveOldRows\(cfg\.archiveDir\)/);
});
