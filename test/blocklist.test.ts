import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Blocklist, containsStartPattern, stripStartPattern, toRealMentions } from '../src/blocklist.js';
import { REPO_ROOT } from '../src/config.js';
import { testRegistry } from './helpers.js';

const bl = Blocklist.fromFile(join(REPO_ROOT, 'config', 'blocklist.json'));
const reg = testRegistry();
// Built at runtime so no key-shaped literal sits in the repo.
const fakeKey = ['xo', 'xb-', '1234567890', '-abcdefghij'].join('');

test('planted secret is caught (key pattern)', () => {
  const hits = bl.check(`here is ${fakeKey} for you`);
  assert.ok(hits.some((h) => h.rule === 'key'));
  assert.ok(!bl.redact(`k ${fakeKey}`).includes(fakeKey));
});

test('emails, ID numbers and money amounts are caught; coordination text is not', () => {
  assert.ok(bl.check('mail me at someone@example.com').length > 0);
  assert.ok(bl.check('ssn 123-45-6789').length > 0);
  assert.ok(bl.check('it costs $1,200').length > 0);
  assert.equal(bl.check('Need your call on the Match Fit email groups before we send. The list is ready.').length, 0);
});

test('post-queue strip removes mention + fire: + task words (plain names and real mentions)', () => {
  const claude = reg.caos.find((c) => c.key === 'claude')!;
  assert.equal(stripStartPattern('hello @Claude CAO fire: deploy now', reg.caos), 'hello');
  assert.equal(stripStartPattern(`ok <@${claude.botUserId}> fire: deploy\nnext line`, reg.caos), 'ok\nnext line');
  assert.ok(!containsStartPattern(stripStartPattern(`<@${claude.botUserId}> FIRE: x`, reg.caos), reg.caos));
});

test('plain names become real mentions (AXON-Hermes CAO wins over shorter names)', () => {
  const ax = reg.caos.find((c) => c.key === 'axon-hermes')!;
  assert.equal(toRealMentions('@AXON-Hermes CAO please', reg.caos), `<@${ax.botUserId}> please`);
});
