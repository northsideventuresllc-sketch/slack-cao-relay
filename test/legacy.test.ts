import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLegacyEnv } from '../src/legacy.js';
import { loadConfig, loadRegistry } from '../src/config.js';

test('legacy env: CAO_RELAY_* wins, CTO_RELAY_* fills the gaps, CTO_RELAY_CTO maps to CAO_RELAY_CAO', () => {
  const out = withLegacyEnv({ CTO_RELAY_CTO: 'claude', CTO_RELAY_TZ: 'UTC', CAO_RELAY_TZ: 'America/Chicago', CTO_RELAY_RUN_DIR: '/run/old' });
  assert.equal(out.CAO_RELAY_CAO, 'claude');
  assert.equal(out.CAO_RELAY_TZ, 'America/Chicago');
  assert.equal(out.CAO_RELAY_RUN_DIR, '/run/old');
});

test('legacy env: loadConfig runs from a pure CTO_RELAY_* environment', () => {
  const cfg = loadConfig({ CTO_RELAY_CTO: 'gemini', CTO_RELAY_STATE_DIR: '/tmp/x', CTO_RELAY_LOG_LEVEL: 'warn' });
  assert.equal(cfg.logLevel, 'warn');
  assert.equal(cfg.stateDir, '/tmp/x');
});

test('legacy env: the old axon-hermes relay key is read as axon', () => {
  assert.equal(withLegacyEnv({ CAO_RELAY_CAO: 'axon-hermes' }).CAO_RELAY_CAO, 'axon');
});

test('registry: CAO agent names, #cao-* channel names, no CTO left', () => {
  const r = loadRegistry();
  assert.deepEqual(r.caos.map((c) => c.agentName), ['MUSE', 'Claude CAO', 'Gemini CAO', 'AXON CAO']);
  assert.deepEqual(r.caos.map((c) => c.channelName), ['cao-muse', 'cao-claude', 'cao-gemini', 'cao-axon']);
  assert.equal(JSON.stringify(r).includes('CTO'), false);
  assert.equal(JSON.stringify(r).includes('cto'), false);
});
