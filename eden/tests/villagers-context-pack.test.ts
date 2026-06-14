import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryJournal } from './fakes/memory-journal';
import { ContextPackBuilder, type ContextPackInput, type RevisionTurn } from '../src/villagers/context-pack';
import { renderSnapshot } from '../src/render/snapshot';
import { estimateTokens } from '../src/render/tokens';
import type { LlmMessage } from '../src/llm/client';
import type { RunReport, RunnerRef, Snapshot } from '../src/types/index';

const RUNNER: RunnerRef = { name: 'Firmin', role: 'farmer', tier: 'mortal' };

const SNAP: Snapshot = {
  biome: 'plains',
  time: 1200,
  position: [12, 64, -30],
  health: 18,
  hunger: 15,
  equipment: ['iron_helmet', 'iron_chestplate'],
  inventory: [
    { name: 'oak_log', count: 12 },
    { name: 'stick', count: 4 },
  ],
  nearbyEntities: [
    { name: 'Firmin', distance: 3 },
    { name: 'zombie', distance: 8 },
  ],
  nearbyBlocks: ['oak_log', 'dirt', 'grass_block'],
  knownChests: [[10, 64, 10]],
};

function runReport(over: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'run-1',
    rolloutId: 'roll-1',
    skill: 'collect-oak-logs',
    version: 1,
    villager: 'Firmin',
    args: { count: 3 },
    outcome: { ok: false, error: 'no block at 0,0,0', errorKind: 'Error' },
    startedAt: 1000,
    durationMs: 1234,
    pulses: 5,
    deepestDepth: 0,
    callTree: [],
    worldBefore: SNAP,
    worldAfter: SNAP,
    ...over,
  };
}

function baseInput(over: Partial<ContextPackInput> = {}): ContextPackInput {
  return {
    villager: 'Firmin',
    runner: RUNNER,
    persona: 'Tu es Firmin, fermier du village. Tu parles français.',
    role: 'farmer',
    mood: 'concentré',
    standingOrders: 'Garde les greniers pleins.',
    triggers: ['directive de Dieu: récolte 3 bûches de chêne'],
    hint: 'authoring',
    snapshot: SNAP,
    runningSkill: null,
    directive: { goal: 'récolte 3 bûches de chêne', reason: 'le grenier est vide' },
    openTask: { goal: 'collect 3 oak logs' },
    recentEvents: ['j’ai planté du blé', 'Anselme m’a salué'],
    retrievedSkills: [
      { name: 'collect-blocks', signature: 'collect-blocks({x,y,z}) → {collected}', summary: 'récolter un tronc', tags: ['wood'], tier: 'mortal', score: 0.9 },
    ],
    memories: ['la forêt est au nord-est'],
    exemplars: [{ name: 'go-to', code: 'async function goTo(bot,a,c){ return {arrived:true}; }' }],
    includeExemplarCode: true,
    toolNames: ['search_skills', 'read_skill', 'write_skill', 'run_skill', 'report_to_god', 'done'],
    inbox: [],
    tier: 'strong',
    inputTokenBudget: 48000,
    ...over,
  };
}

/** A prior revision turn: one write_skill tool call + its result (a whole R20 pair). */
function revision(i: number, codeLines = 50): RevisionTurn {
  const code = Array.from({ length: codeLines }, (_, n) => `  const v${i}_${n} = step(${n}); // essai ${i} ligne ${n}`).join('\n');
  const assistant: LlmMessage = {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: `call_${i}`, name: 'write_skill', arguments: { name: 'collect-oak-logs', code } }],
  };
  const results: LlmMessage[] = [{ role: 'tool', content: `brouillon v${i} créé`, toolCallId: `call_${i}`, name: 'write_skill' }];
  return { assistant, results };
}

test('M3-1: assembles all 8 sections deterministically (golden), with the shared Snapshot renderer', () => {
  const builder = new ContextPackBuilder({ journal: new MemoryJournal() });
  const pack = builder.build(baseInput());

  const system = pack.messages.find((m) => m.role === 'system');
  assert.ok(system, 'a system frame message');
  const frame = system!.content ?? '';

  // All eight section headers present, in order.
  const headers = ['IDENTITÉ', 'DÉCLENCHEUR', 'SITUATION', 'ACTIVITÉ', 'MÉMOIRE RÉCENTE', 'MÉMOIRE PERTINENTE', 'CAPACITÉS', 'BOÎTE DE RÉCEPTION'];
  let cursor = -1;
  for (const h of headers) {
    const at = frame.indexOf(h);
    assert.ok(at > cursor, `section ${h} present and after the previous one`);
    cursor = at;
  }

  // §3 uses the ONE shared renderer verbatim (shared with God).
  assert.ok(frame.includes(renderSnapshot(SNAP)), 'situation embeds the shared Snapshot render');

  // sectionSizes has all 8 keys, each a token count.
  assert.deepEqual(
    Object.keys(pack.sectionSizes).sort(),
    ['activity', 'capabilities', 'identity', 'inbox', 'recentPast', 'retrievedPast', 'situation', 'trigger'].sort(),
  );

  // Determinism: same input → byte-identical frame.
  const pack2 = new ContextPackBuilder({ journal: new MemoryJournal() }).build(baseInput());
  assert.equal(pack2.messages.find((m) => m.role === 'system')!.content, frame);
});

test('M3-1 (§7): exemplar full code only when authoring; one-liners otherwise; tools always', () => {
  const authoring = new ContextPackBuilder({ journal: new MemoryJournal() }).build(baseInput({ includeExemplarCode: true }));
  const reactive = new ContextPackBuilder({ journal: new MemoryJournal() }).build(baseInput({ includeExemplarCode: false }));
  const fa = authoring.messages.find((m) => m.role === 'system')!.content!;
  const fr = reactive.messages.find((m) => m.role === 'system')!.content!;
  assert.ok(fa.includes('async function goTo'), 'authoring wake-up carries exemplar code');
  assert.ok(!fr.includes('async function goTo'), 'reactive wake-up omits exemplar code');
  // The tool list and retrieved one-liners appear in both.
  assert.ok(fa.includes('write_skill') && fr.includes('write_skill'), 'tool list always present');
  assert.ok(fa.includes('collect-blocks') && fr.includes('collect-blocks'), 'retrieved one-liners always present');
});

test('M3-1 (D-11 fit): exemplars + a 400-line draft + snapshot + critique fit strong (48k) with headroom for ≥1 prior revision', () => {
  const draftCode = Array.from({ length: 400 }, (_, n) => `  const a${n} = compute(${n}) + helper(${n}); // ligne de remplissage ${n}`).join('\n');
  const input = baseInput({
    density: {
      draft: { name: 'collect-oak-logs', version: 2, code: draftCode },
      runReport: runReport(),
      critique: 'La boucle ne re-vérifie pas bot.heldItem après cassure de la hache.',
    },
    history: [revision(1)], // one prior revision — must survive (headroom)
  });
  const pack = new ContextPackBuilder({ journal: new MemoryJournal() }).build(input);

  assert.ok(pack.totalTokens <= 48000, `pack ${pack.totalTokens} fits strong 48k`);
  assert.equal(pack.trimmedPairs, 0, 'the one prior revision is kept — headroom ≥ 1 revision');

  // The current density payload is present in full.
  const user = pack.messages.find((m) => m.role === 'user' && (m.content ?? '').includes('TRAVAIL EN COURS'));
  assert.ok(user, 'the density payload rides as a user message');
  assert.ok(user!.content!.includes(draftCode), 'the full current draft is present (never truncated)');
  assert.ok(user!.content!.includes('re-vérifie pas bot.heldItem'), 'the latest critique is present');
  assert.ok(user!.content!.includes('no block at 0,0,0'), 'the latest RunReport error is present verbatim');

  // The prior revision turn rides as an adjacent assistant→tool pair.
  const ai = pack.messages.findIndex((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === 'call_1'));
  assert.ok(ai >= 0, 'prior assistant turn present');
  assert.equal(pack.messages[ai + 1]?.role, 'tool', 'its tool result is adjacent (R20)');
  assert.equal(pack.messages[ai + 1]?.toolCallId, 'call_1');
});

test('M3-1 (D-11 trim): history trims oldest-first as WHOLE tool-call/result pairs, never mid-pair', () => {
  // A small budget that forces dropping some — but never the frame or density.
  const history = [revision(1), revision(2), revision(3), revision(4), revision(5)];
  const frameOnly = new ContextPackBuilder({ journal: new MemoryJournal() }).build(baseInput({ history: [] }));
  // Pick a budget that fits frame+density+~2 revisions but not all 5.
  const oneRev = estimateTokens(JSON.stringify(revision(9)));
  const budget = frameOnly.totalTokens + oneRev * 2 + 50;

  const pack = new ContextPackBuilder({ journal: new MemoryJournal() }).build(
    baseInput({
      density: { draft: { name: 'collect-oak-logs', version: 6, code: 'async function c(){}' }, critique: 'essaie encore' },
      history,
      inputTokenBudget: budget,
    }),
  );

  assert.ok(pack.trimmedPairs > 0, 'some oldest pairs were dropped');
  assert.ok(pack.totalTokens <= budget, 'the trimmed pack fits the budget');

  // Whatever survived: every assistant(tool_calls) turn is immediately followed by its result(s) — never split.
  for (let i = 0; i < pack.messages.length; i++) {
    const m = pack.messages[i]!;
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      for (let k = 0; k < m.toolCalls.length; k++) {
        const r = pack.messages[i + 1 + k];
        assert.equal(r?.role, 'tool', 'assistant tool call is followed by its tool result (R20, whole pair)');
        assert.equal(r?.toolCallId, m.toolCalls[k]!.id, 'result answers the adjacent call');
      }
    }
  }

  // Oldest dropped, newest kept: revision 5 survives, revision 1 does not.
  const ids = pack.messages.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []);
  assert.ok(ids.includes('call_5'), 'newest revision kept');
  assert.ok(!ids.includes('call_1'), 'oldest revision dropped');
});

test('M3-1 (R47): the current density payload is NEVER trimmed, even under an absurdly small budget', () => {
  const draftCode = Array.from({ length: 200 }, (_, n) => `  line ${n} of the current draft under revision`).join('\n');
  const pack = new ContextPackBuilder({ journal: new MemoryJournal() }).build(
    baseInput({
      density: { draft: { name: 'x', version: 3, code: draftCode }, runReport: runReport(), critique: 'critique vitale' },
      history: [revision(1), revision(2)],
      inputTokenBudget: 10, // smaller than even the frame — must not corrupt the payload
    }),
  );
  // All prior revisions dropped...
  assert.equal(pack.trimmedPairs, 2, 'every prior revision dropped under the tiny budget');
  // ...but the frame and the density payload are STILL present (never trimmed — R47).
  assert.ok(pack.messages.some((m) => m.role === 'system'), 'frame still present');
  const user = pack.messages.find((m) => m.role === 'user' && (m.content ?? '').includes('TRAVAIL EN COURS'));
  assert.ok(user && user.content!.includes(draftCode), 'the full current draft survives the tiny budget');
  assert.ok(user!.content!.includes('critique vitale'), 'the critique survives');
});

test('M3-1: a section over its ceiling is truncated (the per-section truncation rule exists)', () => {
  const huge = Array.from({ length: 5000 }, (_, n) => `événement récent numéro ${n}`);
  const pack = new ContextPackBuilder({ journal: new MemoryJournal() }).build(baseInput({ recentEvents: huge }));
  const frame = pack.messages.find((m) => m.role === 'system')!.content!;
  assert.ok(frame.includes('(tronqué)'), 'the over-ceiling section is truncated with a marker');
  // The truncation keeps the pack bounded — recentPast section size is capped.
  assert.ok(pack.sectionSizes['recentPast']! <= 2000, 'recentPast respects its token ceiling');
});

test('M3-1: journals brain.wakeup with the section sizes + trim count (D-11 observability)', () => {
  const journal = new MemoryJournal();
  const builder = new ContextPackBuilder({ journal });
  builder.build(baseInput({ history: [revision(1)] }), { refs: { rolloutId: 'roll-1' } });
  const ev = journal.query({ kinds: ['brain.wakeup'] });
  assert.equal(ev.length, 1);
  const p = ev[0]!.payload as { villager: string; sections: Record<string, number>; totalTokens: number; trimmedPairs: number; tier: string };
  assert.equal(p.villager, 'Firmin');
  assert.equal(p.tier, 'strong');
  assert.ok(p.totalTokens > 0 && Object.keys(p.sections).length === 8);
  assert.equal(ev[0]!.refs.rolloutId, 'roll-1', 'the wake-up is tied to its rollout (refs.rolloutId)');
  assert.equal(ev[0]!.actor, 'villager:Firmin', 'the actor is the villager (R41)');
});
