import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeBot } from './fakes/fake-bot';
import { ScriptedLlm } from './fakes/scripted-llm';

// Deterministic under parallel load (was a wall-clock-window flake): instead of sampling a fixed
// 90 ms window and counting ticks — which a saturated event loop can starve below the bar — we wait
// for the 3rd path_update to ARRIVE, with a generous overall timeout. The seam under test is "emits
// path_update repeatedly without moving"; the exact tick rate under contention is not the contract.
test('FakeBot emits path_update on a timer without moving (D-10 seam)', async () => {
  const bot = new FakeBot({ position: { x: 10, y: 64, z: 10 } });
  const updates: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error(`only ${updates.length} path_update events in 2000ms`)), 2000);
    guard.unref?.();
    bot.on('path_update', (u) => {
      updates.push(u);
      if (updates.length >= 3) {
        clearTimeout(guard);
        resolve();
      }
    });
    bot.startPathUpdates(20);
  });
  bot.stopPathUpdates();
  assert.ok(updates.length >= 3, `expected >=3 path_update events, got ${updates.length}`);
  assert.deepEqual(bot.entity.position, { x: 10, y: 64, z: 10 }, 'position must stay constant');
});

test('FakeBot dig returns a controllable never-resolving promise with one start pulse (D-10 seam)', async () => {
  const bot = new FakeBot();
  bot.setDigMode('never');
  let started = 0;
  bot.on('diggingStarted', () => started++);
  const block = { name: 'oak_log', position: { x: 0, y: 64, z: 1 } };

  // 200 ms (was 40 ms) gives the timeout headroom on a saturated event loop: the never-resolving dig
  // can never win the race, so a longer window only makes the "pending" verdict more robust, never less.
  const settled = await Promise.race([
    bot.dig(block).then(() => 'resolved'),
    new Promise((r) => setTimeout(() => r('pending'), 200)),
  ]);
  assert.equal(settled, 'pending', 'dig must not resolve in never mode');
  assert.equal(started, 1, 'exactly one start pulse');
});

test('FakeBot routes clicks to the OPEN window regardless of intent (R1 seam)', () => {
  const bot = new FakeBot();
  bot.openWindow({ id: 42, type: 'minecraft:generic_9x3', title: 'Chest' });
  void bot.clickWindow(5, 0, 0);
  assert.equal(bot.clicks.length, 1);
  assert.equal(bot.clicks[0]?.routedTo, 42, 'click hijacked by the stray chest window');

  const packets: unknown[] = [];
  bot._client.on('set_slot', (p) => packets.push(p));
  bot.packetSetSlot(42, 5, { name: 'stick', count: 1 });
  assert.equal(packets.length, 1, 'set_slot packet seam works (R3 quiescence)');
});

test('FakeBot models a grounded trunk separate from floating leaves (R10 seam)', () => {
  const bot = new FakeBot();
  bot.plantTree({ x: 0, y: 64, z: 0 }, 4, [{ x: 3, y: 70, z: 3 }]);
  assert.equal(bot.blockAt({ x: 0, y: 64, z: 0 })?.name, 'oak_log', 'trunk base');
  assert.equal(bot.blockAt({ x: 0, y: 67, z: 0 })?.name, 'oak_log', 'trunk top');
  assert.equal(bot.blockAt({ x: 3, y: 70, z: 3 })?.name, 'oak_log', 'floating log present');
  assert.equal(bot.blockAt({ x: 9, y: 9, z: 9 }), null, 'air elsewhere');
});

test('FakeBot exposes auto-eat / armor-manager hooks the craft path pauses (R1–R3)', () => {
  const bot = new FakeBot();
  assert.equal(bot.autoEat.enabled, true);
  bot.autoEat.disableAuto();
  assert.equal(bot.autoEat.enabled, false);
  assert.equal(typeof bot.armorManager.equipAll, 'function');
});

test('ScriptedLlm returns canned tool-call then content turns in order (R42)', async () => {
  const llm = await ScriptedLlm.start([
    { toolCalls: [{ name: 'write_skill', arguments: { name: 'collect-logs' } }] },
    { content: 'done', finishReason: 'stop' },
  ]);
  try {
    const r1 = await postChat(llm.url, { messages: [{ role: 'user', content: 'go' }] });
    assert.equal(r1.choices[0].finish_reason, 'tool_calls');
    assert.equal(r1.choices[0].message.tool_calls[0].function.name, 'write_skill');

    const r2 = await postChat(llm.url, { messages: [{ role: 'user', content: 'next' }] });
    assert.equal(r2.choices[0].message.content, 'done');
    assert.equal(r2.choices[0].finish_reason, 'stop');

    assert.equal(llm.requests.length, 2, 'requests are recorded for assertions');
  } finally {
    await llm.close();
  }
});

test('ScriptedLlm serves stable embeddings for cosine tests (M2-L2 seam)', async () => {
  const llm = await ScriptedLlm.start();
  try {
    const res = await fetch(`${llm.url}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: ['hello', 'hello'] }),
    });
    const json = (await res.json()) as any;
    assert.equal(json.data.length, 2);
    assert.deepEqual(json.data[0].embedding, json.data[1].embedding, 'same text → same vector');
  } finally {
    await llm.close();
  }
});

async function postChat(baseUrl: string, body: object): Promise<any> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
