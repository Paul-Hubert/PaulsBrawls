// M7-2 — eval-harness port (R42). CI proves the harness LOGIC with NO Minecraft: the reserved-username
// prefix can't collide with production (R12), the per-bot-EXCLUSIVE seed collision guard rejects a
// duplicate claim (R42's sharpest edge), the world fixtures are RCON-idempotent (the fixture COMMANDS +
// idempotency are unit-testable; the RCON send itself is smoke-time), the ambient-suppression eval roster
// is built (huge heartbeats, embeddings off), and the scripted mock LLM is deterministic on its own port.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVAL_USERNAME_PREFIX,
  buildEvalRoster,
  ScenarioRegistry,
  V1_RESERVED_NAMES,
} from '../eval/roster';
import { fixtureCommands, isIdempotentFixture } from '../eval/fixtures';
import { startMockLlm } from '../eval/mock-llm';

// ── Reserved username prefix (R12) ───────────────────────────────────────────
test('eval usernames share a reserved prefix that cannot collide with production (R12)', () => {
  const roster = buildEvalRoster(3);
  assert.ok(roster.villagers.every((v) => v.name.startsWith(EVAL_USERNAME_PREFIX)));
  // None of the eval names may equal a v1 reserved name or Eden's production avatar.
  for (const v of roster.villagers) {
    assert.ok(!V1_RESERVED_NAMES.includes(v.name), `${v.name} collides with a reserved production name`);
  }
  assert.ok(roster.god.name.startsWith(EVAL_USERNAME_PREFIX), 'the eval avatar is prefixed too (R12)');
  assert.ok(!V1_RESERVED_NAMES.includes(roster.god.name));
  // The prefix itself must not be a substring of any reserved production username.
  assert.ok(!V1_RESERVED_NAMES.some((n) => n.startsWith(EVAL_USERNAME_PREFIX)));
});

test('the eval roster suppresses ambient machinery (huge heartbeats, embeddings off) — R42', () => {
  const roster = buildEvalRoster(2);
  // Ambient suppression: scenarios drive everything explicitly, so background wake-ups must be inert.
  assert.ok(roster.config.behavior.drives === false, 'drives off — no ambient tired/lonely wake-ups');
  assert.equal(roster.config.llm.providers.strong.baseUrl, '', 'no real provider — the mock is injected per-scenario');
  assert.ok(roster.embeddings === 'off', 'embeddings off — deterministic keyword retrieval');
  assert.ok(roster.heartbeatSeconds >= 3600, 'huge heartbeat — ambient deliberation effectively never fires');
});

// ── Per-bot EXCLUSIVE seed collision guard (R42 sharpest edge) ────────────────
test('ScenarioRegistry: a scenario claims an unclaimed bot; a duplicate claim is rejected', () => {
  const reg = new ScenarioRegistry(buildEvalRoster(3).villagers.map((v) => v.name));
  reg.register({ id: 'reflex-flee', bot: 'EvalBot0', seeds: ['/give @s minecraft:bread 1'] });
  reg.register({ id: 'trade-basic', bot: 'EvalBot1', seeds: [] });

  // The sharpest edge: a NEW scenario must claim an UNCLAIMED bot or it silently clobbers another's seed.
  assert.throws(
    () => reg.register({ id: 'reflex-eat', bot: 'EvalBot0', seeds: ['/give @s minecraft:apple 1'] }),
    /EvalBot0.*already claimed by reflex-flee/,
    'a duplicate per-bot seed claim is rejected, not silently clobbered (R42)',
  );
});

test('ScenarioRegistry: claiming an unknown bot (outside the roster) is rejected', () => {
  const reg = new ScenarioRegistry(['EvalBot0', 'EvalBot1']);
  assert.throws(() => reg.register({ id: 'x', bot: 'EvalBot9', seeds: [] }), /not in the eval roster/);
});

test('ScenarioRegistry: claimed() reports which bots a scenario set owns', () => {
  const reg = new ScenarioRegistry(['EvalBot0', 'EvalBot1', 'EvalBot2']);
  reg.register({ id: 's1', bot: 'EvalBot0', seeds: [] });
  reg.register({ id: 's2', bot: 'EvalBot2', seeds: [] });
  assert.deepEqual(reg.claimedBots().sort(), ['EvalBot0', 'EvalBot2']);
  assert.deepEqual(reg.freeBots(['EvalBot0', 'EvalBot1', 'EvalBot2']), ['EvalBot1']);
});

// ── RCON-idempotent world fixtures ───────────────────────────────────────────
test('world fixtures are RCON-idempotent: re-applying the same fixture is a no-op-safe set of commands', () => {
  const fx = { player: 'EvalBot0', clearInventory: true, give: [{ item: 'minecraft:oak_log', count: 3 }], tp: [0, 64, 0] as [number, number, number] };
  const cmds = fixtureCommands(fx);
  // Idempotency: every command is an absolute SET (clear/give/tp), never a relative mutation — so running
  // the fixture twice leaves the world in the same state (R42: idempotent world fixtures via RCON).
  assert.ok(cmds.some((c) => c.startsWith('clear EvalBot0')));
  assert.ok(cmds.some((c) => c.includes('give EvalBot0 minecraft:oak_log 3')));
  assert.ok(cmds.some((c) => c.startsWith('tp EvalBot0 ')));
  assert.equal(isIdempotentFixture(cmds), true);

  // A relative command (a non-idempotent mutation) is flagged.
  assert.equal(isIdempotentFixture(['give EvalBot0 minecraft:oak_log 3', 'effect give EvalBot0 speed 999 1 true']), true);
  assert.equal(isIdempotentFixture(['summon minecraft:zombie ~ ~ ~']), false, 'relative-coord summon is not idempotent');
});

// ── Deterministic scripted mock LLM on its own port ──────────────────────────
test('the scripted mock LLM serves deterministic canned turns on its own port', async (t) => {
  const llm = await startMockLlm([
    { toolCalls: [{ name: 'run_skill', arguments: { name: 'go-to' } }] },
    { content: 'done', finishReason: 'stop' },
  ]);
  t.after(() => llm.close());
  assert.match(llm.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);

  const res = await fetch(`${llm.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
  const json: any = await res.json();
  assert.equal(json.choices[0].finish_reason, 'tool_calls');
  assert.equal(json.choices[0].message.tool_calls[0].function.name, 'run_skill');
});
