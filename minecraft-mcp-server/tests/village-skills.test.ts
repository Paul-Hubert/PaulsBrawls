import test from 'ava';
import { prepareScript } from '../src/village/sandbox.js';
import { typecheckScript } from '../src/village/skill-typecheck.js';
import { STOCK_SKILLS } from '../src/village/stock-skills.js';
import { API_DTS } from '../src/village/villager-api.js';

// The stock skills are the pipeline's permanent integration test: they are
// real villager scripts and MUST pass the exact validation the bots' own
// code goes through. If one of these fails, every villager boots degraded.

for (const skill of STOCK_SKILLS) {
  test(`stock skill '${skill.name}' typechecks against the API`, (t) => {
    const errors = typecheckScript(skill.code, API_DTS);
    t.deepEqual(errors, [], errors.join('\n'));
  });

  test(`stock skill '${skill.name}' passes guard instrumentation`, (t) => {
    const result = prepareScript(skill.code);
    t.true(result.ok, result.ok ? '' : result.errors.join('; '));
  });
}

test('typecheck catches calls to nonexistent API methods', (t) => {
  const errors = typecheckScript('bot.flyToTheMoon(1);', API_DTS);
  t.true(errors.length > 0);
  t.regex(errors.join(' '), /flyToTheMoon/);
});

test('typecheck catches bad event names via the on() overloads', (t) => {
  const errors = typecheckScript("bot.on('full-moon', async (e) => {});", API_DTS);
  t.true(errors.length > 0);
});

test('typecheck accepts a well-formed reflex', (t) => {
  const code = `bot.on('hurt', async (e) => {
  if (e.attacker && e.attacker.kind === 'hostile') {
    await bot.flee(e.attacker.position, 10);
    bot.think('I was attacked', 'high');
  }
});`;
  const errors = typecheckScript(code, API_DTS);
  t.deepEqual(errors, [], errors.join('\n'));
});

test('typecheck accepts top-level await routines', (t) => {
  const code = `const me = bot.self();
await bot.goTo(me.home.x, me.home.y, me.home.z, 2);
await sleep(1000);
bot.remember('went home');`;
  const errors = typecheckScript(code, API_DTS);
  t.deepEqual(errors, [], errors.join('\n'));
});
