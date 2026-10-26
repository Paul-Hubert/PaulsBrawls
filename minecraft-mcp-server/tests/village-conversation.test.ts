import test from 'ava';
import { extractSpokenText } from '../src/village/agent-runtime.js';
import { ConversationManager, lineSimilarity, newsToShare } from '../src/village/conversation.js';
import { VillageContext } from '../src/village/context.js';
import { tagsFor } from '../src/village/memory-index.js';
import { MemoryEntry, ThinkKind } from '../src/village/types.js';
import { Villager } from '../src/village/villager.js';

interface AppendRecord {
  kind: string;
  text: string;
  importance?: number;
}

interface RelationRecord {
  other: string;
  delta: number;
  note?: string;
}

interface FakeWorld {
  ctx: VillageContext;
  conversations: ConversationManager;
  requests: Array<{ bot: string; kind: ThinkKind }>;
  memoryOf: (name: string) => string[];
  appendsOf: (name: string) => AppendRecord[];
  relationsOf: (name: string) => RelationRecord[];
  seedRecent: (name: string, entries: MemoryEntry[]) => void;
}

function fakeVillager(
  name: string,
  memories: Map<string, AppendRecord[]>,
  relations: Map<string, RelationRecord[]>,
  recentEntries: Map<string, MemoryEntry[]>
): Villager {
  memories.set(name, []);
  relations.set(name, []);
  recentEntries.set(name, []);
  return {
    name,
    roster: { name, role: 'farmer', personality: '', home: { x: 0, y: 64, z: 0 } },
    bot: () => ({ entity: { position: { distanceTo: () => 4 } } }),
    mirrorChat: () => { /* no players in tests */ },
    villagersInEarshot: () => [],
    routines: { status: () => null },
    memory: {
      append: (kind: string, text: string, _tags?: string[], importance?: number) =>
        memories.get(name)!.push({ kind, text, importance }),
      adjustRelation: (other: string, delta: number, note?: string) =>
        relations.get(name)!.push({ other, delta, note }),
      relationWith: () => ({ score: 0, notes: '' }),
      topRelations: () => [],
      recent: () => recentEntries.get(name)!,
    },
  } as unknown as Villager;
}

function makeWorld(names: string[]): FakeWorld {
  const memories = new Map<string, AppendRecord[]>();
  const relations = new Map<string, RelationRecord[]>();
  const recentEntries = new Map<string, MemoryEntry[]>();
  const requests: Array<{ bot: string; kind: ThinkKind }> = [];
  const conversations = new ConversationManager();
  const villagers = new Map(names.map((n) => [n, fakeVillager(n, memories, relations, recentEntries)]));
  const ctx = {
    villagers,
    villagerNames: new Set(names),
    settings: { maxConversationTurns: 2, earshotRadius: 32 },
    scheduler: {
      request: (bot: string, kind: ThinkKind) => requests.push({ bot, kind }),
      cancel: () => { /* noop */ },
      pump: () => { /* noop — releases held wake-ups in production */ },
    },
    conversations,
  } as unknown as VillageContext;
  conversations.init(ctx);
  return {
    ctx,
    conversations,
    requests,
    memoryOf: (n) => memories.get(n)!.map((r) => r.text),
    appendsOf: (n) => memories.get(n)!,
    relationsOf: (n) => relations.get(n)!,
    seedRecent: (n, entries) => recentEntries.get(n)!.push(...entries),
  };
}

test('start records the opening and schedules the target turn', (t) => {
  const world = makeWorld(['Margaux', 'Firmin']);
  const error = world.conversations.start('Margaux', 'Firmin', 'Salut Firmin !');
  t.is(error, null);
  const conv = world.conversations.get('Firmin');
  t.truthy(conv);
  t.is(conv!.turnOf, 'Firmin');
  t.deepEqual(world.requests, [{ bot: 'Firmin', kind: 'conversation' }]);
  t.true(world.memoryOf('Firmin').some((m) => m.includes('Salut Firmin !')));
});

test('busy and unknown targets are rejected', (t) => {
  const world = makeWorld(['A', 'B', 'C']);
  t.is(world.conversations.start('A', 'A', 'hi'), 'cannot start a conversation with yourself');
  t.truthy(world.conversations.start('A', 'Nobody', 'hi'));
  t.is(world.conversations.start('A', 'B', 'hi'), null);
  t.truthy(world.conversations.start('C', 'B', 'hi'), 'B is busy');
  t.truthy(world.conversations.start('A', 'C', 'hi'), 'A is busy too');
});

test('turns alternate and off-turn speech is rejected', (t) => {
  const world = makeWorld(['A', 'B']);
  world.conversations.start('A', 'B', 'opening');
  t.truthy(world.conversations.say('A', 'me again!'), 'A cannot speak on B turn');
  t.is(world.conversations.say('B', 'hello A'), null);
  t.is(world.conversations.get('A')!.turnOf, 'A');
  t.is(world.conversations.say('A', 'how are you'), null);
  t.is(world.conversations.get('A')!.turnOf, 'B');
});

test('the turn cap force-ends the conversation', (t) => {
  const world = makeWorld(['A', 'B']);
  world.conversations.start('A', 'B', 'opening');
  // maxConversationTurns = 2 → cap at 4 spoken turns after the opening.
  world.conversations.say('B', '1');
  world.conversations.say('A', '2');
  world.conversations.say('B', '3');
  t.truthy(world.conversations.get('A'), 'still open at 3 turns');
  world.conversations.say('A', '4');
  t.is(world.conversations.get('A'), undefined, 'closed at the cap');
  t.is(world.conversations.get('B'), undefined);
});

test('repeated lines force-end the conversation (going in circles)', (t) => {
  const world = makeWorld(['A', 'B']);
  // Generous cap so the repetition guard, not the cap, is what fires.
  (world.ctx.settings as { maxConversationTurns: number }).maxConversationTurns = 50;
  world.conversations.start('A', 'B', 'Tu peux porter le bois au coffre ?');
  t.is(world.conversations.say('B', 'Avec joie, je te rapporte chaque graine au coffre !'), null);
  t.is(world.conversations.say('A', "Oui, porte le bois au coffre, et mets les graines aussi."), null);
  // B rephrases itself — strike 1.
  t.is(world.conversations.say('B', 'Avec joie ! Je rapporte chaque graine au coffre.'), null);
  t.truthy(world.conversations.get('A'), 'one repeat is tolerated');
  t.is(world.conversations.say('A', 'Porte le bois au coffre, mets les graines aussi !'), null);
  // B repeats again — strike 2 → force-ended.
  t.is(world.conversations.say('B', 'Avec joie, je rapporte chaque graine au coffre !'), null);
  t.is(world.conversations.get('A'), undefined, 'second consecutive repeat closes the conversation');
  t.is(world.conversations.get('B'), undefined);
});

test('novel lines reset the repetition counter', (t) => {
  const world = makeWorld(['A', 'B']);
  (world.ctx.settings as { maxConversationTurns: number }).maxConversationTurns = 50;
  world.conversations.start('A', 'B', 'Salut !');
  t.is(world.conversations.say('B', 'Avec joie, je rapporte chaque graine au coffre !'), null);
  t.is(world.conversations.say('A', 'Merci bien.'), null);
  t.is(world.conversations.say('B', 'Avec joie, je rapporte chaque graine au coffre.'), null); // strike 1
  t.is(world.conversations.say('A', "D'accord."), null);
  t.is(world.conversations.say('B', "La forêt au nord regorge de sapins, viens voir demain."), null); // novel — reset
  t.is(world.conversations.say('A', 'Bonne idée.'), null);
  t.is(world.conversations.say('B', 'Avec joie, je rapporte chaque graine au coffre !'), null); // strike 1 again
  t.truthy(world.conversations.get('A'), 'counter was reset by the novel line');
});

test('lineSimilarity scores rephrasings high and novel lines low', (t) => {
  t.true(lineSimilarity(
    'Avec joie, Froment ! Je te rapporte chaque graine au coffre.',
    'Avec joie ! Je rapporte chaque graine au coffre, Froment.'
  ) >= 0.75);
  t.true(lineSimilarity(
    'Avec joie, je te rapporte chaque graine au coffre.',
    'La forêt au nord regorge de sapins immenses.'
  ) < 0.3);
});

test('leave closes for both and forfeit ends a stuck turn', (t) => {
  const world = makeWorld(['A', 'B']);
  world.conversations.start('A', 'B', 'opening');
  t.is(world.conversations.leave('B', 'a plus !'), null);
  t.is(world.conversations.get('A'), undefined);

  world.conversations.start('A', 'B', 'round two');
  world.conversations.forfeitTurn('B');
  t.is(world.conversations.get('A'), undefined, 'forfeit on the turn-holder ends it');
});

test('extractSpokenText strips pseudo tool-call lines and surfaces leave intent', (t) => {
  const { text, wantsLeave } = extractSpokenText(
    'Salut Enclume ! Je vais me remettre au travail.\ndone();\nleave_conversation();'
  );
  t.is(text, 'Salut Enclume ! Je vais me remettre au travail.');
  t.true(wantsLeave);
});

test('extractSpokenText leaves ordinary speech untouched', (t) => {
  const { text, wantsLeave } = extractSpokenText('16 pains contre 10 pièces, prix d\'ami.');
  t.is(text, '16 pains contre 10 pièces, prix d\'ami.');
  t.false(wantsLeave);

  const multi = extractSpokenText('Bonjour !\nAs-tu besoin d\'outils (haches, pioches) ?');
  t.is(multi.text, 'Bonjour ! As-tu besoin d\'outils (haches, pioches) ?');
  t.false(multi.wantsLeave);
});

test('extractSpokenText handles content that is only pseudo calls', (t) => {
  const { text, wantsLeave } = extractSpokenText('done();');
  t.is(text, '');
  t.false(wantsLeave);

  const leaveOnly = extractSpokenText('leave_conversation("a plus");');
  t.is(leaveOnly.text, '');
  t.true(leaveOnly.wantsLeave);
});

// -- M12: structured wrap-up + gossip ------------------------------------------

test('leave with opinion/note/headline moves the relation and seeds both memories', (t) => {
  const world = makeWorld(['Margaux', 'Firmin']);
  world.conversations.start('Margaux', 'Firmin', 'Salut !');
  world.conversations.say('Firmin', 'Salut Margaux.');

  const error = world.conversations.leave('Margaux', 'Je file !', {
    opinion: 25, // clamped to 10
    note: "m'a écoutée",
    headline: "j'ai trouvé un filon de fer près de la rivière",
  });
  t.is(error, null);

  const margauxRelations = world.relationsOf('Margaux');
  t.deepEqual(margauxRelations[0], { other: 'Firmin', delta: 10, note: "m'a écoutée" }, 'opinion clamped to ±10');
  // The generic end-of-conversation +1 still applies to both, after the explicit delta.
  t.true(margauxRelations.some((r) => r.delta === 1));
  t.true(world.relationsOf('Firmin').some((r) => r.delta === 1));

  const margauxHeadline = world.appendsOf('Margaux').find((a) => a.text.includes('à retenir de ma discussion'));
  const firminHeadline = world.appendsOf('Firmin').find((a) => a.text.includes("Margaux m'a confié"));
  t.truthy(margauxHeadline);
  t.truthy(firminHeadline);
  t.is(margauxHeadline!.importance, 7);
  t.is(firminHeadline!.importance, 7);
  t.true(firminHeadline!.text.includes('filon de fer'));
});

test('leave without opts behaves exactly as before', (t) => {
  const world = makeWorld(['A', 'B']);
  world.conversations.start('A', 'B', 'salut');
  t.is(world.conversations.leave('B'), null);
  t.deepEqual(world.relationsOf('B').map((r) => r.delta), [1], 'only the generic +1');
  t.false(world.appendsOf('A').some((a) => a.text.includes('confié')));
});

function entry(at: number, kind: MemoryEntry['kind'], text: string, importance: number, tags?: string[]): MemoryEntry {
  return { at, kind, text, importance, tags: tagsFor(text, tags) };
}

test('newsToShare picks recent important memories that do not involve the partner', (t) => {
  const now = Date.now();
  const villager = {
    memory: {
      recent: () => [
        entry(now - 60_000, 'event', 'grosse récolte de blé ce matin', 8),
        entry(now - 50_000, 'event', 'bruit sans intérêt', 3),
        entry(now - 40_000, 'social', 'Firmin m\'a aidé au champ', 8, ['Firmin']),
        entry(now - 5 * 60 * 60 * 1_000, 'event', 'vieille nouvelle périmée', 9),
        entry(now - 30_000, 'system', 'détail interne important', 9),
        entry(now - 20_000, 'trade', 'vendu 10 pains à Ecu', 7, ['Ecu']),
      ],
    },
  } as unknown as Villager;

  const news = newsToShare(villager, 'Firmin', now);
  t.deepEqual(news, ['grosse récolte de blé ce matin', 'vendu 10 pains à Ecu'], 'low-importance, stale, system and partner-involving entries are skipped');
});

test('contextFor surfaces the news block', (t) => {
  const world = makeWorld(['A', 'B']);
  world.seedRecent('B', [entry(Date.now() - 10_000, 'event', 'le puits du village est réparé', 8)]);
  world.conversations.start('A', 'B', 'salut');

  const context = world.conversations.contextFor('B');
  t.truthy(context);
  t.true(context!.includes('NOUVELLES À PARTAGER'));
  t.true(context!.includes('le puits du village est réparé'));

  const quiet = world.conversations.contextFor('A');
  t.false(quiet!.includes('NOUVELLES À PARTAGER'), 'no news → no block');
});
