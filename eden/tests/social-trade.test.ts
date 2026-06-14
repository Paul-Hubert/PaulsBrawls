// M6-3 — social/trade.ts + SettlementClient. Proofs (plan §4):
//   • a trade settle against a FAKE settlement server — proposed→settled happy path;
//   • a FAILED settlement (non-2xx → trade.failed, inventories untouched);
//   • coin → paulsbrawls:coin resolution at settlement;
//   • R33 walk-then-talk: an out-of-range partner is walked to FIRST (the go-to skill) before the trade.
// The REAL :8767 integration (against the Java mod, R29) is a SMOKE-time concern — noted, not attempted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryJournal } from './fakes/memory-journal';
import { FakeSettlement } from './fakes/fake-settlement';
import { SettlementClient, TradeService } from '../src/social/trade';

test('M6-3 (happy path): a trade settles against the fake settlement server — proposed→settled', async () => {
  const journal = new MemoryJournal();
  const server = await FakeSettlement.start();
  const settlement = new SettlementClient({ url: server.url, journal });
  const trade = new TradeService({ journal, settlement });

  const result = await trade.propose({
    from: 'Firmin',
    to: 'Pilou',
    give: [{ item: 'oak_log', count: 8 }],
    want: [{ item: 'wheat', count: 4 }],
  });

  assert.equal(result.ok, true, 'settlement succeeded');
  assert.equal(journal.query({ kinds: ['trade.proposed'] }).length, 1);
  assert.equal(journal.query({ kinds: ['trade.settled'] }).length, 1);
  assert.equal(journal.query({ kinds: ['trade.failed'] }).length, 0);
  // the proposed + settled events carry the typed offer + share the tradeId ref
  const settled = journal.query({ kinds: ['trade.settled'] })[0]!;
  assert.equal((settled.payload as { from: string }).from, 'Firmin');
  assert.ok(settled.refs.tradeId, 'a tradeId ref ties the lifecycle together');
  await server.close();
});

test('M6-3 (coin alias): `coin` resolves to paulsbrawls:coin in the settlement POST body (Gibber currency)', async () => {
  const journal = new MemoryJournal();
  const server = await FakeSettlement.start();
  const settlement = new SettlementClient({ url: server.url, journal });
  const trade = new TradeService({ journal, settlement });

  await trade.propose({
    from: 'Firmin',
    to: 'Pilou',
    give: [{ item: 'coin', count: 3 }],
    want: [{ item: 'bread', count: 2 }],
  });

  const body = server.requests[0]!.body as { give: Array<{ item: string }>; want: Array<{ item: string }> };
  assert.equal(body.give[0]!.item, 'paulsbrawls:coin', 'coin → paulsbrawls:coin at settlement');
  assert.equal(body.want[0]!.item, 'bread', 'a normal item is left untouched');
  await server.close();
});

test('M6-3 (failed settlement): a non-2xx response → trade.failed; no trade.settled (inventories untouched)', async () => {
  const journal = new MemoryJournal();
  const server = await FakeSettlement.start();
  server.failWith(422, { error: 'insufficient items' });
  const settlement = new SettlementClient({ url: server.url, journal });
  const trade = new TradeService({ journal, settlement });

  const result = await trade.propose({
    from: 'Firmin', to: 'Pilou',
    give: [{ item: 'oak_log', count: 8 }], want: [{ item: 'wheat', count: 4 }],
  });

  assert.equal(result.ok, false, 'settlement failed');
  assert.equal(journal.query({ kinds: ['trade.proposed'] }).length, 1, 'the offer was still proposed');
  assert.equal(journal.query({ kinds: ['trade.settled'] }).length, 0, 'NOTHING settled');
  const failed = journal.query({ kinds: ['trade.failed'] });
  assert.equal(failed.length, 1);
  assert.match((failed[0]!.payload as { reason: string }).reason, /422|insufficient|HTTP/i, 'the failure names the cause (S10)');
  await server.close();
});

test('M6-3 (network error): an unreachable settlement endpoint → trade.failed (never throws into the flow)', async () => {
  const journal = new MemoryJournal();
  // Point at a port nothing is listening on.
  const settlement = new SettlementClient({ url: 'http://127.0.0.1:1/trade/execute', journal });
  const trade = new TradeService({ journal, settlement });
  const result = await trade.propose({
    from: 'Firmin', to: 'Pilou', give: [{ item: 'dirt', count: 1 }], want: [{ item: 'sand', count: 1 }],
  });
  assert.equal(result.ok, false);
  assert.equal(journal.query({ kinds: ['trade.settled'] }).length, 0);
  assert.equal(journal.query({ kinds: ['trade.failed'] }).length, 1);
});

test('M6-3 (R33 walk-then-talk): an OUT-OF-RANGE partner is walked to FIRST, then the trade proceeds', async () => {
  const journal = new MemoryJournal();
  const server = await FakeSettlement.start();
  const settlement = new SettlementClient({ url: server.url, journal });

  let walked = false;
  let inRange = false; // partner starts out of range
  const trade = new TradeService({
    journal,
    settlement,
    reach: {
      inRange: () => inRange,
      walkTo: async () => {
        walked = true;
        inRange = true; // walking closes the distance (composes the go-to skill in production)
      },
    },
  });

  const result = await trade.propose({
    from: 'Firmin', to: 'Pilou', give: [{ item: 'oak_log', count: 8 }], want: [{ item: 'wheat', count: 4 }],
  });

  assert.equal(walked, true, 'R33: the tool walked to the partner before trading (recover-in-tool)');
  assert.equal(result.ok, true, 'and then the trade settled');
  await server.close();
});

test('M6-3 (R33 in range): a partner already in range is NOT walked to', async () => {
  const journal = new MemoryJournal();
  const server = await FakeSettlement.start();
  const settlement = new SettlementClient({ url: server.url, journal });
  let walked = false;
  const trade = new TradeService({
    journal, settlement,
    reach: { inRange: () => true, walkTo: async () => { walked = true; } },
  });
  await trade.propose({ from: 'Firmin', to: 'Pilou', give: [{ item: 'oak_log', count: 1 }], want: [{ item: 'wheat', count: 1 }] });
  assert.equal(walked, false, 'no needless walk when already in range');
  await server.close();
});

test('M6-3 (R33 unreachable partner): if walking cannot close the distance, the trade fails without settling', async () => {
  const journal = new MemoryJournal();
  const server = await FakeSettlement.start();
  const settlement = new SettlementClient({ url: server.url, journal });
  const trade = new TradeService({
    journal, settlement,
    reach: { inRange: () => false, walkTo: async () => { /* still can't reach */ } },
  });
  const result = await trade.propose({ from: 'Firmin', to: 'Pilou', give: [{ item: 'oak_log', count: 1 }], want: [{ item: 'wheat', count: 1 }] });
  assert.equal(result.ok, false, 'an unreachable partner is a failed trade, not a settle');
  assert.equal(journal.query({ kinds: ['trade.settled'] }).length, 0);
  assert.equal(journal.query({ kinds: ['trade.failed'] }).length, 1);
  assert.match((journal.query({ kinds: ['trade.failed'] })[0]!.payload as { reason: string }).reason, /port|range|atteindre|reach/i);
  await server.close();
});
