import test from 'ava';
import { Conversation } from '../src/village/conversation.js';
import { VillageContext } from '../src/village/context.js';
import { TradeManager } from '../src/village/trade.js';
import { LedgerEntry } from '../src/village/types.js';
import { Villager } from '../src/village/villager.js';

function fakeConv(a: string, b: string): Conversation {
  return {
    id: 1,
    participants: [a, b],
    transcript: [],
    turnOf: b,
    turns: 0,
    state: 'open',
    offer: null,
    deadline: null,
    repeats: {},
  };
}

interface TradeWorld {
  trades: TradeManager;
  ledger: LedgerEntry[];
  memoryOf: (name: string) => string[];
}

function makeWorld(inventories: Record<string, Array<{ name: string; count: number }>>): TradeWorld {
  const memories = new Map<string, string[]>();
  const ledger: LedgerEntry[] = [];
  const villagers = new Map(
    Object.entries(inventories).map(([name, items]) => {
      memories.set(name, []);
      const villager = {
        name,
        // Real version string so isRegistryItem can consult minecraft-data.
        bot: () => ({ version: '1.21.1', inventory: { items: () => items.map((i) => ({ ...i })) } }),
        memory: {
          append: (_k: string, text: string) => memories.get(name)!.push(text),
          adjustRelation: () => { /* noop */ },
        },
      } as unknown as Villager;
      return [name, villager] as const;
    })
  );
  const trades = new TradeManager();
  trades.init({
    villagers,
    settings: { settlementUrl: 'http://127.0.0.1:9' },
    persistence: { appendLedger: (e: LedgerEntry) => ledger.push(e) },
  } as unknown as VillageContext);
  return { trades, ledger, memoryOf: (n) => memories.get(n)! };
}

test('propose validates item names, counts, and proposer inventory', (t) => {
  const world = makeWorld({ A: [{ name: 'carrot', count: 10 }], B: [] });
  const conv = fakeConv('A', 'B');

  t.throws(() => world.trades.propose(conv, 'A', [{ item: 'Carrot!!', count: 1 }], []), { message: /bad item name/ });
  t.throws(() => world.trades.propose(conv, 'A', [{ item: 'carrot', count: 0 }], []), { message: /bad count/ });
  t.throws(() => world.trades.propose(conv, 'A', [], []), { message: /at least one item/ });
  t.throws(() => world.trades.propose(conv, 'A', [{ item: 'carrot', count: 99 }], []), { message: /only have 10/ });

  const result = world.trades.propose(conv, 'A', [{ item: 'carrot', count: 5 }], [{ item: 'coin', count: 2 }]);
  t.regex(result, /offer placed/);
  t.deepEqual(conv.offer, { from: 'A', give: [{ item: 'carrot', count: 5 }], want: [{ item: 'coin', count: 2 }] });
});

test('modded items (coin) skip the local pre-check — Java validates them', async (t) => {
  // Mineflayer reports modded items as 'unknown', so counting by name would
  // wrongly reject a coin offer. The pre-check must defer to the settlement.
  const world = makeWorld({ A: [{ name: 'unknown', count: 10 }], B: [{ name: 'carrot', count: 5 }] });
  const conv = fakeConv('A', 'B');

  const result = world.trades.propose(conv, 'A', [{ item: 'coin', count: 3 }], [{ item: 'carrot', count: 2 }]);
  t.regex(result, /offer placed/, 'coin offer passes despite 0 visible coins');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
  t.teardown(() => { globalThis.fetch = originalFetch; });

  const accepted = await world.trades.accept(conv, 'B');
  t.regex(accepted, /trade completed/, 'accept also defers coin counting to Java');

  // Vanilla items are still strictly pre-checked.
  const conv2 = fakeConv('A', 'B');
  t.throws(() => world.trades.propose(conv2, 'A', [{ item: 'diamond', count: 1 }], []), { message: /only have 0/ });
});

test('minecraft: prefixes are normalized', (t) => {
  const world = makeWorld({ A: [{ name: 'carrot', count: 10 }], B: [] });
  const conv = fakeConv('A', 'B');
  world.trades.propose(conv, 'A', [{ item: 'minecraft:carrot', count: 2 }], []);
  t.is(conv.offer!.give[0].item, 'carrot');
});

test('only the other party can accept; reject clears the table', async (t) => {
  const world = makeWorld({ A: [{ name: 'carrot', count: 10 }], B: [{ name: 'coin', count: 5 }] });
  const conv = fakeConv('A', 'B');
  world.trades.propose(conv, 'A', [{ item: 'carrot', count: 5 }], [{ item: 'coin', count: 2 }]);

  await t.throwsAsync(() => world.trades.accept(conv, 'A'), { message: /other party/ });

  t.regex(world.trades.reject(conv, 'B'), /rejected/);
  t.is(conv.offer, null);
  await t.throwsAsync(() => world.trades.accept(conv, 'B'), { message: /no offer/ });
});

test('accept settles via HTTP, writes the ledger and both memories', async (t) => {
  const world = makeWorld({ A: [{ name: 'carrot', count: 10 }], B: [{ name: 'coin', count: 5 }] });
  const conv = fakeConv('A', 'B');
  world.trades.propose(conv, 'A', [{ item: 'carrot', count: 5 }], [{ item: 'coin', count: 2 }]);

  const originalFetch = globalThis.fetch;
  const settled: unknown[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    settled.push(JSON.parse(String(init?.body)));
    t.regex(String(url), /\/trade\/execute$/);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  t.teardown(() => { globalThis.fetch = originalFetch; });

  const result = await world.trades.accept(conv, 'B');
  t.regex(result, /trade completed/);
  t.is(conv.offer, null);
  t.deepEqual(settled, [{
    botA: 'A', botB: 'B',
    aGives: [{ item: 'carrot', count: 5 }],
    bGives: [{ item: 'coin', count: 2 }],
  }]);
  t.is(world.ledger.length, 1);
  t.true(world.memoryOf('A').some((m) => m.includes('échange conclu')));
  t.true(world.memoryOf('B').some((m) => m.includes('échange conclu')));
});

test('settlement failure surfaces as an error and clears the offer', async (t) => {
  const world = makeWorld({ A: [{ name: 'carrot', count: 10 }], B: [{ name: 'coin', count: 5 }] });
  const conv = fakeConv('A', 'B');
  world.trades.propose(conv, 'A', [{ item: 'carrot', count: 5 }], [{ item: 'coin', count: 2 }]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error: 'A does not have 5x carrot' }), { status: 400 })
  ) as typeof fetch;
  t.teardown(() => { globalThis.fetch = originalFetch; });

  await t.throwsAsync(() => world.trades.accept(conv, 'B'), { message: /settlement failed/ });
  t.is(conv.offer, null);
});

test('accepter without the wanted items is caught before settlement', async (t) => {
  // Vanilla item on the want side: 'coin' would skip the local pre-check
  // (modded, invisible to minecraft-data) and defer to the Java settlement.
  const world = makeWorld({ A: [{ name: 'carrot', count: 10 }], B: [{ name: 'bread', count: 1 }] });
  const conv = fakeConv('A', 'B');
  world.trades.propose(conv, 'A', [{ item: 'carrot', count: 5 }], [{ item: 'bread', count: 2 }]);
  await t.throwsAsync(() => world.trades.accept(conv, 'B'), { message: /don't have/ });
});
