// M7-3 — v1/Eden coexistence parity (R12 identity + R24 port law). These assertions are the executable
// half of docs/17-parity-signoff.md: Eden's roster + avatar can NEVER collide with v1's reserved
// usernames, and Eden's admin port never reuses a v1 876x port while v1 runs. The "run side-by-side"
// check is smoke-time; this pins the choices so a config that WOULD collide is caught in CI.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig, DEFAULT_CONFIG } from '../src/config';
import { V1_RESERVED_NAMES, buildEvalRoster, EVAL_USERNAME_PREFIX } from '../eval/roster';

// v1's reserved ports (R24): 8765 unified, 8766 village admin, 8767 Java settlement. Eden owns 8770.
const V1_RESERVED_PORTS = [8765, 8766] as const; // 8767 is the SHARED stateless settlement (allowed)

test('R12: Eden default avatar (Dieu) does not equal a v1 reserved username', () => {
  assert.ok(!['LLMBot', 'GodBot'].includes(DEFAULT_CONFIG.god.name), 'Dieu must differ from v1 LLMBot/GodBot');
});

test('R12: a config whose god.name collides with a villager is rejected at parse', () => {
  assert.throws(
    () => parseConfig({ villagers: [{ name: 'Dieu', role: 'farmer' }], god: { name: 'Dieu' } }),
    /collides with a villager/,
  );
});

test('R12: a config whose god.name is v1 LLMBot warns (coexistence hazard)', () => {
  const { warnings } = parseConfig({ god: { name: 'LLMBot' }, villagers: [] });
  assert.ok(warnings.some((w) => /LLMBot/.test(w) && /reserved avatar/.test(w)));
});

test('R24: Eden default admin port is 8770 and never reuses a v1 876x port', () => {
  assert.equal(DEFAULT_CONFIG.admin.port, 8770);
  assert.ok(!V1_RESERVED_PORTS.includes(DEFAULT_CONFIG.admin.port as 8765), 'admin must not reuse v1 8765/8766');
});

test('R24: the settlement url targets the SHARED stateless :8767 (per-request, not a held port)', () => {
  assert.match(DEFAULT_CONFIG.settlement.url, /:8767\//, 'settlement is the shared Java listener (R24)');
});

test('R12: the eval roster is namespaced away from BOTH v1 and Eden-production usernames', () => {
  const roster = buildEvalRoster(3);
  const all = [...roster.villagers.map((v) => v.name), roster.god.name];
  for (const n of all) {
    assert.ok(n.startsWith(EVAL_USERNAME_PREFIX), `${n} must carry the eval prefix`);
    assert.ok(!V1_RESERVED_NAMES.includes(n), `${n} collides with a reserved production name (R12)`);
    assert.ok(n !== DEFAULT_CONFIG.god.name, `${n} must not equal Eden's production avatar`);
  }
});
