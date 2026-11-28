import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stillActive, assessRun, STALL_MS } from '../src/sweep.js';
import { decide } from '../src/poller.js';
import { Journal } from '../src/journal.js';
import { PostQueueWatcher, appendPostQueue, type PostQueueEntry } from '../src/postqueue.js';
import { countWords, isRelayTemplate, T } from '../src/templates.js';
import { placeholdersBlocking, loadRegistry } from '../src/config.js';
import { silentLogger } from '../src/util/log.js';
import { Maintenance } from '../src/maintenance.js';
import { DAY, HOUR, MIN } from '../src/util/time.js';
import { FakeBrain, FakeClock, testRegistry, makeHarness, mention } from './helpers.js';

test('still-active test (KAR-6, R7-NEW-2): prong (a) only with a live probe; one stalled definition', () => {
  const now = 10 * DAY;
  const base = { liveState: null, channelMsgAt: null, rowStatus: 'started', lastAdapterEntryAt: null, now };
  // v1: no live probe → a row stuck in `started` with no activity IS stalled (stored status does not count)
  assert.deepEqual(assessRun(base).stalled, true);
  // with a live probe, a live run is still active
  assert.equal(stillActive({ ...base, liveState: 'started' }), true);
  assert.equal(stillActive({ ...base, liveState: 'closed' }), false);
  // (b) CAO channel message under 6 h
  assert.equal(stillActive({ ...base, channelMsgAt: now - STALL_MS + 1 }), true);
  // (c) under way + own-adapter entry under 6 h (claimed / started / linked)
  for (const rowStatus of ['claimed', 'started', 'linked']) assert.equal(stillActive({ ...base, rowStatus, lastAdapterEntryAt: now - HOUR }), true);
  assert.equal(stillActive({ ...base, rowStatus: 'queued', lastAdapterEntryAt: now - HOUR }), false);
  // exactly 6 h of silence → stalled; over 24 h → also unclosed
  const six = assessRun({ ...base, lastAdapterEntryAt: now - STALL_MS });
  assert.equal(six.stalled, true);
  assert.equal(six.unclosed, false);
  assert.equal(assessRun({ ...base, lastAdapterEntryAt: now - 25 * HOUR }).unclosed, true);
});

test('mini poller: 30-minute detection, 45-minute alert, failover after 3 failed polls AND a stale heartbeat', () => {
  let s = { museFails: 0, heartbeatAlerted: false, failoverSent: false, lastSweepAt: 0 };
  let r = decide(s, true, 31 * MIN, 0);
  assert.equal(r.d.museOffline, true);
  assert.equal(r.d.alertHeartbeat, false);
  r = decide(r.next, true, 46 * MIN, 0);
  assert.equal(r.d.alertHeartbeat, true);
  r = decide(r.next, true, 47 * MIN, 0);
  assert.equal(r.d.alertHeartbeat, false, 'alert once per incident');
  s = { museFails: 0, heartbeatAlerted: false, failoverSent: false, lastSweepAt: 0 };
  r = decide(s, false, 10 * MIN, 0);
  r = decide(r.next, false, 10 * MIN, 0);
  r = decide(r.next, false, 10 * MIN, 0);
  assert.equal(r.d.failover, false, 'health down but Muse CAO online: no failover');
  r = decide(r.next, false, 31 * MIN, 0);
  assert.equal(r.d.failover, true);
  r = decide(r.next, false, null, 0);
  assert.equal(r.d.failover, false, 'sent once');
  assert.equal(decide(s, false, null, 0).d.museOffline, true, 'brain down → offline (fail-safe)');
});

test('journal compaction: purges terminal fires past 24 h, keeps close-out keys 90 days, never touches in-flight fires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'j-'));
  const clock = new FakeClock();
  const j = new Journal(join(dir, 'journal.jsonl'), clock.now);
  const h = (c: string) => c.repeat(64);
  j.append({ kind: 'fire-request', fireId: 'a', hash: h('a') });
  j.append({ kind: 'fire-state', fireId: 'a', hash: '', state: 'closed', closeoutKey: h('c') });
  j.append({ kind: 'fire-request', fireId: 'b', hash: h('b') });
  j.append({ kind: 'breaker-count', fireId: 'b', hash: h('b'), windowStart: new Date(clock.now()).toISOString() });
  clock.advance(2 * DAY);
  j.compact();
  const kinds = j.all().map((r) => `${r.fireId}:${r.kind}:${r.state ?? ''}`);
  assert.deepEqual(kinds, ['a:fire-state:closed', 'b:fire-request:']);
  clock.advance(91 * DAY);
  j.compact();
  assert.deepEqual(j.all().map((r) => r.fireId), ['b']);
  const reloaded = new Journal(join(dir, 'journal.jsonl'), clock.now);
  reloaded.load();
  assert.equal(reloaded.all().length, 1);
});

test('journal: a torn last line (crash mid-write) is skipped, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'j-'));
  const p = join(dir, 'journal.jsonl');
  const clock = new FakeClock();
  const j = new Journal(p, clock.now);
  j.append({ kind: 'fire-request', fireId: 'a', hash: 'a'.repeat(64) });
  writeFileSync(p, readFileSync(p, 'utf8') + '{"kind":"fire-req', { flag: 'w' });
  const j2 = new Journal(p, clock.now);
  j2.load();
  assert.equal(j2.all().length, 1);
  assert.equal(j2.badLinesOnLoad, 1);
});

test('post-queue: whole lines only, offset survives restart, rotation by rename + create new', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pq-'));
  const path = join(dir, 'post-queue.jsonl');
  const clock = new FakeClock();
  const seen: PostQueueEntry[] = [];
  const w = new PostQueueWatcher(path, dir, clock.now, async (e) => void seen.push(e), () => undefined);
  appendPostQueue(path, { kind: 'post', channel: 'cao-bots', text: 'hello' });
  writeFileSync(path, readFileSync(path, 'utf8') + '{"kind":"post","chan', 'utf8'); // partial line
  await w.poll();
  assert.equal(seen.length, 1);
  writeFileSync(path, readFileSync(path, 'utf8') + 'nel":"cao-bots","text":"second"}\n', 'utf8');
  const w2 = new PostQueueWatcher(path, dir, clock.now, async (e) => void seen.push(e), () => undefined);
  await w2.poll();
  assert.deepEqual(seen.map((e) => (e.kind === 'post' ? e.text : '')), ['hello', 'second']);
  clock.advance(8 * DAY);
  appendPostQueue(path, { kind: 'fire', cao: 'claude', task: 'build it' });
  await w2.poll();
  assert.equal(seen.length, 3);
  assert.equal(readFileSync(path, 'utf8'), '', 'new file after weekly rotation');
});

test('templates: Appendix A word rule (a standalone em dash is not a word); relay templates are recognised', () => {
  assert.equal(countWords('@Claude CAO — Need your call on the Match Fit email groups before we send. The list is ready.'), 18);
  assert.ok(isRelayTemplate(T.alreadyRunning()));
  assert.ok(!isRelayTemplate('Done with the review, @Muse CAO please check'.replace('Done with', 'Finished')));
});

test('config: placeholders block start', () => {
  const r = loadRegistry();
  // Channel ids are filled from the live workspace (2026-11-25): the shipped registry has no placeholder left.
  assert.equal(placeholdersBlocking(r, 'muse').length, 0);
  const unset = structuredClone(r);
  for (const c of unset.caos) c.channelId = `<CAO_${c.key.toUpperCase().replace('-', '_')}_CHANNEL_ID>`;
  assert.ok(placeholdersBlocking(unset, 'muse').includes('muse.channelId'));
  assert.ok(!placeholdersBlocking(unset, 'gemini').includes('gemini.agentName'), 'agent names set by COUNCIL GATE round 1');
  assert.ok(placeholdersBlocking(unset, 'gemini').includes('gemini.channelId'));
  assert.equal(placeholdersBlocking(testRegistry(), 'muse').length, 0);
});

test('brain rows: terminal rows older than 90 days are exported to the vault archive and marked, once', async () => {
  const { MuseDuties } = await import('../src/sweep.js');
  const clock = new FakeClock();
  const brain = new FakeBrain(clock);
  const reg = testRegistry();
  const row = await brain.insertFireRow({ toAgent: 'MUSE', fromAgent: 'MUSE', toHarness: 'muse', evidence: { v: 0, cao: 'muse', task_hash: 'h', norm_hash: 'n', epoch: 1 }, firedAt: new Date(clock.now()).toISOString() });
  brain.rows.get(row.id)!.status = 'closed';
  brain.rows.get(row.id)!.completed_at = new Date(clock.now()).toISOString();
  clock.advance(91 * DAY);
  const dir = mkdtempSync(join(tmpdir(), 'arch-'));
  const d = new MuseDuties(brain, reg, {} as never, { history: async () => [] }, clock.now, silentLogger, () => undefined, async () => true);
  assert.equal(await d.archiveOldRows(dir), 1);
  assert.equal(await d.archiveOldRows(dir), 0);
});
