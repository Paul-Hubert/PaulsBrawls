import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkScript, REFERENCE_FILE } from '../src/script/check';
import { SCOPE_NAMES } from '../src/script/compile';
import { HELPERS } from '../src/api/helpers';
import { loadStock, stockFiles } from '../src/stock';

test('every stock command passes check_script with no error and no warning', { timeout: 120_000 }, async () => {
  for (const { name, source } of stockFiles()) {
    const r = await checkScript(source, { maxLines: 400 });
    assert.deepEqual(r.diagnostics, [], `${name}: ${JSON.stringify(r.diagnostics, null, 1)}`);
    assert.ok(r.manifest?.summary, name);
  }
});

test('the stock commands load (manifest summaries)', async () => {
  const stock = await loadStock();
  assert.ok(stock.defend && stock.gather && stock.come && stock.follow);
  assert.match(stock.defend!.summary, /archers/);
});

test('a misspelt mineflayer method, an unknown helper and a wrong arity block a submission', { timeout: 60_000 }, async () => {
  const r = await checkScript(`export const manifest = { summary: 'x' };
export default async function (squad, args, ctx) {
  for (const bot of squad.bots) { await bot.digBlock(1); await mineBlok(bot, 'stone'); bot.chat(); }
}`);
  assert.equal(r.ok, false);
  const codes = r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
  assert.deepEqual(codes.sort(), [2339, 2552, 2554]);
  assert.ok(r.diagnostics.every((d) => d.line === 3));
});

test('a bad manifest and a missing default export are reported', async () => {
  const r = await checkScript(`export const manifest = { summary: 'x', roles: { a: { take: 'steal' } } };`, { typecheck: false });
  assert.equal(r.ok, false);
  assert.match(r.diagnostics.map((d) => d.message).join('\n'), /take: "free" or "reclaim"/);
  const r2 = await checkScript(`export const manifest = { summary: 'x' };`, { typecheck: false });
  assert.match(r2.diagnostics.map((d) => d.message).join('\n'), /missing `export default/);
});

test('top-level code that calls a helper is refused', async () => {
  const r = await checkScript(`goTo(null, [0,0,0]);\nexport const manifest = { summary: 'x' };\nexport default async () => 1;`, { typecheck: false });
  assert.match(r.diagnostics[0]?.message ?? '', /goTo\(\) was called at the module top level/);
});

test('the size cap', async () => {
  const r = await checkScript(`export const manifest = { summary: 'x' };\nexport default async () => 1;\n` + '\n'.repeat(500), { typecheck: false, maxLines: 400 });
  assert.equal(r.ok, false);
});

test('the reference declares every scope global and every helper', () => {
  const ref = readFileSync(REFERENCE_FILE, 'utf8');
  for (const name of SCOPE_NAMES) {
    if (name.startsWith('__') || name === 'require') continue;
    assert.match(ref, new RegExp(`(function|const|class) ${name}\\b`), `squad.d.ts does not declare ${name}`);
  }
  for (const name of Object.keys(HELPERS)) assert.match(ref, new RegExp(`function ${name}\\b`), name);
});
