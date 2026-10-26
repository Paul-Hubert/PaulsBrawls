import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import test from 'ava';
import { EVAL_BOTS } from '../eval/fixture.js';
import { parseInventorySnbt, splitTopLevelEntries } from '../eval/rcon.js';
import { BROKEN_CODE, FIXED_CODE } from '../eval/scenarios/s7-skill-self-healing.js';
import { TIRED_REFLEX_CODE } from '../eval/scenarios/s11-needs-reflex.js';
import { ledgerHasTrade, parseProperties } from '../eval/util.js';
import { worldSetupCommands } from '../eval/world-setup.js';
import { prepareScript } from '../src/village/sandbox.js';
import { typecheckScript } from '../src/village/skill-typecheck.js';
import { API_DTS } from '../src/village/villager-api.js';

const EVAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'eval');

// ---------------------------------------------------------------------------
// SNBT inventory parsing (the authoritative `data get` assert path)
// ---------------------------------------------------------------------------

test('parseInventorySnbt reads a modern 1.21 data-get response', (t) => {
  const response =
    'EvalMargaux has the following entity data: [{count: 32, Slot: 0b, id: "minecraft:carrot"}, ' +
    '{count: 8, Slot: 1b, id: "minecraft:oak_planks"}, {count: 10, Slot: 2b, id: "paulsbrawls:coin"}]';
  t.deepEqual(parseInventorySnbt(response), { carrot: 32, oak_planks: 8, 'paulsbrawls:coin': 10 });
});

test('parseInventorySnbt sums split stacks and survives components', (t) => {
  const response =
    'X has the following entity data: [' +
    '{count: 64, Slot: 0b, id: "minecraft:carrot"}, ' +
    '{count: 2, Slot: 3b, components: {"minecraft:custom_name": \'{"text":"a,b}{"}\'} , id: "minecraft:carrot"}, ' +
    '{count: 1, Slot: 5b, id: "minecraft:iron_sword", components: {"minecraft:damage": 3}}]';
  t.deepEqual(parseInventorySnbt(response), { carrot: 66, iron_sword: 1 });
});

test('parseInventorySnbt handles legacy Count keys and empty inventories', (t) => {
  t.deepEqual(parseInventorySnbt('X has the following entity data: [{Count: 5b, Slot: 0b, id: "minecraft:bread"}]'), { bread: 5 });
  t.deepEqual(parseInventorySnbt('X has the following entity data: []'), {});
  t.deepEqual(parseInventorySnbt('No entity was found'), {});
});

test('splitTopLevelEntries respects nesting and quoted strings', (t) => {
  const entries = splitTopLevelEntries('{a: [1, 2], b: "x, y"}, {c: {d: 1, e: 2}}, {f: 3}');
  t.is(entries.length, 3);
  t.is(entries[2], '{f: 3}');
});

// ---------------------------------------------------------------------------
// Misc pure helpers
// ---------------------------------------------------------------------------

test('parseProperties reads server.properties shapes', (t) => {
  const props = parseProperties('# comment\nenable-rcon=true\nrcon.port=25575\nrcon.password=hunter2\nempty=\n');
  t.is(props['enable-rcon'], 'true');
  t.is(props['rcon.port'], '25575');
  t.is(props['rcon.password'], 'hunter2');
  t.is(props['empty'], '');
});

test('ledgerHasTrade matches the right pair, recency and items', (t) => {
  const entry = {
    at: 1_000,
    a: 'EvalMargaux',
    b: 'EvalEnclume',
    aGave: [{ item: 'carrot', count: 32 }],
    bGave: [{ item: 'oak_planks', count: 8 }],
  };
  const want = [{ item: 'carrot', count: 32 }, { item: 'oak_planks', count: 8 }];
  t.true(ledgerHasTrade([entry], 500, ['EvalEnclume', 'EvalMargaux'], want), 'direction-agnostic match');
  t.false(ledgerHasTrade([entry], 2_000, ['EvalMargaux', 'EvalEnclume'], want), 'too old');
  t.false(ledgerHasTrade([entry], 500, ['EvalMargaux', 'EvalEcu'], want), 'wrong pair');
  t.false(ledgerHasTrade([entry], 500, ['EvalMargaux', 'EvalEnclume'], [{ item: 'coin', count: 10 }]), 'wrong items');
});

// ---------------------------------------------------------------------------
// Fixture consistency: roster JSON ⇄ fixture constants ⇄ world commands
// ---------------------------------------------------------------------------

test('village.test.json mirrors the fixture constants', (t) => {
  const roster = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'village.test.json'), 'utf8')) as {
    settings: { dataDir: string; heartbeatSeconds: number; llm: { baseUrl: string } };
    bots: Array<{ name: string; role: string; home: object; workstation?: object; chest?: object }>;
  };
  t.is(roster.bots.length, EVAL_BOTS.length);
  for (const [i, fixture] of EVAL_BOTS.entries()) {
    const entry = roster.bots[i];
    t.is(entry.name, fixture.name);
    t.is(entry.role, fixture.role);
    t.deepEqual(entry.home, fixture.home);
    t.deepEqual(entry.workstation, fixture.workstation);
    t.deepEqual(entry.chest, fixture.chest);
  }
  t.is(roster.settings.dataDir, '.village-data-eval');
  t.true(roster.settings.llm.baseUrl.includes('8799'), 'roster points at the mock LLM port');
  // heartbeats are effectively off during evals, and must not overflow setTimeout.
  t.true(roster.settings.heartbeatSeconds * 1_000 * 1.25 < 2 ** 31 - 1);
});

test('eval bot names cannot collide with the God avatar', (t) => {
  for (const bot of EVAL_BOTS) {
    t.not(bot.name, 'LLMBot');
    t.true(bot.name.startsWith('Eval'));
    t.true(bot.name.length <= 16, `${bot.name} exceeds Minecraft's 16-char username limit`);
  }
});

test('world-setup fill commands stay under the 32768-block limit', (t) => {
  const commands = worldSetupCommands();
  t.true(commands.some((c) => c.startsWith('setworldspawn')));
  t.true(commands.some((c) => c.startsWith('forceload add')));
  for (const command of commands) {
    const fill = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(command);
    if (!fill) continue;
    const [x1, y1, z1, x2, y2, z2] = fill.slice(1).map(Number);
    const volume = (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1);
    t.true(volume <= 32_768, `fill too large (${volume}): ${command}`);
  }
});

// ---------------------------------------------------------------------------
// S7's seeded skills go through the REAL validation pipeline
// ---------------------------------------------------------------------------

test('S7 broken skill typechecks and passes AST guards (it must only fail at runtime)', (t) => {
  t.deepEqual(typecheckScript(BROKEN_CODE, API_DTS), []);
  t.true(prepareScript(BROKEN_CODE).ok);
});

test('S7 fixed skill is valid', (t) => {
  t.deepEqual(typecheckScript(FIXED_CODE, API_DTS), []);
  t.true(prepareScript(FIXED_CODE).ok);
});

test("S11 tired reflex typechecks against the 'tired' event contract", (t) => {
  t.deepEqual(typecheckScript(TIRED_REFLEX_CODE, API_DTS), []);
  t.true(prepareScript(TIRED_REFLEX_CODE).ok);
});
