import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { parseConfig, loadConfig, DEFAULT_CONFIG } from '../src/config';

function minimal(): Record<string, unknown> {
  return {
    minecraft: { host: '127.0.0.1', port: 25599, version: '1.21.1' },
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    god: { name: 'Dieu' },
  };
}

test('parses a minimal config and fills defaults', () => {
  const { config, warnings } = parseConfig(minimal());
  assert.equal(config.god.name, 'Dieu');
  assert.equal(config.admin.port, DEFAULT_CONFIG.admin.port);
  assert.equal(config.llm.maxConcurrent, 3);
  assert.equal(config.skills.stallSeconds, 20);
  assert.equal(config.skills.maxSkillLines, 400);
  assert.equal(config.journal.vitalsIntervalSeconds, 10);
  // G1: retention has no key yet — hardcoded default 7 days.
  assert.equal(config.journal.retentionDays, 7);
  assert.deepEqual(warnings, []);
});

test('D-11/R47: warns when the strong tier budget is below the reserve floor (declared M0-3, active M3)', () => {
  const raw = minimal();
  raw['llm'] = { providers: { strong: { baseUrl: 'x', model: 'y', inputTokenBudget: 5000 } } };
  raw['skills'] = { maxSkillLines: 400 };
  const { warnings } = parseConfig(raw);
  assert.ok(
    warnings.some((w) => w.includes('reserve floor') && w.includes('R47')),
    `expected a reserve-invariant warning, got: ${JSON.stringify(warnings)}`,
  );
});

test('D-11/R47: the default strong budget (48k) satisfies the reserve floor — no warning', () => {
  const { warnings } = parseConfig(minimal());
  assert.ok(!warnings.some((w) => w.includes('reserve floor')), 'default 48k is comfortably above the floor');
});

test('warns on an unknown key (R22) but does not throw', () => {
  const raw = minimal();
  (raw['skills'] as Record<string, unknown>) = { stallSeconds: 20, wat: true };
  const { warnings } = parseConfig(raw);
  assert.ok(
    warnings.some((w) => w.includes('wat')),
    `expected an unknown-key warning mentioning "wat", got: ${JSON.stringify(warnings)}`,
  );
});

// B3.8: combineDesks was parsed but never read — removed. An old config that still sets it gets the R22 warning.
test('B3.8: god.combineDesks is no longer a config key — it warns and is dropped', () => {
  const raw = minimal();
  raw['god'] = { name: 'Dieu', combineDesks: true };
  const { config, warnings } = parseConfig(raw);
  assert.ok(warnings.some((w) => w === 'config: unknown key god.combineDesks ignored (R22)'), JSON.stringify(warnings));
  assert.equal('combineDesks' in config.god, false);
});

// B4: the R33 trade reach was a hard-coded 8 in main.ts; the mod's maxTradeDistance is configurable.
test('B4: settlement.reach must be positive and strictly below settlement.maxTradeDistance', () => {
  const ok = minimal();
  ok['settlement'] = { reach: 10, maxTradeDistance: 24 };
  const { config, warnings } = parseConfig(ok);
  assert.equal(config.settlement.reach, 10);
  assert.equal(config.settlement.maxTradeDistance, 24);
  assert.deepEqual(warnings, []);
  for (const bad of [{ reach: 16 }, { reach: 20, maxTradeDistance: 16 }, { reach: 0 }, { reach: -3 }, { reach: 6, maxTradeDistance: 6 }]) {
    const raw = minimal();
    raw['settlement'] = bad;
    assert.throws(() => parseConfig(raw), /settlement\.reach/, JSON.stringify(bad));
  }
});

test('adopts a known alias and warns (R22)', () => {
  const raw = minimal();
  raw['llm'] = { maxConcurrency: 5, perVillagerCooldownSec: 30 };
  const { config, warnings } = parseConfig(raw);
  assert.equal(config.llm.maxConcurrent, 5, 'maxConcurrency adopted as maxConcurrent');
  assert.equal(config.llm.perVillagerCooldownSeconds, 30);
  assert.ok(warnings.some((w) => /maxConcurrency.*maxConcurrent/.test(w)));
});

test('rejects god.name colliding with a villager name (R12)', () => {
  const raw = minimal();
  (raw['god'] as Record<string, unknown>)['name'] = 'Firmin';
  assert.throws(() => parseConfig(raw), /Firmin/);
});

test('rejects duplicate villager names (R12)', () => {
  const raw = minimal();
  raw['villagers'] = [
    { name: 'Firmin', role: 'farmer' },
    { name: 'Firmin', role: 'miner' },
  ];
  assert.throws(() => parseConfig(raw), /Firmin/);
});

test('warns on a Minecraft version other than the 1.21.1 pin (R11)', () => {
  const raw = minimal();
  (raw['minecraft'] as Record<string, unknown>)['version'] = '1.20.4';
  const { warnings } = parseConfig(raw);
  assert.ok(warnings.some((w) => w.includes('1.21.1')));
});

test('warns if the avatar reuses v1 reserved username LLMBot', () => {
  const raw = minimal();
  (raw['god'] as Record<string, unknown>)['name'] = 'LLMBot';
  const { warnings } = parseConfig(raw);
  assert.ok(warnings.some((w) => w.includes('LLMBot')));
});

test('the shipped eden.example.json validates with zero warnings', () => {
  const examplePath = fileURLToPath(new URL('../eden.example.json', import.meta.url));
  const warnings: string[] = [];
  const config = loadConfig(examplePath, (w) => warnings.push(w));
  assert.deepEqual(warnings, [], `expected zero warnings, got: ${JSON.stringify(warnings)}`);
  assert.equal(config.minecraft.version, '1.21.1');
  assert.equal(config.god.name, 'Dieu');
  assert.equal(config.scenario, 'farming-hamlet');
  assert.equal(config.provider, 'openai');
  assert.equal(config.admin.port, 8770);
  // villagers is empty at loadConfig time — resolution happens in main.ts after providers + scenario load
  assert.deepEqual(config.villagers, []);
});

test('golden: a fully-defaulted validated config object', () => {
  const { config } = parseConfig(minimal());
  assert.deepEqual(config, {
    minecraft: { host: '127.0.0.1', port: 25599, version: '1.21.1' },
    scenario: undefined,
    provider: undefined,
    apiKeyEnv: undefined,
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    god: {
      name: 'Dieu',
      gamemode: 'creative',
      authoring: 'villager',
      desks: {
        critic: { model: 'strong' },
        curriculum: { model: 'strong' },
        orchestrator: { model: 'fast' },
      },
      budget: {
        perDesk: {
          critic: { dailyTokens: null },
          curriculum: { dailyTokens: null },
          orchestrator: { dailyTokens: null },
        },
        degradeOnBreach: true,
      },
      embodiedVerdicts: true,
    },
    behavior: { drives: false },
    llm: {
      providers: {
        strong: { baseUrl: '', model: '', inputTokenBudget: 48000 },
        fast: { baseUrl: '', model: '', inputTokenBudget: 16000 },
      },
      maxConcurrent: 3,
      perVillagerCooldownSeconds: 15,
    },
    skills: {
      runDefaultTimeoutMs: 120000,
      stallSeconds: 20,
      maxCallDepth: 8,
      maxSkillLines: 400,
      probationRuns: 3,
      autoQuarantineAfter: 5,
    },
    // B4: reach + maxTradeDistance are new keys (the golden grows deliberately).
    settlement: { url: 'http://127.0.0.1:8767/trade/execute', reach: 8, maxTradeDistance: 16 },
    admin: { port: 8770 },
    journal: { vitalsIntervalSeconds: 10, debugPrompts: false, retentionDays: 7 },
  });
});
