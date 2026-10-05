// CI scaffold check for the LIVE scenario suite (live-tests/) — mirrors tests/eval-harness.test.ts. The
// live scenarios themselves need a running dev server + a paid API key and are NEVER run in CI; what IS
// CI-checkable is their STRUCTURE: unique kebab names, every task assignee present in the scenario's
// roster, idempotent (absolute) arena commands, and a roster that assembles into a VALID Eden config
// (no R12 identity collision with the avatar). This catches a typo'd assignee or a duplicate name before
// anyone burns a five-minute live run on it. No host boots and no socket opens here (the catalogue import
// is side-effect-free).

import test from 'node:test';
import assert from 'node:assert/strict';

import { SCENARIOS, scenarioAssignees } from '../live-tests/catalogue';
import { baseConfig, loadProviders, exampleProvidersPath } from '../live-tests/config';
import { parseConfig } from '../src/config';

const KEBAB = /^[a-z][a-z0-9-]*$/;
// Bug #4: validate against the COMMITTED presets, never the user's gitignored eden/providers.json — so the
// check runs (and passes) on a clean checkout.
const EXAMPLE_PROVIDERS = loadProviders(exampleProvidersPath());
const STUB_PROPS = { mcPort: 25599, rconHost: '127.0.0.1', rconPort: 25575, rconPassword: 'x' };

test('catalogue: scenario names are unique kebab-case', () => {
  const names = SCENARIOS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, 'scenario names must be unique');
  for (const n of names) assert.ok(KEBAB.test(n), `"${n}" is not kebab-case`);
});

test('catalogue: every scenario has a roster, tasks, an arena, and a positive timeout', () => {
  for (const s of SCENARIOS) {
    assert.ok(s.roster.length > 0, `${s.name}: empty roster`);
    assert.ok(s.tasks.length > 0, `${s.name}: no tasks`);
    assert.ok(s.arena.length > 0, `${s.name}: empty arena`);
    assert.ok(s.timeoutMs > 0, `${s.name}: non-positive timeout`);
  }
});

test('catalogue: every task assignee is a villager in its scenario roster', () => {
  for (const s of SCENARIOS) {
    const roster = new Set(s.roster.map((v) => v.name));
    for (const t of s.tasks) {
      assert.ok(t.assignee, `${s.name}: a task has no assignee`);
      assert.ok(roster.has(t.assignee!), `${s.name}: assignee "${t.assignee}" is not in the roster`);
    }
    // requiredBots, when set, must also be rostered.
    for (const b of s.requiredBots ?? []) {
      assert.ok(roster.has(b), `${s.name}: requiredBot "${b}" is not in the roster`);
    }
  }
});

test('catalogue: every task carrying an objective check has a positive count', () => {
  for (const s of SCENARIOS) {
    for (const t of s.tasks) {
      if (t.check) {
        assert.ok(t.check.item.length > 0 && t.check.count > 0, `${s.name}: bad check ${JSON.stringify(t.check)}`);
      }
    }
  }
});

test('catalogue: arena commands are absolute (no ~/^ relative coords) — re-applicable before each boot', () => {
  for (const s of SCENARIOS) {
    for (const cmd of s.arena) {
      assert.ok(!/[~^]/.test(cmd), `${s.name}: arena command is not absolute: "${cmd}"`);
    }
  }
});

test('catalogue: each roster assembles into a valid Eden config (no R12 avatar collision)', () => {
  for (const s of SCENARIOS) {
    const config = (s.configure ?? ((c) => c))(baseConfig(STUB_PROPS, s.roster, undefined, EXAMPLE_PROVIDERS));
    // parseConfig throws on a duplicate villager name or a god/villager name collision (R12).
    assert.doesNotThrow(() => parseConfig(config), `${s.name}: roster does not assemble into a valid config`);
    assert.ok(!s.roster.some((v) => v.name === config.god.name), `${s.name}: a villager collides with the avatar`);
  }
});

test('catalogue: scenarioAssignees returns the distinct task assignees', () => {
  for (const s of SCENARIOS) {
    const got = scenarioAssignees(s).sort();
    const want = [...new Set(s.tasks.map((t) => t.assignee))].sort();
    assert.deepEqual(got, want);
  }
});
