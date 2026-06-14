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

  // Every GET route answers.
  assert.equal((await getJson(port, '/status')).body.bots, 0);
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
  assert.equal((await getJson(port, '/status')).body.queues.paused, true, 'pause gated the live LLM scheduler');
  const resume = await postJson(port, '/resume');
  assert.equal(resume.status, 200);
  assert.equal((await getJson(port, '/status')).body.queues.paused, false);

  // prompt → inbox.delivered journaled BEFORE delivery (the website's talk box).
  const prompt = await postJson(port, '/villagers/Firmin/prompt', { text: 'va aux champs', from: 'paul' });
  assert.equal(prompt.status, 200);
  const delivered = (await getJson(port, '/journal?kinds=inbox.delivered')).body.events;
  assert.ok(delivered.some((e: any) => e.payload.to === 'Firmin' && e.payload.kind === 'tell'), 'tell journaled');
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
