// The runtime over HTTP: the control API, the SSE stream, and the authoring tools through the official MCP client
// (what Claude Code speaks). Bots are FakeBots that "spawn" on the next tick; nothing touches Minecraft.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { parseConfig } from '../src/config';
import { start, type Started } from '../src/main';
import { FakeBot } from './fakes/fake-bot';
import { holdEventLoopPerTest } from './fakes/keep-alive';
import { until } from './fakes/harness';

holdEventLoopPerTest(60_000);

const TOKEN = 'test-token';
const PAUL = { uuid: 'uuid-paul', name: 'Paul' };
const ALICE = { uuid: 'uuid-alice', name: 'Alice' };
let dir: string;
let rt: Started;
let base: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'squad-http-'));
  const cfg = parseConfig({ port: 0, dataDir: dir, loginStaggerMs: 1 }, { PAULSBRAWLS_SQUAD_TOKEN: TOKEN });
  rt = await start(cfg, {
    connectBots: true,
    pool: {
      createBot: (req) => {
        const b = new FakeBot(req.username);
        setTimeout(() => b.emit('spawn'), 1);
        return b as never;
      },
      setup: () => undefined,
    },
  });
  base = `http://127.0.0.1:${rt.port}`;
});

after(async () => {
  await rt.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, body: unknown = {}, token = TOKEN): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function mcp(): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp/squad'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  return client;
}

const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n');

test('every route needs the token', async () => {
  const r = await api('/api/health', {}, 'wrong');
  assert.equal(r.status, 401);
  const m = await fetch(base + '/mcp/squad', { method: 'POST', body: '{}' });
  assert.equal(m.status, 401);
});

test('spawn is admin-only; owners see their bots; state lists them', async () => {
  const no = await api('/api/bots/spawn', { by: PAUL, admin: false, name: 'Archer1', owners: [PAUL] });
  assert.equal(no.json.ok, false);
  const yes = await api('/api/bots/spawn', { by: PAUL, admin: true, name: 'Archer1', owners: [PAUL, ALICE] });
  assert.equal(yes.json.ok, true, String(yes.json.text));
  assert.match(String(yes.json.text), /Archer1 arrive, propriétaires : Paul, Alice/);
  await until(() => rt.service.deps.pool.status('Archer1') === 'online', 2000, 'Archer1 online');
  const list = await api('/api/bots/list', { by: ALICE });
  assert.match(String(list.json.text), /Archer1 ❤20 — libre/);
  const state = await api('/api/state');
  assert.deepEqual((state.json.bots as Array<{ name: string }>).map((b) => b.name), ['Archer1']);
  assert.ok((state.json.stock as string[]).includes('defend'));
});

test('the authoring flow: open → MCP tools → submit → close says what was submitted', async () => {
  const open = await api('/api/authoring/open', { mode: 'create', by: PAUL, name: 'salute', request: 'saluer', snap: { position: { x: 1, y: 64, z: 2 } } });
  assert.equal(open.json.ok, true, String(open.json.text));
  const ticket = String(open.json.ticket);
  assert.match(String(open.json.message), /Ticket : cmd-/);
  assert.match(String(open.json.message), /Bots de Paul : Archer1/);

  const client = await mcp();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['check_script', 'get_api_reference', 'get_context', 'list_commands', 'read_command', 'submit_command', 'trial_run']);
  assert.match(textOf(await client.callTool({ name: 'get_api_reference', arguments: {} })), /SQUAD COMMAND API/);
  const ctx = JSON.parse(textOf(await client.callTool({ name: 'get_context', arguments: { ticket } })));
  assert.equal(ctx.bots[0].name, 'Archer1');
  assert.match(textOf(await client.callTool({ name: 'list_commands', arguments: { ticket } })), /squad:defend/);
  assert.match(textOf(await client.callTool({ name: 'read_command', arguments: { ticket, name: 'squad:gather' } })), /squad\.tasks/);

  const bad = await client.callTool({ name: 'check_script', arguments: { ticket, source: 'export const manifest = { summary: "s" };\nexport default async (squad) => { squad.bots[0].digBlock(); };' } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /TS2339: Property 'digBlock' does not exist/);

  const source = `export const manifest = { summary: 'Saluer' };
export default async function (squad, args, ctx) {
  await squad.parallel(squad.bots, (bot) => bot.chat('Salut ' + ctx.commander.name));
  return 'Salué.';
}`;
  const trial = await client.callTool({ name: 'trial_run', arguments: { ticket, source } });
  assert.equal(trial.isError, undefined, textOf(trial));
  assert.match(textOf(trial), /status: done/);
  assert.match(textOf(trial), /returned: Salué\./);

  const sub = await client.callTool({ name: 'submit_command', arguments: { ticket, source } });
  assert.match(textOf(sub), /Submitted salute v1\. The player orders it with: \/bots order salute/);
  const again = await client.callTool({ name: 'submit_command', arguments: { ticket, source } });
  assert.equal(again.isError, true);
  await client.close();

  const close = await api('/api/authoring/close', { ticket });
  assert.deepEqual(close.json.submitted, { version: 1, summary: 'Saluer', usage: '/bots order salute' });
  const dead = await (await mcp()).callTool({ name: 'get_context', arguments: { ticket } });
  assert.equal(dead.isError, true);
  assert.match(textOf(dead), /unknown or expired ticket/);
});

test('an order runs and its end arrives as an SSE notice; sharing lets Alice order it', async () => {
  const ctrl = new AbortController();
  const res = await fetch(base + '/events', { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal });
  const reader = res.body!.getReader();
  let buf = '';
  const read = async (pattern: RegExp): Promise<string> => {
    const end = Date.now() + 5000;
    while (!pattern.test(buf)) {
      if (Date.now() > end) throw new Error('no SSE event matching ' + pattern + ' in ' + buf);
      const { value } = await reader.read();
      buf += new TextDecoder().decode(value);
    }
    return buf;
  };
  await read(/event: hello/);
  const share = await api('/api/commands/share', { by: PAUL, name: 'salute', players: [ALICE] });
  assert.match(String(share.json.text), /partagée avec Alice/);
  const o = await api('/api/orders/start', { by: ALICE, command: 'salute', tokens: [], snap: {} });
  assert.equal(o.json.ok, true, String(o.json.text));
  const got = await read(/« salute » terminé : Salué\./);
  assert.match(got, /"to":\["uuid-alice"\]/);
  ctrl.abort();
});

test('show, stop, revert and delete answer in French', async () => {
  const show = await api('/api/commands/show', { by: PAUL, name: 'defend' });
  assert.match(String(show.json.text), /Usage : \/bots order defend \[radius=16\]/);
  const stop = await api('/api/orders/stop', { by: PAUL, target: '' });
  assert.equal(stop.json.text, '[Bots] Aucun ordre à arrêter.');
  const rev = await api('/api/commands/revert', { by: PAUL, name: 'salute', version: 9 });
  assert.match(String(rev.json.text), /pas de version v9/);
  const del = await api('/api/commands/delete', { by: PAUL, name: 'salute' });
  assert.match(String(del.json.text), /supprimée \(aussi pour Alice\)/);
});

test('metrics: the token is needed; the loop, the process and every bot, with the French line', async () => {
  assert.equal((await api('/api/metrics', {}, 'wrong')).status, 401);
  // A few physics ticks on the spawned bot, then close a window the way the 10 s timer does.
  const bot = rt.service.deps.pool.bot('Archer1') as unknown as FakeBot;
  for (let i = 0; i < 5; i++) bot.emit('physicsTick');
  bot.emit('path_update', { status: 'noPath', time: 1 });
  bot.emit('path_reset', 'stuck');
  rt.service.deps.vitals!.sample();
  const r = await api('/api/metrics');
  assert.equal(r.status, 200);
  const m = r.json as {
    ok: boolean;
    text: string;
    window: { seconds: number; complete: boolean };
    loop: { p50: number; p99: number; max: number };
    elu: number;
    cpuPct: number;
    rssMb: number;
    heapMb: number;
    skippedPackets: number;
    bots: Array<{ name: string; status: string; ticksPerSec: number | null; path: Record<string, number>; resets: Record<string, number>; deafTrips: number }>;
  };
  assert.equal(m.ok, true);
  assert.equal(m.window.complete, true);
  for (const v of [m.loop.p50, m.loop.p99, m.loop.max, m.elu, m.cpuPct, m.rssMb, m.heapMb, m.skippedPackets]) assert.equal(typeof v, 'number');
  assert.ok(m.rssMb > 0);
  const a = m.bots.find((b) => b.name === 'Archer1');
  assert.ok(a, 'Archer1 is listed');
  assert.equal(a.status, 'online');
  assert.equal(a.path.noPath, 1);
  assert.deepEqual(a.resets, { stuck: 1 });
  assert.equal(a.deafTrips, 0);
  assert.match(m.text, /^\[Bots\] Charge du runtime \(\d+ s\) : ELU \d+,\d\d · boucle p99 \d+ ms \(max \d+\) · CPU \d+ % · RAM \d+ Mo · /);
});

test('bound items over HTTP: check, a trigger starts, a second restarts an order that does not listen, stop', async () => {
  const check = await api('/api/orders/check', { by: PAUL, admin: false, command: 'follow', tokens: ['4'], filters: ['archer1'] });
  assert.deepEqual(check.json, { ok: true, text: '[Bots] Ordre « follow » : Me suivre', command: 'follow', summary: 'Me suivre' });
  const bad = await api('/api/orders/check', { by: PAUL, command: 'follow', tokens: ['99'] });
  assert.deepEqual(bad.json, { ok: false, text: '[Bots] « range » : maximum 16. Usage : /bots order follow [range=3]' });
  assert.equal((await api('/api/orders/check', { by: PAUL, tokens: [] })).status, 400, 'command is required');

  // The snapshot is sanitized on the way in: an unknown key is dropped, the entity id becomes a number.
  const snap = { position: { x: 1, y: 64, z: 2 }, trigger: { kind: 'use', item: 'shield', evil: 1 }, lookEntity: { id: '5', name: 'zombie', type: 'mob', position: { x: 3, y: 64, z: 2 } } };
  const start = await api('/api/orders/trigger', { by: PAUL, admin: false, command: 'follow', tokens: [], filters: [], snap });
  assert.equal(start.json.ok, true, String(start.json.text));
  assert.equal(start.json.started, true);
  assert.match(String(start.json.text), /« follow » lancé \(#\d+\) : Archer1\./);
  const first = rt.service.deps.runner.get(String(start.json.orderId))!;
  assert.deepEqual(first.snap.trigger, { kind: 'use', item: 'shield' });
  assert.equal(first.snap.lookEntity?.id, 5);

  const again = await api('/api/orders/trigger', { by: PAUL, command: 'follow', tokens: ['5'], snap: { ...snap, position: { x: 9, y: 64, z: 2 } } });
  assert.equal(again.json.restarted, true, String(again.json.text));
  assert.notEqual(again.json.orderId, start.json.orderId);
  assert.equal(first.status, 'stopped');
  assert.deepEqual(rt.service.deps.runner.get(String(again.json.orderId))!.args, { range: 5 });

  const stop = await api('/api/orders/trigger', { by: PAUL, command: 'follow', tokens: [], stop: true, snap: {} });
  assert.deepEqual(stop.json, { ok: true, text: '[Bots] « follow » arrêté.', orderId: again.json.orderId, stopped: true });
  const none = await api('/api/orders/trigger', { by: PAUL, command: 'follow', tokens: [], stop: true, snap: {} });
  assert.equal(none.json.text, '[Bots] Aucun ordre « follow » en cours.');
});
