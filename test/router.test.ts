import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, parseRegistry } from '../src/registry.js';
import { plan, findCao } from '../src/router.js';
import { State } from '../src/state.js';
import { execute } from '../src/relay.js';

const reg = loadRegistry(new URL('../config/registry.json', import.meta.url).pathname);
const claude = findCao(reg, 'claude')!;
const muse = findCao(reg, 'muse')!;
const RELAY = 'UBOTRELAY1';
const noLinks = { get: () => undefined };

test('registry: five distinct channels, four CAOs', () => {
  assert.equal(reg.caos.length, 4);
  assert.equal(new Set([reg.botsChannel.channelId, ...reg.caos.map((c) => c.channelId)]).size, 5);
  assert.throws(() => parseRegistry({ ...reg, caos: reg.caos.slice(0, 3) }));
});

test('a CAO writing "to muse:" in its own channel reaches #cao-muse, mirrored to #cao-bots', () => {
  const p = plan(reg, { channel: claude.channelId, ts: '1.1', userId: claude.botUserId, text: 'To Muse: please check the queue' }, noLinks, RELAY);
  assert.deepEqual(p.posts.map((x) => x.channel), [muse.channelId, reg.botsChannel.channelId]);
  assert.equal(p.posts[0]!.text, 'From Claude CAO: please check the queue');
  assert.deepEqual(p.inbox.map((i) => i.cao), ['muse']);
});

test('"to all:" reaches the other three CAOs, never the sender', () => {
  const p = plan(reg, { channel: reg.botsChannel.channelId, ts: '2.1', userId: reg.jbUserId, text: 'to all: stand by' }, noLinks, RELAY);
  assert.deepEqual(p.inbox.map((i) => i.cao).sort(), ['axon', 'claude', 'gemini', 'muse'].sort());
  const fromClaude = plan(reg, { channel: claude.channelId, ts: '2.2', userId: claude.botUserId, text: 'to all: hi' }, noLinks, RELAY);
  assert.ok(!fromClaude.inbox.some((i) => i.cao === 'claude'));
  assert.equal(fromClaude.inbox.length, 3);
});

test('replies go both ways through the thread link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cao-'));
  const st = new State(join(dir, 's.json'));
  st.link({ channel: claude.channelId, ts: '1.1' }, { channel: muse.channelId, ts: '9.9' });
  const back = plan(reg, { channel: muse.channelId, ts: '9.10', threadTs: '9.9', userId: muse.botUserId, text: 'done' }, st, RELAY);
  assert.equal(back.posts[0]!.channel, claude.channelId);
  assert.equal(back.posts[0]!.threadTs, '1.1');
  const forth = plan(reg, { channel: claude.channelId, ts: '1.2', threadTs: '1.1', userId: claude.botUserId, text: 'thanks' }, st, RELAY);
  assert.equal(forth.posts[0]!.channel, muse.channelId);
  assert.equal(forth.posts[0]!.threadTs, '9.9');
  assert.equal(new State(join(dir, 's.json')).get(muse.channelId, '9.9')?.ts, '1.1', 'links survive a restart');
});

test('ignored: own posts, strangers, other channels, edits, unaddressed chat, unknown CAO, self', () => {
  const base = { channel: claude.channelId, ts: '3.1', userId: claude.botUserId, text: 'to muse: x' };
  assert.equal(plan(reg, { ...base, userId: RELAY }, noLinks, RELAY).posts.length, 0);
  assert.equal(plan(reg, { ...base, userId: 'USTRANGER1' }, noLinks, RELAY).posts.length, 0);
  assert.equal(plan(reg, { ...base, channel: 'CZZZZZZZZZ' }, noLinks, RELAY).posts.length, 0);
  assert.equal(plan(reg, { ...base, subtype: 'message_changed' }, noLinks, RELAY).posts.length, 0);
  assert.equal(plan(reg, { ...base, text: 'just talking' }, noLinks, RELAY).posts.length, 0);
  assert.equal(plan(reg, { ...base, text: 'to nobody: x' }, noLinks, RELAY).posts.length, 0);
  assert.equal(plan(reg, { ...base, text: 'to claude: x' }, noLinks, RELAY).posts.length, 0);
  assert.equal(plan(reg, { ...base, threadTs: '0.5', ts: '3.2' }, noLinks, RELAY).posts.length, 0, 'reply in an uncarried thread');
});

test('execute: posts, links the thread, writes the inbox file, survives one failed post', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cao-'));
  const st = new State(join(dir, 's.json'));
  let n = 0;
  const poster = { async post(p: { channel: string }) { if (p.channel === reg.botsChannel.channelId) throw new Error('boom'); return `7.${++n}`; } };
  const p = plan(reg, { channel: claude.channelId, ts: '1.1', userId: claude.botUserId, text: 'to muse: hello' }, st, RELAY);
  const logs: string[] = [];
  const done = await execute(p, { poster, state: st, inboxDir: join(dir, 'inbox'), log: (s) => logs.push(s) });
  assert.equal(done.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(st.get(claude.channelId, '1.1')?.channel, muse.channelId);
  const line = JSON.parse(readFileSync(join(dir, 'inbox', 'muse.jsonl'), 'utf8').trim());
  assert.equal(line.text, 'hello');
  assert.equal(line.from, 'Claude CAO');
});

test('state: an event id is handled once', () => {
  const st = new State(null);
  assert.equal(st.firstTime('Ev1'), true);
  assert.equal(st.firstTime('Ev1'), false);
});
