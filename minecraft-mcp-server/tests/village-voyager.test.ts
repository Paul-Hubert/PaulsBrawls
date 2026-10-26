import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Bot } from 'mineflayer';
import type { VillageContext } from '../src/village/context.js';
import { BotMemory } from '../src/village/memory.js';
import { Persistence } from '../src/village/persistence.js';
import { evaluateSuccessCheck } from '../src/village/routines.js';
import { compileScript, CycleBudget, prepareScript } from '../src/village/sandbox.js';
import { SkillLibrary } from '../src/village/skill-library.js';
import { typecheckScript } from '../src/village/skill-typecheck.js';
import { API_DTS, buildScriptGlobals } from '../src/village/villager-api.js';
import type { Villager } from '../src/village/villager.js';

/**
 * M13 — the Voyager stack: skill retrieval into the prompt, composition via
 * invokeSkill (through the REAL sandbox pipeline), and declarative job
 * self-verification.
 */

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'village-voyager-'));
}

function makeSkills(): SkillLibrary {
  const skills = new SkillLibrary('Caillou', new Persistence(tempDir()));
  skills.upsert({ name: 'mine-loop', kind: 'routine', description: 'Quarry stone and ores near the workstation', code: 'await sleep(10);' });
  skills.upsert({ name: 'craft-pickaxe', kind: 'routine', description: 'Craft a pickaxe from banked materials', code: 'await sleep(10);' });
  skills.upsert({ name: 'self-defense', kind: 'reflex', description: 'Fight back or flee when attacked', code: "bot.on('hurt', async (e) => {});" });
  return skills;
}

// -- retrieval ------------------------------------------------------------------

test('relevantSkills ranks by token overlap with the situation', (t) => {
  const skills = makeSkills();
  const relevant = skills.relevantSkills('je dois craft une pickaxe pour la mine', 2);
  t.true(relevant.has('craft-pickaxe'));
  t.true(relevant.has('mine-loop'));
  t.false(relevant.has('self-defense'));
  t.deepEqual(skills.relevantSkills('', 4), new Set(), 'empty query → nothing');
});

test('promptBlock shows code only for relevant + disabled skills', (t) => {
  const skills = makeSkills();
  for (let i = 0; i < 3; i++) skills.recordError('craft-pickaxe', 'kaput');

  const block = skills.promptBlock('routine', new Set(['mine-loop']));
  const [mineEntry, craftEntry] = block.split('\n\n');
  t.true(mineEntry.includes('```js'), 'relevant skill carries its code');
  t.true(craftEntry.includes('DISABLED'), 'breaker state visible');
  t.true(craftEntry.includes('```js'), 'disabled skill carries its code (you fix what you can see)');

  const slim = skills.promptBlock('routine', new Set());
  t.true(slim.includes('mine-loop — Quarry'), 'one-liner kept');
  t.false(slim.split('\n\n')[0].includes('```js'), 'irrelevant active skill has no code');

  t.true(skills.promptBlock('routine').includes('```js'), 'no set → pre-M13 behavior, code for all');
});

// -- composition: invokeSkill through the real pipeline -----------------------------

interface ComposeWorld {
  villager: Villager;
  ctx: VillageContext;
  memory: BotMemory;
  run: (code: string) => Promise<void>;
}

function composeWorld(): ComposeWorld {
  const dir = tempDir();
  const persistence = new Persistence(dir);
  const memory = new BotMemory('Caillou', persistence);
  const skills = new SkillLibrary('Caillou', persistence);
  const villager = {
    name: 'Caillou',
    roster: { name: 'Caillou', role: 'miner', personality: 't', home: { x: 0, y: 64, z: 0 } },
    memory,
    skills,
    bot: () => null,
    runExclusive: <T>(fn: () => Promise<T>) => fn(),
    villagersInEarshot: () => [],
    mirrorChat: () => { /* noop */ },
  } as unknown as Villager;
  const ctx = { villagers: new Map(), villagerNames: new Set(), scheduler: { request: () => {} } } as unknown as VillageContext;

  const run = async (code: string): Promise<void> => {
    const prepared = prepareScript(code);
    if (!prepared.ok) throw new Error(prepared.errors.join('; '));
    const budget = new CycleBudget();
    const globals = buildScriptGlobals(villager, ctx, { mode: 'live', budget });
    await compileScript(prepared.instrumented)(globals, budget);
  };
  return { villager, ctx, memory, run };
}

test('invokeSkill runs another routine inline, in order', async (t) => {
  const w = composeWorld();
  w.villager.skills.upsert({ name: 'inner', kind: 'routine', description: 'inner step', code: "bot.remember('inner ran');" });
  await w.run("await bot.invokeSkill('inner');\nbot.remember('outer done');");
  t.deepEqual(w.memory.recent(2).map((m) => m.text), ['inner ran', 'outer done']);
});

test('invokeSkill enforces the depth cap and rejects reflexes/disabled/missing skills', async (t) => {
  const w = composeWorld();
  w.villager.skills.upsert({ name: 'c', kind: 'routine', description: 'leaf', code: "bot.remember('leaf');" });
  w.villager.skills.upsert({ name: 'b', kind: 'routine', description: 'mid', code: "await bot.invokeSkill('c');" });
  w.villager.skills.upsert({ name: 'a', kind: 'routine', description: 'top', code: "await bot.invokeSkill('b');" });

  // top-level → a (depth1) → b (depth2) → c would be depth 3 → cap.
  await t.throwsAsync(() => w.run("await bot.invokeSkill('a');"), { message: /depth cap/ });
  // One level shallower works: b → c.
  await t.notThrowsAsync(() => w.run("await bot.invokeSkill('b');"));
  t.is(w.memory.recent(1)[0].text, 'leaf');

  w.villager.skills.upsert({ name: 'reflexe', kind: 'reflex', description: 'r', code: "bot.on('hurt', async (e) => {});" });
  await t.throwsAsync(() => w.run("await bot.invokeSkill('reflexe');"), { message: /only routines/ });
  await t.throwsAsync(() => w.run("await bot.invokeSkill('ghost');"), { message: /no skill named/ });

  for (let i = 0; i < 3; i++) w.villager.skills.recordError('c', 'kaput');
  await t.throwsAsync(() => w.run("await bot.invokeSkill('c');"), { message: /disabled/ });
});

test('invokeSkill typechecks against the published API and is register-mode-forbidden', async (t) => {
  t.deepEqual(typecheckScript("await bot.invokeSkill('mine-loop');", API_DTS), [], 'DTS knows invokeSkill');
  t.true(typecheckScript('await bot.invokeSkill(42);', API_DTS).length > 0, 'bad arg type rejected');

  const w = composeWorld();
  const prepared = prepareScript("await bot.invokeSkill('x');");
  if (!prepared.ok) throw new Error('prepare failed');
  const budget = new CycleBudget();
  const globals = buildScriptGlobals(w.villager, w.ctx, { mode: 'register', budget, registrar: () => {} });
  await t.throwsAsync(() => compileScript(prepared.instrumented)(globals, budget), { message: /not allowed at the top level/ });
});

// -- self-verification ----------------------------------------------------------------

function botWith(items: Array<{ name: string; count: number }>): Bot {
  return { inventory: { items: () => items } } as unknown as Bot;
}

test('evaluateSuccessCheck verdicts: met, missed, offline, none', (t) => {
  const check = { item: 'iron_pickaxe', count: 2 };
  t.regex(
    evaluateSuccessCheck(botWith([{ name: 'iron_pickaxe', count: 2 }]), check)!,
    /OBJECTIF ATTEINT: 2x iron_pickaxe/
  );
  t.regex(
    evaluateSuccessCheck(botWith([{ name: 'iron_pickaxe', count: 1 }]), check)!,
    /OBJECTIF MANQUÉ: voulu 2x iron_pickaxe, j'en ai 1/
  );
  t.regex(evaluateSuccessCheck(null, check)!, /invérifiable/);
  t.is(evaluateSuccessCheck(botWith([]), undefined), null);

  // Substring match counts variants (e.g. 'pickaxe' matches any pickaxe).
  t.regex(
    evaluateSuccessCheck(botWith([{ name: 'stone_pickaxe', count: 1 }]), { item: 'pickaxe', count: 1 })!,
    /ATTEINT/
  );
});
