import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBot } from './fakes/fake-bot';
import { MemoryJournal } from './fakes/memory-journal';
import { SkillLibrary, AllGranted } from '../src/skills/library';
import { SkillEngine } from '../src/skills/engine';
import { SkillRetriever } from '../src/skills/retrieve';
import { EmbeddingsService } from '../src/llm/embeddings';
import { ToolRegistry, type ToolContext } from '../src/villagers/tools';
import { SubscriptionStore } from '../src/villagers/subscriptions';
import { VillagerMemory } from '../src/villagers/memory';
import type { LlmToolCall } from '../src/llm/client';
import type { PendingTrade, RunnerRef, TradeDesk, TradeOffer } from '../src/types/index';

const RUNNER: RunnerRef = { name: 'Firmin', role: 'farmer', tier: 'mortal' };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'eden-tools-'));
  const journal = new MemoryJournal();
  const library = new SkillLibrary({ dataDir: dir, journal, probationRuns: 3 });
  const bot = new FakeBot({ username: 'Firmin' });
  const engine = new SkillEngine({
    library,
    journal,
    grants: new AllGranted(),
    resolveBot: () => bot,
    runDefaultTimeoutMs: 120_000,
    stallSeconds: 20,
    maxCallDepth: 8,
    autoQuarantineAfter: 5,
  });
  const embeddings = new EmbeddingsService({}); // no backend → keyword floor (off)
  const retriever = new SkillRetriever({ library, embeddings, grants: new AllGranted() });
  const tools = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400 });
  return { tools, library, engine, retriever, journal, bot, dir };
}

const call = (name: string, args: object): LlmToolCall => ({ id: `c_${name}`, name, arguments: args });
const CTX = (over: Partial<ToolContext> = {}): ToolContext => ({ villager: 'Firmin', runner: RUNNER, ...over });

const OBJ = { type: 'object', properties: {} };

test('M3-2 (golden schemas): the villager tool surface is exactly the M3+M5+trade+speech set', () => {
  const { tools } = harness();
  const names = tools.definitions().map((d) => d.function.name).sort();
  // M5 added `unsubscribe` (the plan §4 M5-2 lists subscribe/unsubscribe/list_subscriptions) and wired
  // subscribe/list_subscriptions to the real store (no longer stubs) — an intentional schema change.
  // The trade tools (propose_trade/answer_trade/list_trades, 04 §Brain Social) wire social/'s TradeBook.
  // D-18 added the speech tools say/tell/start_conversation (an intentional schema change, S6) — wired to
  // social/'s ConversationBook through the types/ ConversationDesk seam.
  assert.deepEqual(names, [
    'answer_trade',
    'done',
    'list_subscriptions',
    'list_trades',
    'propose_trade',
    'read_skill',
    'recall',
    'remember',
    'report_to_god',
    'run_skill',
    'say',
    'search_skills',
    'start_conversation',
    'subscribe',
    'tell',
    'unsubscribe',
    'write_skill',
  ]);
  for (const d of tools.definitions()) {
    assert.equal(d.type, 'function');
    assert.ok(d.function.description.length > 0, `${d.function.name} has a description`);
    assert.ok(typeof d.function.parameters === 'object', `${d.function.name} has parameters`);
  }
});

test('M3-2 (tier-filtered view): write_skill exposes NO tier field — villager skills are always mortal', () => {
  const { tools } = harness();
  const write = tools.definitions().find((d) => d.function.name === 'write_skill')!;
  const props = (write.function.parameters as { properties: Record<string, unknown> }).properties;
  assert.ok(!('tier' in props), 'no divine field on the villager-facing write_skill schema (02 §Tiers)');
  assert.ok('name' in props && 'summary' in props && 'params' in props && 'returns' in props && 'code' in props);
});

test('M3-2: search_skills returns ranked name — signature — summary lines', async () => {
  const { tools, library } = harness();
  library.seedStock({ name: 'chop-wood', summary: 'couper du bois', params: OBJ, returns: OBJ, code: 'async function f(b,a,c){}', author: { kind: 'stock' }, tags: ['wood'] }, 'active');
  const out = await tools.dispatch(call('search_skills', { query: 'bois' }), CTX());
  assert.match(out.content, /chop-wood/);
  assert.match(out.content, /couper du bois/);
});

test('M3-2: read_skill returns full code + manifest + stats', async () => {
  const { tools, library } = harness();
  library.seedStock({ name: 'chop-wood', summary: 'couper du bois', params: OBJ, returns: OBJ, code: 'async function chop(b,a,c){ return 1; }', author: { kind: 'stock' } }, 'active');
  const out = await tools.dispatch(call('read_skill', { name: 'chop-wood' }), CTX());
  assert.match(out.content, /async function chop/);
  assert.match(out.content, /couper du bois/);
  assert.match(out.content, /runs=/, 'includes a stats line');
});

test('M3-2: write_skill upserts a draft and returns its version (authored)', async () => {
  const { tools, library } = harness();
  const out = await tools.dispatch(
    call('write_skill', { name: 'collect-oak-logs', summary: 'récolte des bûches', params: OBJ, returns: OBJ, code: 'async function f(bot,args,ctx){ return { ok: true }; }' }),
    CTX(),
  );
  assert.deepEqual(out.authored, { name: 'collect-oak-logs', version: 1 });
  assert.match(out.content, /v1/);
  // It is a DRAFT (P2: not retrievable for normal work yet).
  assert.equal(library.activeVersion('collect-oak-logs'), undefined);
  assert.equal(library.getVersion('collect-oak-logs', 1)?.status, 'draft');
});

test('M3-2 (R47): write_skill rejects an oversize body (decompose-or-reject, never truncate)', async () => {
  const { tools, library } = harness();
  const huge = Array.from({ length: 401 }, (_, n) => `  const x${n} = ${n};`).join('\n');
  const code = `async function big(bot,args,ctx){\n${huge}\n}`;
  const out = await tools.dispatch(call('write_skill', { name: 'too-big', summary: 's', params: OBJ, returns: OBJ, code }), CTX());
  assert.equal(out.authored, undefined, 'no draft created');
  assert.match(out.content, /400|maxSkillLines|décompos/i, 'a decompose-or-reject error mentioning the cap');
  assert.equal(library.getVersion('too-big', 1), undefined, 'nothing landed in the library');
});

test('M3-2: write_skill returns a parse error inline for immediate retry (never a draft)', async () => {
  const { tools, library } = harness();
  const out = await tools.dispatch(call('write_skill', { name: 'broken', summary: 's', params: OBJ, returns: OBJ, code: 'async function broken(bot,args,ctx) { return ( ; }' }), CTX());
  assert.equal(out.authored, undefined);
  assert.match(out.content, /erreur|error|parse|syntax/i);
  assert.equal(library.getVersion('broken', 1), undefined);
});

test('M3-2: run_skill runs the live version and records the RunReport', async () => {
  const { tools, library } = harness();
  library.seedStock({ name: 'noop', summary: 'noop', params: OBJ, returns: OBJ, code: 'async function noop(bot,args,ctx){ return { ok: true }; }', author: { kind: 'stock' } }, 'active');
  const out = await tools.dispatch(call('run_skill', { name: 'noop', args: {} }), CTX());
  assert.ok(out.ran, 'a RunReport was produced');
  assert.equal(out.ran!.outcome.ok, true);
  assert.match(out.content, /ok|succès|success/i);
});

test('M3-2: run_skill of the rollout draft trials the DRAFT version (P2), with validateReturn', async () => {
  const { tools } = harness();
  // Author a draft, then run it as a rollout trial (ctx.draft set by the brain).
  const w = await tools.dispatch(call('write_skill', { name: 'd', summary: 's', params: OBJ, returns: { type: 'object', properties: { got: { type: 'number' } }, required: ['got'] }, code: 'async function d(bot,args,ctx){ return { got: 3 }; }' }), CTX());
  const out = await tools.dispatch(call('run_skill', { name: 'd', args: {} }), CTX({ rolloutId: 'roll-1', draft: { name: 'd', version: w.authored!.version } }));
  assert.ok(out.ran);
  assert.equal(out.ran!.version, 1, 'the draft version was trialed (not a live version — there is none)');
  assert.equal(out.ran!.rolloutId, 'roll-1');
});

test('M3-2: run_skill surfaces a pre-execution error as a tool-result string (not a RunReport)', async () => {
  const { tools } = harness();
  const out = await tools.dispatch(call('run_skill', { name: 'does-not-exist', args: {} }), CTX());
  assert.equal(out.ran, undefined);
  assert.match(out.content, /not found|introuvable|n'existe/i);
});

test('M3-2: report_to_god and done are surfaced to the brain', async () => {
  const { tools } = harness();
  const r = await tools.dispatch(call('report_to_god', { text: 'je suis bloqué' }), CTX());
  assert.equal(r.reportedToGod, 'je suis bloqué');
  const d = await tools.dispatch(call('done', { summary: 'fini', mood: 'satisfait' }), CTX());
  assert.deepEqual(d.done, { summary: 'fini', mood: 'satisfait' });
});

test('M6: remember/recall degrade gracefully when no memory store is wired (never a throw)', async () => {
  const { tools } = harness(); // no memory store
  for (const n of ['remember', 'recall']) {
    const out = await tools.dispatch(call(n, { text: 'x', query: 'x' }), CTX());
    assert.ok(out.content.length > 0, `${n} returns an honest "(non câblé)" string`);
    assert.equal(out.done, undefined);
  }
});

test('M6: remember/recall drive the real VillagerMemory when wired', async () => {
  const { library, engine, retriever, journal, dir } = harness();
  const memory = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, memoryFor: (v) => (v === 'Firmin' ? memory : undefined) });
  // remember → it lands in the store as a `thought`
  const r = await wired.dispatch(call('remember', { text: 'la pierre se mine avec une pioche', tags: ['pierre'] }), CTX());
  assert.match(r.content, /noté/i);
  assert.ok(memory.all().some((e) => e.kind === 'thought' && /pioche/.test(e.text)));
  // recall → it retrieves the relevant memory
  const out = await wired.dispatch(call('recall', { query: 'pierre pioche' }), CTX());
  assert.match(out.content, /pioche/);
});

test('M6 (regression): the SHARED registry resolves memory per ctx.villager — never leaks across villagers', async () => {
  // The ToolRegistry is ONE instance shared by all villagers (deliberation state lives in ctx), so memory
  // must be resolved per ctx.villager. The pre-fix bug wired a single VillagerMemory (or none at all) into
  // the shared registry, so recall/remember served one villager's store to everyone — or the "(non câblé)"
  // stub to all. This pins the per-villager resolver: Firmin's remember is invisible to Hortense.
  const { library, engine, retriever, journal, dir } = harness();
  const memories = new Map<string, VillagerMemory>([
    ['Firmin', new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' })],
    ['Hortense', new VillagerMemory({ villager: 'Hortense', dataDir: dir, journal, worldId: 'w1' })],
  ]);
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, memoryFor: (v) => memories.get(v) });
  await wired.dispatch(call('remember', { text: 'le coffre est près du puits' }), CTX({ villager: 'Firmin' }));
  // Firmin recalls his own memory…
  const firmin = await wired.dispatch(call('recall', { query: 'coffre puits' }), CTX({ villager: 'Firmin' }));
  assert.match(firmin.content, /coffre/);
  // …Hortense (same shared registry) does NOT see it — her store is independent and empty.
  const hortense = await wired.dispatch(call('recall', { query: 'coffre puits' }), CTX({ villager: 'Hortense' }));
  assert.match(hortense.content, /aucun/i);
  assert.equal(memories.get('Hortense')!.all().length, 0, 'Firmin\'s remember never touched Hortense\'s store');
});

test('M5-2: subscribe/unsubscribe/list_subscriptions degrade gracefully when no store is wired', async () => {
  const { tools } = harness(); // no subscriptions store
  const sub = await tools.dispatch(call('subscribe', { on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} } }), CTX());
  assert.equal(sub.ok, false, 'subscribe without a store is a no-op error, never a throw');
  const list = await tools.dispatch(call('list_subscriptions', {}), CTX());
  assert.ok(list.content.length > 0);
});

test('M5-2: subscribe/list_subscriptions/unsubscribe drive the real SubscriptionStore', async () => {
  const { library, engine, retriever, journal, dir } = harness();
  const store = new SubscriptionStore({ dataDir: dir, journal });
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, subscriptions: store });
  // subscribe → created + journaled
  const sub = await wired.dispatch(call('subscribe', { on: 'player-chat', handler: { kind: 'deliberate', hint: 'un joueur te parle' }, filter: { within: 8 } }), CTX());
  assert.match(sub.content, /id /);
  assert.equal(store.list('Firmin').length, 1);
  assert.equal(journal.query({ kinds: ['subscription.created'] }).length, 1);
  // list shows it
  const list = await wired.dispatch(call('list_subscriptions', {}), CTX());
  assert.match(list.content, /player-chat/);
  // unsubscribe by id
  const id = store.list('Firmin')[0]!.id;
  const un = await wired.dispatch(call('unsubscribe', { id }), CTX());
  assert.match(un.content, /supprim/i);
  assert.equal(store.list('Firmin').length, 0);
});

test('M3-2: an unknown tool name returns an error string, never throws', async () => {
  const { tools } = harness();
  const out = await tools.dispatch(call('frobnicate', {}), CTX());
  assert.match(out.content, /unknown|inconnu/i);
});

// ── Coverage: input-validation branches every tool guards (audit 2026-06-14) ──────────────────────
// These are the ok:false usage-error paths the brain relies on to never explode mid-deliberation; each
// is a distinct branch in ToolRegistry.dispatch that prior tests left uncovered (tools.ts was the worst-
// covered non-type file at 58% branch).

test('M3-2 (guard): write_skill rejects an empty name and an empty code distinctly', async () => {
  const { tools, library } = harness();
  const noName = await tools.dispatch(call('write_skill', { name: '   ', summary: 's', params: OBJ, returns: OBJ, code: 'async function f(b,a,c){}' }), CTX());
  assert.equal(noName.ok, false);
  assert.match(noName.content, /name/i);
  const noCode = await tools.dispatch(call('write_skill', { name: 'x', summary: 's', params: OBJ, returns: OBJ, code: '' }), CTX());
  assert.equal(noCode.ok, false);
  assert.match(noCode.content, /code/i);
  assert.equal(library.getVersion('x', 1), undefined, 'neither guard let a draft land');
});

test('M3-2 (guard): run_skill with an empty name is a usage error, not a run', async () => {
  const { tools } = harness();
  const out = await tools.dispatch(call('run_skill', { name: '  ', args: {} }), CTX());
  assert.equal(out.ok, false);
  assert.equal(out.ran, undefined, 'no RunReport — it never reached the engine');
  assert.match(out.content, /name/i);
});

test('M3-2 (guard): remember requires text; recall requires query (wired store)', async () => {
  const { library, engine, retriever, journal, dir } = harness();
  const memory = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, memoryFor: (v) => (v === 'Firmin' ? memory : undefined) });
  const noText = await wired.dispatch(call('remember', { text: '   ' }), CTX());
  assert.equal(noText.ok, false);
  assert.match(noText.content, /text/i);
  assert.equal(memory.all().length, 0, 'an empty remember stored nothing');
  const noQuery = await wired.dispatch(call('recall', { query: '' }), CTX());
  assert.equal(noQuery.ok, false);
  assert.match(noQuery.content, /query/i);
});

test('M3-2 (guard): recall against a wired-but-empty store reports no memories (not an error)', async () => {
  const { library, engine, retriever, journal, dir } = harness();
  const memory = new VillagerMemory({ villager: 'Firmin', dataDir: dir, journal, worldId: 'w1' });
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, memoryFor: (v) => (v === 'Firmin' ? memory : undefined) });
  const out = await wired.dispatch(call('recall', { query: 'quoi que ce soit' }), CTX());
  assert.notEqual(out.ok, false, 'an empty result is not a usage error');
  assert.match(out.content, /aucun/i);
});

test('M3-2 (guard): subscribe rejects a missing "on" and an invalid handler kind (wired store)', async () => {
  const { library, engine, retriever, journal, dir } = harness();
  const store = new SubscriptionStore({ dataDir: dir, journal });
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, subscriptions: store });
  const noOn = await wired.dispatch(call('subscribe', { on: '', handler: { kind: 'skill', name: 'flee', args: {} } }), CTX());
  assert.equal(noOn.ok, false);
  assert.match(noOn.content, /on/i);
  const badHandler = await wired.dispatch(call('subscribe', { on: 'hurt', handler: { kind: 'nonsense' } }), CTX());
  assert.equal(badHandler.ok, false);
  assert.match(badHandler.content, /handler/i);
  assert.equal(store.list('Firmin').length, 0, 'neither bad subscribe landed');
});

test('M3-2 (guard): unsubscribe refuses a missing id and another villager’s subscription', async () => {
  const { library, engine, retriever, journal, dir } = harness();
  const store = new SubscriptionStore({ dataDir: dir, journal });
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, subscriptions: store });
  // Someone ELSE's subscription.
  const other = store.add({ villager: 'Colette', on: 'hurt', handler: { kind: 'skill', name: 'flee', args: {} }, source: 'self' });
  const noId = await wired.dispatch(call('unsubscribe', { id: '' }), CTX());
  assert.equal(noId.ok, false);
  assert.match(noId.content, /id/i);
  const notMine = await wired.dispatch(call('unsubscribe', { id: other.id }), CTX({ villager: 'Firmin' }));
  assert.equal(notMine.ok, false, 'a villager cannot remove another villager’s subscription');
  assert.equal(store.list('Colette').length, 1, 'Colette’s subscription is untouched');
});

test('M3-2: list_subscriptions renders the filter + the disabled marker', async () => {
  const { library, engine, retriever, journal, dir } = harness();
  const store = new SubscriptionStore({ dataDir: dir, journal });
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, subscriptions: store });
  const sub = store.add({ villager: 'Firmin', on: 'entity-spotted', handler: { kind: 'deliberate', hint: 'un monstre' }, filter: { within: 8, entityKind: 'hostile' }, source: 'self' });
  store.setEnabled(sub.id, false);
  const out = await wired.dispatch(call('list_subscriptions', {}), CTX());
  assert.match(out.content, /entity-spotted/);
  assert.match(out.content, /filtre/i, 'the filter is rendered');
  assert.match(out.content, /désactivé/i, 'the disabled marker is rendered');
});

// ── Trade tools: propose_trade / answer_trade / list_trades reach the TradeDesk seam (04 §Brain Social) ──

function fakeDesk() {
  const proposed: TradeOffer[] = [];
  const answers: Array<{ id: string; by: string; accept: boolean }> = [];
  const desk: TradeDesk = {
    propose: (offer) => {
      proposed.push(offer);
      if (offer.to === 'Steve') return { ok: false, reason: '"Steve" n’est pas un villageois' };
      return { ok: true, trade: { id: 'T1', offer, expiresAt: Date.UTC(2026, 0, 1, 12, 30) } };
    },
    answer: async (id, by, accept) => {
      answers.push({ id, by, accept });
      return id === 'T1' ? { ok: true } : { ok: false, reason: 'aucune offre' };
    },
    pendingFor: (v): PendingTrade[] =>
      v === 'Firmin'
        ? [{ id: 'T1', offer: { from: 'Pilou', to: 'Firmin', give: [{ item: 'coin', count: 3 }], want: [] }, expiresAt: Date.UTC(2026, 0, 1, 12, 30) }]
        : [],
  };
  return { desk, proposed, answers };
}

test('trade tools: propose_trade proposes AS the acting villager; answer_trade/list_trades go through the desk', async () => {
  const { library, engine, retriever, journal } = harness();
  const { desk, proposed, answers } = fakeDesk();
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, trade: desk });

  const p = await wired.dispatch(call('propose_trade', { to: 'Pilou', give: [{ item: 'coin', count: 3 }], want: [{ item: 'bread', count: 2 }] }), CTX());
  assert.notEqual(p.ok, false);
  assert.match(p.content, /T1/);
  assert.deepEqual(proposed[0], { from: 'Firmin', to: 'Pilou', give: [{ item: 'coin', count: 3 }], want: [{ item: 'bread', count: 2 }] });

  const refused = await wired.dispatch(call('propose_trade', { to: 'Steve', give: [], want: [{ item: 'coin', count: 1 }] }), CTX());
  assert.equal(refused.ok, false);
  assert.match(refused.content, /pas un villageois/);

  const acc = await wired.dispatch(call('answer_trade', { id: 'T1', accept: true }), CTX());
  assert.match(acc.content, /conclu/);
  assert.deepEqual(answers[0], { id: 'T1', by: 'Firmin', accept: true });
  const dec = await wired.dispatch(call('answer_trade', { id: 'nope', accept: false }), CTX());
  assert.equal(dec.ok, false);

  const list = await wired.dispatch(call('list_trades', {}), CTX());
  assert.match(list.content, /T1 — reçue de Pilou: il donne 3 coin contre rien \(expire 12:30 UTC\)/);
});

test('trade tools: malformed args are usage errors; an unwired desk is an honest stub', async () => {
  const { tools, library, engine, retriever, journal } = harness();
  const { desk } = fakeDesk();
  const wired = new ToolRegistry({ library, engine, retriever, journal, maxSkillLines: 400, trade: desk });
  assert.equal((await wired.dispatch(call('propose_trade', { to: 'Pilou', give: 'coin', want: [] }), CTX())).ok, false);
  assert.equal((await wired.dispatch(call('propose_trade', { give: [], want: [] }), CTX())).ok, false);
  assert.equal((await wired.dispatch(call('answer_trade', { id: 'T1' }), CTX())).ok, false, 'accept must be a boolean');
  const stub = await tools.dispatch(call('propose_trade', { to: 'Pilou', give: [], want: [] }), CTX());
  assert.equal(stub.ok, false);
  assert.match(stub.content, /non câblé/);
});

test('bug #13: write_skill with a path-traversal name is a readable tool error, never a file outside library/', async () => {
  const { tools } = harness();
  const out = await tools.dispatch(
    call('write_skill', { name: '../../escape', summary: 's', params: OBJ, returns: OBJ, code: 'async function f(bot,args,ctx){ return 1; }' }),
    CTX(),
  );
  assert.equal(out.ok, false);
  assert.match(out.content, /invalid skill name "\.\.\/\.\.\/escape"/);
  assert.equal(out.authored, undefined);
});

test('D-18: the speech tools are honest stubs without a ConversationDesk', async () => {
  const { tools } = harness();
  for (const [name, args] of [['say', { text: 'x' }], ['tell', { to: 'Pilou', text: 'x' }], ['start_conversation', { with: 'Pilou', topic: 't' }]] as const) {
    const out = await tools.dispatch(call(name, args), CTX());
    assert.equal(out.ok, false);
    assert.match(out.content, /conversation non câblée/);
  }
});
