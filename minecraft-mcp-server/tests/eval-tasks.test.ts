import test from 'ava';
import { parseChatRequest, type MockReply } from '../eval/mock-llm.js';
import { buildCraftingTableHandler, T1_GOAL_MARKER } from '../eval/scenarios/tasks/t1-get-crafting-table.js';
import { buildPlantTogetherHandler, T2_GOAL_MARKER, T2_SPOTS } from '../eval/scenarios/tasks/t2-plant-together.js';

/**
 * Pins the tasks-suite scripted mock handlers — pure state machines keyed off
 * the accumulated tool results. T1 walks the gather→craft pipeline
 * (collect_blocks → craft oak_planks → craft crafting_table → done); T2
 * batches five seed placements per farmer, then done. The result strings
 * mirror what agent-tools.ts actually returns.
 */

interface RequestOverrides {
  bot?: string;
  kind?: string;
  reason?: string;
}

function thinkRequest(toolResults: string[], overrides: Required<Pick<RequestOverrides, 'bot' | 'reason'>> & { kind?: string }) {
  const kind = overrides.kind ?? 'job';
  return parseChatRequest({
    messages: [
      { role: 'system', content: `You are ${overrides.bot}, the crafter of a small Minecraft village.` },
      { role: 'user', content: `WHY YOU ARE AWAKE (${kind}):\n- ${overrides.reason}\n\nOBSERVATION: {"you":{"name":"${overrides.bot}"}}` },
      ...toolResults.map((content) => ({ role: 'tool', content })),
    ],
  });
}

function jobRequest(toolResults: string[] = [], overrides: RequestOverrides = {}) {
  return thinkRequest(toolResults, {
    bot: overrides.bot ?? 'EvalEnclume',
    kind: overrides.kind,
    reason: overrides.reason ?? `${T1_GOAL_MARKER} — récolte le bois proche`,
  });
}

function calledTools(reply: MockReply | null): string[] {
  if (!reply || !('toolCalls' in reply)) return [];
  return reply.toolCalls.map((c) => c.name);
}

test('T1 handler starts with a wood gather', (t) => {
  const reply = buildCraftingTableHandler()(jobRequest());
  t.deepEqual(calledTools(reply), ['collect_blocks']);
  t.like(reply, { toolCalls: [{ args: { blockType: 'oak_log' } }] });
});

test('T1 handler retries the gather after a failed collect', (t) => {
  const reply = buildCraftingTableHandler()(
    jobRequest(['ERROR: no oak_log visible within 32 blocks (only loaded terrain is searched — move elsewhere and retry)'])
  );
  t.deepEqual(calledTools(reply), ['collect_blocks']);
});

test('T1 handler crafts planks once logs are collected', (t) => {
  const reply = buildCraftingTableHandler()(jobRequest(['collected 2 oak_log']));
  t.deepEqual(calledTools(reply), ['craft']);
  // count = recipe executions: 1 execution (1 log) yields the 4 planks needed.
  t.like(reply, { toolCalls: [{ args: { item: 'oak_planks', count: 1 } }] });
});

test('T1 handler crafts the table once planks exist', (t) => {
  const reply = buildCraftingTableHandler()(jobRequest(['collected 2 oak_log', 'crafted oak_planks x1']));
  t.deepEqual(calledTools(reply), ['craft']);
  t.like(reply, { toolCalls: [{ args: { item: 'crafting_table', count: 1 } }] });
});

test('T1 handler finishes with done after the table is crafted', (t) => {
  const reply = buildCraftingTableHandler()(
    jobRequest(['collected 2 oak_log', 'crafted oak_planks x1', 'crafted crafting_table x1'])
  );
  t.deepEqual(calledTools(reply), ['done']);
});

test('T1 handler ignores other bots, kinds and reasons', (t) => {
  const handler = buildCraftingTableHandler();
  t.is(handler(jobRequest([], { bot: 'EvalMargaux' })), null);
  t.is(handler(jobRequest([], { kind: 'heartbeat' })), null);
  t.is(handler(jobRequest([], { reason: 'periodic reflection: check surroundings' })), null);
});

// -- T2 plant-together ---------------------------------------------------------

function plantRequest(bot: string, toolResults: string[] = [], overrides: Pick<RequestOverrides, 'kind' | 'reason'> = {}) {
  return thinkRequest(toolResults, {
    bot,
    kind: overrides.kind,
    reason: overrides.reason ?? `${T2_GOAL_MARKER} — tu as 5 graines de blé`,
  });
}

test('T2 handler batches five seed placements on the farmer half it owns', (t) => {
  const handler = buildPlantTogetherHandler();
  for (const farmer of ['EvalMargaux', 'EvalFirmin']) {
    const reply = handler(plantRequest(farmer));
    t.truthy(reply);
    if (!reply || !('toolCalls' in reply)) return t.fail(`${farmer}: expected tool calls`);
    t.is(reply.toolCalls.length, 5);
    t.true(reply.toolCalls.every((c) => c.name === 'place' && c.args.item === 'wheat_seeds'));
    t.deepEqual(
      reply.toolCalls.map((c) => ({ x: c.args.x, z: c.args.z })),
      T2_SPOTS[farmer].map((s) => ({ x: s.x, z: s.z }))
    );
  }
});

test('T2 farmer halves do not overlap and total ten spots', (t) => {
  const a = T2_SPOTS['EvalMargaux'].map((s) => `${s.x},${s.z}`);
  const b = T2_SPOTS['EvalFirmin'].map((s) => `${s.x},${s.z}`);
  t.is(new Set([...a, ...b]).size, 10);
});

test('T2 handler wraps up with done after its batch ran', (t) => {
  const results = ['placed wheat_seeds', 'placed wheat_seeds', 'placed wheat_seeds', 'placed wheat_seeds', 'placed wheat_seeds'];
  const reply = buildPlantTogetherHandler()(plantRequest('EvalMargaux', results));
  t.deepEqual(calledTools(reply), ['done']);
});

test('T2 handler ignores other bots, kinds and reasons', (t) => {
  const handler = buildPlantTogetherHandler();
  t.is(handler(plantRequest('EvalEnclume')), null);
  t.is(handler(plantRequest('EvalMargaux', [], { kind: 'heartbeat' })), null);
  t.is(handler(plantRequest('EvalMargaux', [], { reason: 'periodic reflection' })), null);
});
