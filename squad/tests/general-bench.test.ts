// The General's benchmark (docs/45 §4): the same 20 v 20 battle (tests/fakes/battle.ts) under two doctrines, scored by
// numbers: seconds from contact to each squad's first order, idle bot-seconds, kills per loss.
//   • "before": what lost on 2026-11-05: no standing orders, a 15 s model turn, and on contact one `line` for every
//     squad on the army's centre facing the enemy (the cavalry on the wall's flanks), then nothing.
//   • "after": the reformed General: the kits' standing orders, and a model turn that gives a combined-arms plan in one
//     `orders` call (wall + archers holding, horsemen `flank`, horse archers `attack` with `approach`), then re-orders an
//     idle squad. Same latency.
// The numbers of the last run are in docs/45 §7; this test fails if the reform stops beating the old doctrine.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { battle, type Doctrine, type TurnCtx } from './fakes/battle';
import { holdEventLoopPerTest } from './fakes/keep-alive';

holdEventLoopPerTest(120_000);

const nearest = (c: TurnCtx): string | undefined => /X\d+/.exec(c.generals.sitrep(c.g).split('\n').find((l) => /^X\d+ \d+ @/.test(l)) ?? '')?.[0];
const contact = (c: TurnCtx): boolean => c.events.some((e) => e.kind === 'contact' || e.kind === 'enemy-approach' || e.kind === 'under-fire');

const before: Doctrine = {
  name: 'before (one line, no standing orders)',
  async setup(c) {
    (this as { done?: boolean }).done = false;
    // The old runtime: no standing orders, and arrivals stood where they appeared.
    for (const s of Object.keys(c.g.squads)) {
      c.generals.setStanding(c.g, s, []);
      await c.generals.stopSquad(c.g, s);
    }
  },
  async turn(c) {
    const x = nearest(c);
    if (!x || !contact(c) || (this as { done?: boolean }).done) return;
    (this as { done?: boolean }).done = true;
    const r = await c.generals.orderMany(c.g, ['G', 'A', 'H', 'HA'].map((squad) => ({ squad, command: 'line', at: { pos: 'E4', facing: 'E' } })));
    if (!/line #\d+/.test(r)) throw new Error(r);
  },
};

// Measured on this bench (3 seeds, docs/45 §7): holding a wall at the edge of bow range and leaving the mobile kits
// to their standing orders (they charge what comes out of the enemy's line, fall back under 40-50 %) trades best;
// throwing the horsemen at the archer line (flank or attack) costs about a third of the trade.
const after: Doctrine = {
  name: 'after (standing orders + wall at bow range)',
  async setup() {
    // The kits' default standing orders stay; arrivals already formed a line at the rally point.
    (this as { planned?: boolean }).planned = false;
  },
  async turn(c) {
    const x = nearest(c);
    if (!x) return;
    const state = this as { planned?: boolean };
    if (!state.planned && contact(c)) {
      state.planned = true;
      await c.generals.orderMany(c.g, [
        { squad: 'G', command: 'line', at: { pos: 'E4', facing: 'E' } },
        { squad: 'A', command: 'line', args: 'back=4', at: { pos: 'E4', facing: 'E' } },
      ]);
      return;
    }
    // Later turns: an idle squad gets an order at once (the doctrine's tempo rule).
    for (const line of c.generals.sitrep(c.g).split('\n')) {
      const m = /^(\w+) (\d+)\/\d+ \S+ hp\d+ idle/.exec(line);
      if (!m || m[2] === '0') continue;
      try {
        await c.generals.order(c.g, m[1]!, 'line', '', { pos: 'E4', facing: 'E' });
      } catch {
        /* the minute's budget: next turn */
      }
    }
  },
};

test('benchmark: 20 v 20 against static archers 100 blocks out and charging melee: the reformed doctrine reacts sooner, idles less and trades better', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  try {
    const tick = (ms: number) => mock.timers.tick(ms);
    // Three seeds each (the hits are random draws), summed.
    const sum = async (d: Doctrine) => {
      const runs = [];
      for (const seed of [1, 2, 3]) runs.push(await battle(d, tick, { seed }));
      const kills = runs.reduce((n, r) => n + r.kills, 0);
      const losses = runs.reduce((n, r) => n + r.losses, 0);
      const lat = runs.flatMap((r) => Object.values(r.contactToOrder.bySquad));
      return {
        ...runs[0]!,
        contactToOrder: { mean: lat.reduce((x, y) => x + y, 0) / Math.max(1, lat.length), max: Math.max(...lat), bySquad: runs[0]!.contactToOrder.bySquad },
        idleBotSeconds: runs.reduce((n, r) => n + r.idleBotSeconds, 0),
        kills,
        losses,
        killsPerLoss: kills / Math.max(1, losses),
        turnErrors: runs.flatMap((r) => r.turnErrors),
      };
    };
    const a = await sum(before);
    const b = await sum(after);
    const row = (s: typeof a) =>
      `${s.doctrine}: contact→order mean ${s.contactToOrder.mean.toFixed(1)} s, max ${s.contactToOrder.max.toFixed(1)} s ${JSON.stringify(s.contactToOrder.bySquad)}; idle ${s.idleBotSeconds} bot·s; kills ${s.kills}, losses ${s.losses}, ${s.killsPerLoss.toFixed(2)} per loss; won at ${s.wonAt ?? '—'}`;
    console.log(`[bench] ${row(a)}\n[bench] ${row(b)}\n[bench] refused: ${JSON.stringify([a.turnErrors, b.turnErrors])}`);
    assert.ok(b.contactToOrder.mean < a.contactToOrder.mean, 'orders come sooner after contact');
    assert.ok(b.idleBotSeconds <= a.idleBotSeconds, 'no more idle time');
    assert.ok(b.killsPerLoss > a.killsPerLoss, 'a better trade');
  } finally {
    mock.timers.reset();
  }
});
