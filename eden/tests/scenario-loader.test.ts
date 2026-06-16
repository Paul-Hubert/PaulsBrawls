import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadScenario, applyScenario } from '../src/scenario-loader';
import { parseConfig, DEFAULT_CONFIG, assertIdentity } from '../src/config';

// ── helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
function writeTmp(name: string, content: object): string {
  const p = join(tmpDir, name);
  writeFileSync(p, JSON.stringify(content));
  return p;
}

const BASE_CONFIG = parseConfig({
  minecraft: { host: '127.0.0.1', port: 25599, version: '1.21.1' },
  villagers: [],
  god: { name: 'Dieu' },
}).config;

test.before(() => {
  tmpDir = join(tmpdir(), `eden-scenario-test-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
});
test.after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

// ── loadScenario ─────────────────────────────────────────────────────────────

test('parses name and description', () => {
  const path = writeTmp('basic.json', {
    name: 'farming-hamlet',
    description: 'Hameau agricole',
    villagers: {},
  });
  const result = loadScenario(path);
  assert.equal(result.name, 'farming-hamlet');
  assert.equal(result.description, 'Hameau agricole');
});

test('converts villager dict to VillagerConfig[] with name injected', () => {
  const path = writeTmp('villagers.json', {
    name: 'test',
    description: '',
    villagers: {
      Firmin: { role: 'farmer' },
      Bertrand: { role: 'guard' },
    },
  });
  const { villagers } = loadScenario(path);
  assert.equal(villagers.length, 2);
  const firmin = villagers.find((v) => v.name === 'Firmin');
  assert.ok(firmin);
  assert.equal(firmin.role, 'farmer');
});

test('threads persona through to VillagerConfig', () => {
  const path = writeTmp('persona.json', {
    name: 'test',
    description: '',
    villagers: {
      Firmin: {
        role: 'farmer',
        persona: 'Tu es Firmin, un fermier.',
      },
    },
  });
  const { villagers } = loadScenario(path);
  assert.equal(villagers[0]?.persona, 'Tu es Firmin, un fermier.');
});

test('threads items through to VillagerConfig', () => {
  const path = writeTmp('items.json', {
    name: 'test',
    description: '',
    villagers: {
      Firmin: {
        role: 'farmer',
        items: [
          { id: 'minecraft:iron_hoe', count: 1 },
          { id: 'minecraft:bread', count: 10 },
        ],
      },
    },
  });
  const { villagers } = loadScenario(path);
  assert.deepEqual(villagers[0]?.items, [
    { id: 'minecraft:iron_hoe', count: 1 },
    { id: 'minecraft:bread', count: 10 },
  ]);
});

test('generates RCON /give setup commands for items', () => {
  const path = writeTmp('give.json', {
    name: 'test',
    description: '',
    villagers: {
      Firmin: {
        role: 'farmer',
        items: [
          { id: 'minecraft:iron_hoe', count: 1 },
          { id: 'minecraft:bread', count: 10 },
        ],
      },
    },
  });
  const { setupCommands } = loadScenario(path);
  assert.deepEqual(setupCommands, [
    'give Firmin minecraft:iron_hoe 1',
    'give Firmin minecraft:bread 10',
  ]);
});

test('generates no setup commands when no items', () => {
  const path = writeTmp('noitems.json', {
    name: 'test', description: '',
    villagers: { Firmin: { role: 'farmer' } },
  });
  const { setupCommands } = loadScenario(path);
  assert.deepEqual(setupCommands, []);
});

test('filters item stacks with empty id', () => {
  const path = writeTmp('baditem.json', {
    name: 'test', description: '',
    villagers: {
      Firmin: {
        role: 'farmer',
        items: [{ id: '', count: 5 }, { id: 'minecraft:bread', count: 3 }],
      },
    },
  });
  const { villagers, setupCommands } = loadScenario(path);
  assert.equal(villagers[0]?.items?.length, 1);
  assert.equal(setupCommands.length, 1);
  assert.equal(setupCommands[0], 'give Firmin minecraft:bread 3');
});

test('parses god overrides', () => {
  const path = writeTmp('god.json', {
    name: 'test', description: '',
    god: { combineDesks: true, embodiedVerdicts: false, authoring: 'god' },
    villagers: {},
  });
  const { god } = loadScenario(path);
  assert.equal(god.combineDesks, true);
  assert.equal(god.embodiedVerdicts, false);
  assert.equal(god.authoring, 'god');
});

test('parses god.godPrompt and threads it through applyScenario', () => {
  const path = writeTmp('godprompt.json', {
    name: 'test', description: '',
    god: { godPrompt: 'Focus on farming first.' },
    villagers: {},
  });
  const { god } = loadScenario(path);
  assert.equal(god.godPrompt, 'Focus on farming first.');
  const cfg = applyScenario(BASE_CONFIG, loadScenario(path));
  assert.equal(cfg.god.godPrompt, 'Focus on farming first.');
});

test('godPrompt absent when not set', () => {
  const path = writeTmp('nogodprompt.json', {
    name: 'test', description: '',
    god: { combineDesks: true },
    villagers: {},
  });
  const { god } = loadScenario(path);
  assert.equal(god.godPrompt, undefined);
});

test('god overrides are empty object when god section absent', () => {
  const path = writeTmp('nogod.json', { name: 'test', description: '', villagers: {} });
  const { god } = loadScenario(path);
  assert.deepEqual(god, {});
});

test('empty villagers dict produces empty array', () => {
  const path = writeTmp('empty.json', { name: 'test', description: '', villagers: {} });
  const { villagers } = loadScenario(path);
  assert.deepEqual(villagers, []);
});

// ── applyScenario ────────────────────────────────────────────────────────────

test('applyScenario replaces villagers and merges god overrides', () => {
  const path = writeTmp('apply.json', {
    name: 'apply-test',
    description: '',
    god: { combineDesks: true },
    villagers: {
      Firmin: { role: 'farmer', home: [1, 64, 2], chest: [3, 64, 4] },
    },
  });
  const scenario = loadScenario(path);
  const cfg = applyScenario(BASE_CONFIG, scenario);
  assert.equal(cfg.villagers.length, 1);
  assert.equal(cfg.villagers[0]?.name, 'Firmin');
  assert.equal(cfg.god.combineDesks, true);
  // Unchanged sections come from base
  assert.equal(cfg.admin.port, DEFAULT_CONFIG.admin.port);
  assert.equal(cfg.god.name, 'Dieu');
});

test('applyScenario: god.name override replaces base god name', () => {
  const path = writeTmp('godname.json', {
    name: 'test', description: '',
    god: { name: 'Zeus' },
    villagers: {},
  });
  const cfg = applyScenario(BASE_CONFIG, loadScenario(path));
  assert.equal(cfg.god.name, 'Zeus');
});

// ── R12 identity (the scenario path replaces the roster AFTER parseConfig validated it) ──────────────

test('R12: a scenario villager colliding with god.name is rejected by assertIdentity', () => {
  // god.name defaults to "Dieu"; a villager keyed "Dieu" would kick the avatar at login (R12).
  const path = writeTmp('collide.json', {
    name: 'collide', description: '',
    villagers: { Dieu: { role: 'farmer' }, Margot: { role: 'farmer' } },
  });
  const merged = applyScenario(BASE_CONFIG, loadScenario(path));
  assert.throws(
    () => assertIdentity(merged.villagers, merged.god.name),
    /god\.name "Dieu" collides with a villager username \(R12\)/,
  );
});

test('R12: duplicate villager names are rejected by assertIdentity', () => {
  // A scenario dict can't express dup keys, but assertIdentity is the shared guard for any roster source.
  assert.throws(
    () => assertIdentity([{ name: 'Firmin' }, { name: 'Firmin' }], 'Dieu'),
    /duplicate villager name "Firmin".*\(R12\)/,
  );
});

test('R12: a clean scenario roster passes assertIdentity', () => {
  const merged = applyScenario(BASE_CONFIG, loadScenario(writeTmp('clean.json', {
    name: 'clean', description: '',
    villagers: { Firmin: { role: 'farmer' }, Margot: { role: 'guard' } },
  })));
  assert.doesNotThrow(() => assertIdentity(merged.villagers, merged.god.name));
});

// ── shipped scenario files ────────────────────────────────────────────────────

test('farming-hamlet.json is valid and has 3 villagers', () => {
  const scenarioPath = fileURLToPath(new URL('../scenarios/farming-hamlet.json', import.meta.url));
  const result = loadScenario(scenarioPath);
  assert.equal(result.name, 'farming-hamlet');
  assert.equal(result.villagers.length, 3);
  assert.ok(result.villagers.every((v) => v.persona));
  assert.ok(result.setupCommands.length > 0);
});

test('mining-crew.json is valid and has 3 villagers', () => {
  const scenarioPath = fileURLToPath(new URL('../scenarios/mining-crew.json', import.meta.url));
  const result = loadScenario(scenarioPath);
  assert.equal(result.name, 'mining-crew');
  assert.equal(result.villagers.length, 3);
});

test('trading-post.json is valid and has 3 villagers', () => {
  const scenarioPath = fileURLToPath(new URL('../scenarios/trading-post.json', import.meta.url));
  const result = loadScenario(scenarioPath);
  assert.equal(result.name, 'trading-post');
  assert.equal(result.villagers.length, 3);
});
