// M6-3 — social/trade.ts + SettlementClient. Proofs (plan §4):
//   • a trade settle against a FAKE settlement server — proposed→settled happy path;
//   • a FAILED settlement (non-2xx → trade.failed, inventories untouched);
//   • coin → paulsbrawls:coin resolution at settlement;
//   • R33 walk-then-talk: an out-of-range partner is walked to FIRST (the go-to skill) before the trade.
// The REAL :8767 integration (against the Java mod, R29) is a SMOKE-time concern — noted, not attempted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryJournal } from './fakes/memory-journal';
import { FakeSettlement, validateShape } from './fakes/fake-settlement';
import { SettlementClient, TradeBook, TradeService, TOKEN_HEADER, toSettlementRequest, type TradeBookOptions } from '../src/social/trade';

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

  const body = server.requests[0]!.body as { aGives: Array<{ item: string }>; bGives: Array<{ item: string }> };
  assert.equal(body.aGives[0]!.item, 'paulsbrawls:coin', 'coin → paulsbrawls:coin at settlement');
  assert.equal(body.bGives[0]!.item, 'bread', 'a normal item is left untouched');
  await server.close();
});

// Bug #1 (docs/system/VERIFICATION-NOTES.md): Eden used to POST {from,to,give,want}, which Gson leaves as
// null Java fields → every settlement was a 400 `missing botA`. Pin the EXACT wire body against the Java
// field names in VillageHttpListener.TradeRequest (botA/botB/aGives/bGives; ItemSpec = {item, count}).
test('bug #1 (Java contract): the settlement POST body is exactly {botA, botB, aGives, bGives}', async () => {
  const journal = new MemoryJournal();
  const server = await FakeSettlement.start();
  const settlement = new SettlementClient({ url: server.url, journal });
  const trade = new TradeService({ journal, settlement });

  const result = await trade.propose({
    from: 'Firmin',
    to: 'Pilou',
    give: [{ item: 'coin', count: 3 }, { item: 'oak_log', count: 8 }],
    want: [{ item: 'bread', count: 2 }],
  });

  assert.equal(result.ok, true, 'the Java-shaped body passes the listener\'s shape check');
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0]!.url, '/trade/execute');
  assert.deepEqual(server.requests[0]!.body, {
    botA: 'Firmin',
    botB: 'Pilou',
    aGives: [{ item: 'paulsbrawls:coin', count: 3 }, { item: 'oak_log', count: 8 }],
    bGives: [{ item: 'bread', count: 2 }],
  }, 'from→botA, to→botB, give→aGives, want→bGives — no other keys');
  await server.close();
});

test('bug #1 (Java contract): toSettlementRequest maps the offer and never leaks the offer field names', () => {
  const offer = { from: 'Firmin', to: 'Pilou', give: [{ item: 'coin', count: 1 }], want: [] };
  const body = toSettlementRequest(offer);
  assert.deepEqual(Object.keys(body).sort(), ['aGives', 'bGives', 'botA', 'botB']);
  assert.deepEqual(body, { botA: 'Firmin', botB: 'Pilou', aGives: [{ item: 'paulsbrawls:coin', count: 1 }], bGives: [] });
  assert.deepEqual(offer.give, [{ item: 'coin', count: 1 }], 'the offer itself is not mutated by the coin alias');
  assert.equal(validateShape(body), null, 'passes the Java shape check (one-sided gifts are allowed)');
  // The pre-fix shape is exactly what the Java listener rejected.
  assert.equal(validateShape({ from: 'Firmin', to: 'Pilou', give: [], want: [] }), 'missing botA');
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

// ── Settlement token (VERIFICATION-NOTES bug #2 follow-up): the mod's optional settlementToken is checked
//    against the X-Village-Token header. The client sends it only when configured. ──

test('settlement token: a configured token rides as X-Village-Token; none → no header', async () => {
  const journal = new MemoryJournal();
  const server = await FakeSettlement.start();
  const offer = { from: 'Firmin', to: 'Pilou', give: [{ item: 'oak_log', count: 1 }], want: [] };
  await new SettlementClient({ url: server.url, journal, token: 's3cret' }).settle('t1', offer);
  await new SettlementClient({ url: server.url, journal }).settle('t2', offer);
  await new SettlementClient({ url: server.url, journal, token: '' }).settle('t3', offer);
  const header = TOKEN_HEADER.toLowerCase();
  assert.equal(server.requests[0]!.headers[header], 's3cret');
  assert.equal(server.requests[1]!.headers[header], undefined, 'no token → no header');
  assert.equal(server.requests[2]!.headers[header], undefined, 'an empty token is treated as unset');
  await server.close();
});

// ── TradeBook — consent: propose only records; the PARTNER's accept settles (04 §Trade) ──

const VILLAGERS = new Set(['Firmin', 'Pilou', 'Margot']);
const OFFER = { from: 'Firmin', to: 'Pilou', give: [{ item: 'coin', count: 3 }], want: [{ item: 'bread', count: 2 }] };

async function book(over: Partial<TradeBookOptions> = {}) {
  const journal = new MemoryJournal();
  const server = await FakeSettlement.start();
  const notes: Array<{ to: string; line: string; kind: string }> = [];
  const b = new TradeBook({
    journal,
    settlement: new SettlementClient({ url: server.url, journal }),
    isVillager: (n) => VILLAGERS.has(n),
    notify: (to, line, kind) => notes.push({ to, line, kind }),
    ...over,
  });
  return { b, journal, server, notes };
}

test('TradeBook: propose records + notifies the partner but settles NOTHING until the partner accepts', async () => {
  const { b, journal, server, notes } = await book();
  const r = b.propose(OFFER);
  assert.ok(r.ok);
  assert.equal(server.requests.length, 0, 'no POST before consent');
  assert.equal(journal.query({ kinds: ['trade.proposed'] }).length, 1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.to, 'Pilou');
  assert.equal(notes[0]!.kind, 'offer');
  assert.ok(notes[0]!.line.includes(r.trade.id), 'the partner is told the id to answer');
  assert.deepEqual(b.pendingFor('Pilou').map((t) => t.id), [r.trade.id]);
  assert.deepEqual(b.pendingFor('Firmin').map((t) => t.id), [r.trade.id]);

  const done = await b.answer(r.trade.id, 'Pilou', true);
  assert.equal(done.ok, true);
  assert.equal(server.requests.length, 1, 'accept → exactly one settlement POST');
  assert.deepEqual(server.requests[0]!.body, {
    botA: 'Firmin', botB: 'Pilou', aGives: [{ item: 'paulsbrawls:coin', count: 3 }], bGives: [{ item: 'bread', count: 2 }],
  });
  assert.equal(journal.query({ kinds: ['trade.proposed'] }).length, 1, 'proposed is journaled once, not again on accept');
  assert.equal(journal.query({ kinds: ['trade.settled'] }).length, 1);
  assert.equal(notes.at(-1)!.to, 'Firmin');
  assert.equal(notes.at(-1)!.kind, 'outcome', 'the proposer learns the outcome');
  assert.equal(b.pendingFor('Pilou').length, 0, 'a settled offer leaves the book');
  await server.close();
});

test('TradeBook: only the partner may accept; a third party and the proposer are refused', async () => {
  const { b, server } = await book();
  const r = b.propose(OFFER);
  assert.ok(r.ok);
  const byProposer = await b.answer(r.trade.id, 'Firmin', true);
  assert.equal(byProposer.ok, false);
  assert.match(byProposer.reason!, /seul Pilou/);
  const byOther = await b.answer(r.trade.id, 'Margot', true);
  assert.equal(byOther.ok, false);
  assert.equal(server.requests.length, 0, 'no swap from a refused answer');
  assert.equal(b.pendingFor('Pilou').length, 1, 'the offer is still open for the real partner');
  await server.close();
});

test('TradeBook: a decline (partner) or withdrawal (proposer) journals trade.failed and settles nothing', async () => {
  const { b, journal, server, notes } = await book();
  const r1 = b.propose(OFFER);
  const r2 = b.propose(OFFER);
  assert.ok(r1.ok && r2.ok);
  assert.equal((await b.answer(r1.trade.id, 'Pilou', false)).ok, true);
  assert.equal((await b.answer(r2.trade.id, 'Firmin', false)).ok, true);
  const reasons = journal.query({ kinds: ['trade.failed'] }).map((e) => (e.payload as { reason: string }).reason);
  assert.deepEqual(reasons, ['refusée par Pilou', 'retirée par Firmin']);
  assert.equal(server.requests.length, 0);
  assert.equal(notes.filter((n) => n.kind === 'outcome').length, 1, 'only a partner decline notifies the proposer');
  await server.close();
});

test('TradeBook: an offer expires — it can no longer be accepted and the ledger closes it', async () => {
  let now = 1_000_000;
  const { b, journal, server } = await book({ ttlMs: 60_000, now: () => now });
  const r = b.propose(OFFER);
  assert.ok(r.ok);
  now += 60_001;
  const late = await b.answer(r.trade.id, 'Pilou', true);
  assert.equal(late.ok, false);
  assert.match(late.reason!, /aucune offre/);
  assert.equal(server.requests.length, 0);
  const failed = journal.query({ kinds: ['trade.failed'] });
  assert.equal(failed.length, 1);
  assert.match((failed[0]!.payload as { reason: string }).reason, /expirée/);
  await server.close();
});

test('TradeBook: a second accept of the same id cannot double-settle', async () => {
  const { b, server } = await book();
  const r = b.propose(OFFER);
  assert.ok(r.ok);
  const [a1, a2] = await Promise.all([b.answer(r.trade.id, 'Pilou', true), b.answer(r.trade.id, 'Pilou', true)]);
  assert.equal([a1, a2].filter((x) => x.ok).length, 1);
  assert.equal(server.requests.length, 1, 'one POST, never two');
  await server.close();
});

test('TradeBook: offers are validated at propose time (villagers only, Java caps, no self-trade, spam cap)', async () => {
  const { b, journal, server } = await book();
  const refuse = (o: Partial<typeof OFFER>, re: RegExp): void => {
    const r = b.propose({ ...OFFER, ...o });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, re);
  };
  refuse({ to: 'Steve' }, /pas un villageois/); // a human player: the Java listener would swap them too
  refuse({ to: 'Firmin' }, /soi-même/);
  refuse({ give: [], want: [] }, /rien à échanger/);
  refuse({ give: [{ item: 'coin', count: 0 }] }, /quantité invalide/);
  refuse({ give: [{ item: 'coin', count: 513 }] }, /quantité invalide/);
  refuse({ give: [{ item: 'coin', count: 1.5 }] }, /quantité invalide/);
  refuse({ give: [{ item: ' ', count: 1 }] }, /item/);
  refuse({ give: Array.from({ length: 7 }, () => ({ item: 'dirt', count: 1 })) }, /trop de lignes/);
  assert.equal(journal.query({ kinds: ['trade.proposed'] }).length, 0, 'a refused offer is never journaled');
  for (let i = 0; i < 3; i++) assert.ok(b.propose(OFFER).ok);
  refuse({}, /déjà 3 offres/);
  await server.close();
});

test('TradeBook (R33): on accept, an out-of-range partner walks to the proposer first', async () => {
  let inRange = false;
  let walked = 0;
  const { b, server } = await book({
    reachFor: () => ({ inRange: () => inRange, walkTo: async () => { walked++; inRange = true; } }),
  });
  const r = b.propose(OFFER);
  assert.ok(r.ok);
  assert.equal(walked, 0, 'proposing never walks');
  assert.equal((await b.answer(r.trade.id, 'Pilou', true)).ok, true);
  assert.equal(walked, 1);
  assert.equal(server.requests.length, 1);
  await server.close();
});

test('TradeBook (R33): a walk that throws fails the trade with the cause, without settling', async () => {
  const { b, journal, server, notes } = await book({
    reachFor: () => ({ inRange: () => false, walkTo: async () => { throw new Error('Firmin n’est pas connecté'); } }),
  });
  const r = b.propose(OFFER);
  assert.ok(r.ok);
  const res = await b.answer(r.trade.id, 'Pilou', true);
  assert.equal(res.ok, false);
  assert.match(res.reason!, /hors de portée.*pas connecté/);
  assert.equal(server.requests.length, 0);
  assert.equal(journal.query({ kinds: ['trade.failed'] }).length, 1);
  assert.match(notes.at(-1)!.line, /pas réglé/);
  await server.close();
});
