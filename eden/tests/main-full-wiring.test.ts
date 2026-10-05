// M7-3 — the full host comes up WITHOUT Minecraft. `start()` with enableGod:true wires the WHOLE graph
// (library + engine + retriever + brain + God desks + memories + views + the complete admin surface) but
// spawnBots stays false, so CI never touches a server. The proof: the admin answers every route — the
// data feed + control rail ship together (05). This is the M7 "boot test proves start() brings up the
// full host (admin responds) WITHOUT Minecraft".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start } from '../src/main';

function writeConfig(dir: string): string {
  const p = join(dir, 'eden.json');
  writeFileSync(
    p,
    JSON.stringify({
      minecraft: { version: '1.21.1' },
      villagers: [
        { name: 'Firmin', role: 'farmer', home: [0, 64, 0], chest: [1, 64, 0] },
        { name: 'Alban', role: 'miner', home: [10, 64, 0], chest: [11, 64, 0] },
      ],
      god: { name: 'Dieu' },
      admin: { port: 0 },
    }),
  );
  return p;
}

async function getJson(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(port: number, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('full host boots with God wired but NO Minecraft; the complete admin surface answers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-full-'));
  const host = await start(writeConfig(dir), { dataDir: join(dir, '.eden-data'), spawnBots: false, enableGod: true });
  const port = host.adminPort;
  t.after(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.ok(host.coordinator, 'God wired → the refinement coordinator is present');

  // Every GET route answers. /status carries the dashboard's mission-control shape.
  const status0 = (await getJson(port, '/status')).body;
  assert.equal(status0.botsConnected, 0);
  assert.equal(status0.totalBots, 3, 'roster (2) + the avatar');
  assert.equal(status0.paused, false);
  assert.equal(typeof status0.queueDepth, 'number');
  assert.equal((await getJson(port, '/villagers')).body.villagers.length, 2);
  assert.equal((await getJson(port, '/villagers/Firmin')).body.role, 'farmer');
  assert.equal((await getJson(port, '/villagers/Nobody')).status, 404);
  assert.ok(Array.isArray((await getJson(port, '/skills')).body.skills));
  assert.deepEqual((await getJson(port, '/tasks')).body, { completed: [], failed: [], open: [] });
  assert.ok(Array.isArray((await getJson(port, '/verdicts')).body.verdicts));
  assert.ok(Array.isArray((await getJson(port, '/directives')).body.directives));
  assert.ok((await getJson(port, '/journal?kinds=system.boot')).body.events.length === 1);
  assert.ok(Array.isArray((await getJson(port, '/kinds')).body.kinds));

  // The control verbs are WIRED (God on) and gate the real scheduler.
  const pause = await postJson(port, '/pause');
  assert.equal(pause.status, 200);
  assert.equal((await getJson(port, '/status')).body.paused, true, 'pause gated the live LLM scheduler');
  const resume = await postJson(port, '/resume');
  assert.equal(resume.status, 200);
  assert.equal((await getJson(port, '/status')).body.paused, false);

  // prompt → inbox.delivered journaled BEFORE delivery (the website's talk box).
  const prompt = await postJson(port, '/villagers/Firmin/prompt', { text: 'va aux champs', from: 'paul' });
  assert.equal(prompt.status, 200);
  const delivered = (await getJson(port, '/journal?kinds=inbox.delivered')).body.events;
  assert.ok(delivered.some((e: any) => e.payload.to === 'Firmin' && e.payload.kind === 'tell'), 'tell journaled');
  // Bug #17: exactly ONE row per prompt, carrying the speaker as its actor.
  assert.equal(delivered.length, 1, 'one inbox.delivered per prompt (was two)');
  assert.equal(delivered[0].actor, 'player:paul');
});

test('host boots WITHOUT God (default): GETs return empty, control verbs report 503', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-nogod-'));
  const host = await start(writeConfig(dir), { dataDir: join(dir, '.eden-data') }); // spawnBots + enableGod default false
  const port = host.adminPort;
  t.after(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(host.coordinator, undefined, 'God off → no coordinator');
  assert.equal((await getJson(port, '/villagers')).body.villagers.length, 2, 'static identity still listed');
  assert.deepEqual((await getJson(port, '/skills')).body.skills, []);
  // Control verbs are unwired → 503 (not a crash).
  assert.equal((await postJson(port, '/pause')).status, 503);
  assert.equal((await postJson(port, '/villagers/Firmin/prompt', { text: 'x' })).status, 503);
});

/** Boot the full God-wired host (no Minecraft) in a temp dir; torn down after the test. */
async function bootGod(t: { after: (fn: () => Promise<void>) => void }): Promise<{ host: Awaited<ReturnType<typeof start>>; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'eden-wire-'));
  const host = await start(writeConfig(dir), { dataDir: join(dir, '.eden-data'), spawnBots: false, enableGod: true });
  t.after(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, dir };
}

const FIRMIN = { villager: 'Firmin', runner: { name: 'Firmin', role: 'farmer', tier: 'mortal' as const } };
const call = (name: string, args: object) => ({ id: `c-${name}`, name, arguments: args });

test('wiring: the villager subscription tools reach the live SubscriptionStore (no longer stubs)', async (t) => {
  const { host } = await bootGod(t);
  assert.ok(host.tools, 'God wired → the tool registry is exposed');
  const created = await host.tools.dispatch(
    call('subscribe', { on: 'hurt', handler: { kind: 'deliberate', hint: 'fuis' } }),
    FIRMIN,
  );
  assert.notEqual(created.ok, false, created.content);
  assert.doesNotMatch(created.content, /non câblée/);
  const listed = await host.tools.dispatch(call('list_subscriptions', {}), FIRMIN);
  assert.match(listed.content, /quand "hurt"/);
  // The admin reads the SAME store the tool wrote (one writer, S2).
  const firmin = (await getJson(host.adminPort, '/villagers/Firmin')).body;
  assert.equal(firmin.subscriptions.length, 1);
});

test('bug #12: a second boot on the same data dir seeds NO new stock versions and no skill.draft rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-reseed-'));
  const dataDir = join(dir, '.eden-data');
  const cfg = writeConfig(dir);
  try {
    const first = await start(cfg, { dataDir, spawnBots: false, enableGod: true });
    const drafts1 = first.journal.query({ kinds: ['skill.draft'] }).length;
    const goTo1 = (await getJson(first.adminPort, '/skills/go-to')).body.versions.length;
    await first.stop();
    const second = await start(cfg, { dataDir, spawnBots: false, enableGod: true });
    const drafts2 = second.journal.query({ kinds: ['skill.draft'] }).length;
    const goTo2 = (await getJson(second.adminPort, '/skills/go-to')).body.versions.length;
    await second.stop();
    assert.ok(drafts1 > 0, 'the first boot seeded the stock library');
    assert.equal(drafts2, drafts1, 'the second boot journaled no new skill.draft');
    assert.equal(goTo2, goTo1, 'no new go-to version on the second boot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bug #17: an admin quarantine journals exactly ONE skill.quarantine (actor admin, the real version); an unknown skill none', async (t) => {
  const { host } = await bootGod(t);
  const ok = await postJson(host.adminPort, '/skills/go-to/quarantine', { reason: 'test' });
  assert.equal(ok.status, 200);
  const rows = (await getJson(host.adminPort, '/journal?kinds=skill.quarantine')).body.events;
  assert.equal(rows.length, 1, 'one row per quarantine');
  assert.equal(rows[0].actor, 'admin');
  assert.ok(rows[0].payload.version >= 1, 'the row names the version that was quarantined');
  const missing = await postJson(host.adminPort, '/skills/nope/quarantine', { reason: 'test' });
  assert.equal(missing.status, 404);
  assert.equal((await getJson(host.adminPort, '/journal?kinds=skill.quarantine')).body.events.length, 1, 'a 404 leaves no row');
});

test('bug #17: a refused /scenario/start 404s WITHOUT journaling scenario.start', async (t) => {
  const { host } = await bootGod(t); // no pool (spawnBots false) → the launcher refuses every start
  const r = await postJson(host.adminPort, '/scenario/start', { name: 'farming-hamlet', x: 0, z: 0 });
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
  assert.match(r.body.message, /no village configured/);
  assert.equal((await getJson(host.adminPort, '/journal?kinds=scenario.start,scenario.restart')).body.events.length, 0);
});

// Bug #16: /villagers restart deleted bots/<n>.json, but the live VillagerMemory still held the old life in RAM and
// re-wrote the file on its next write; self-authored subscriptions survived too. Driven through start() with a real
// (never-connecting) pool so the launcher's restart path is the production one.
test('bug #16: /scenario/restart forgets live memory and self-authored subscriptions (role defaults stay)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-restart-'));
  const cfg = join(dir, 'eden.json');
  writeFileSync(cfg, JSON.stringify({
    minecraft: { host: '127.0.0.1', port: 1, version: '1.21.1' }, // nothing listens: the pool never connects
    villagers: [{ name: 'Firmin', role: 'farmer' }],
    god: { name: 'Dieu' },
    admin: { port: 0 },
  }));
  const host = await start(cfg, { dataDir: join(dir, '.eden-data'), spawnBots: true, serveWeb: false });
  t.after(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(host.tools);
  await host.tools.dispatch(call('remember', { text: 'le puits est au nord' }), FIRMIN);
  await host.tools.dispatch(call('subscribe', { on: 'hurt', handler: { kind: 'deliberate', hint: 'fuis' } }), FIRMIN);
  const subsBefore = (await getJson(host.adminPort, '/villagers/Firmin')).body.subscriptions.length;

  const r = await postJson(host.adminPort, '/scenario/restart', { name: 'whatever', x: 0, z: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const recalled = await host.tools.dispatch(call('recall', { query: 'puits' }), FIRMIN);
  assert.doesNotMatch(recalled.content, /puits/, 'the live memory forgot the old life');
  const subsAfter = (await getJson(host.adminPort, '/villagers/Firmin')).body.subscriptions.length;
  assert.equal(subsAfter, subsBefore - 1, 'the self-authored subscription is gone; role defaults remain');
  // The next memory write starts a fresh file instead of resurrecting the old one.
  await host.tools.dispatch(call('remember', { text: 'nouvelle vie' }), FIRMIN);
  const after = await host.tools.dispatch(call('recall', { query: 'puits vie' }), FIRMIN);
  assert.doesNotMatch(after.content, /puits/);
});

// D-18: the speech tools reach social/'s ConversationBook through the composition root. Without a bot pool every
// villager is offline: a tell still lands in the partner's inbox; say/start_conversation are refused by name.
test('wiring (D-18): tell delivers to the partner inbox; say/start_conversation refuse an offline villager', async (t) => {
  const { host } = await bootGod(t);
  assert.ok(host.tools);
  const told = await host.tools.dispatch(call('tell', { to: 'Alban', text: 'viens au champ' }), FIRMIN);
  assert.equal(told.ok, undefined, told.content);
  assert.equal((await getJson(host.adminPort, '/villagers/Alban')).body.inboxDepth, 1);
  const rows = (await getJson(host.adminPort, '/journal?kinds=inbox.delivered,chat.said')).body.events;
  assert.ok(rows.some((e: any) => e.kind === 'chat.said' && e.payload.to === 'Alban'));
  assert.ok(rows.some((e: any) => e.kind === 'inbox.delivered' && e.actor === 'villager:Firmin'));
  const said = await host.tools.dispatch(call('say', { text: 'bonjour' }), FIRMIN);
  assert.match(said.content, /pas connecté/);
  const conv = await host.tools.dispatch(call('start_conversation', { with: 'Alban', topic: 'blé' }), FIRMIN);
  assert.match(conv.content, /pas connecté/);
});

// B3.4: GodService got no describer, so admitted skills kept the author's summary as their description. Through
// start() (the test config's provider has no endpoint, so the pass takes its code-derived fallback).
test('wiring (B3.4): admitting a draft runs the description pass on the final code', async (t) => {
  const { host } = await bootGod(t);
  assert.ok(host.tools && host.god);
  const code = 'async function cueillir(bot, args, ctx) { return { ok: true }; }';
  const w = await host.tools.dispatch(call('write_skill', { name: 'cueillir', summary: 'résumé de l’auteur', params: { type: 'object', properties: {} }, returns: { type: 'object', properties: {} }, code }), FIRMIN);
  assert.ok(w.authored, w.content);
  const before = (await getJson(host.adminPort, '/skills/cueillir')).body;
  assert.equal(before.description, 'résumé de l’auteur', 'a draft carries the author summary');
  await host.god.routeVerdict(
    { ticketId: 't', success: true, critique: 'ok', libraryAction: 'admit' },
    { rolloutId: 'r-none', draft: w.authored!, task: { id: 'task-x', goal: 'g', successCriteria: 's', context: '', maxRetries: 1 } },
  );
  const after = (await getJson(host.adminPort, '/skills/cueillir')).body;
  assert.equal(after.status, 'active-probation');
  assert.notEqual(after.description, 'résumé de l’auteur', 'the description now comes from the code');
  assert.match(after.description, /cueillir/);
});
