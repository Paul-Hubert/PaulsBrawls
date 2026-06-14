import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { cruise } from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';

async function cruiseSrc(): Promise<{ error: number; violations: any[] }> {
  const config = await extractDepcruiseConfig(resolve('.dependency-cruiser.cjs'));
  const result = await cruise(['src'], { ...(config as any).options, ruleSet: config, validate: true });
  const out: any = result.output;
  const summary = typeof out === 'string' ? JSON.parse(out).summary : out.summary;
  return { error: summary.error, violations: summary.violations };
}

test('the real src tree obeys the dependency law (zero violations)', async () => {
  const { error, violations } = await cruiseSrc();
  assert.equal(error, 0, `expected no violations, got: ${JSON.stringify(violations, null, 2)}`);
});

test('a planted upward import (types/ -> journal/) FAILS the law', async () => {
  const planted = resolve('src/types/__planted_violation__.ts');
  writeFileSync(
    planted,
    [
      "import { Journal } from '../journal/journal';",
      'export type Bad = Journal;',
      'export const _bad = Journal;',
      '',
    ].join('\n'),
  );
  try {
    const { error, violations } = await cruiseSrc();
    assert.ok(error > 0, 'dependency-cruiser must flag the upward import');
    assert.ok(
      violations.some((v: { rule: { name: string } }) => v.rule.name === 'types-imports-nothing'),
      `expected a types-imports-nothing violation, got: ${JSON.stringify(violations.map((v: any) => v.rule.name))}`,
    );
  } finally {
    rmSync(planted, { force: true });
  }
});
