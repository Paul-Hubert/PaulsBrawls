// M6-2 — social/conversation.ts. Proofs (plan §4):
//   • turn cap + per-turn deadline are enforced;
//   • the mirror gate — NO player in earshot → NO game-chat mirror; a player in earshot → mirrored
//     (rate-limited);
//   • leave_conversation{opinion,note,headline} → relations + memory for both parties;
//   • eavesdropping villagers get free memory entries.
// All on fakes (no Minecraft): a FakeConversant implements the types/ Conversant seam (name + a narrow
// memory + a sayInGame sink + a playerInEarshot gate), and a scripted SpeakFn drives the turns.

import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryJournal } from './fakes/memory-journal';
import { CHAT_SAFE_MAX, Conversation, ConversationBook, chatSafe } from '../src/social/conversation';
import type { Conversant, MemorySeed, MemoryWriter, Relation, TranscriptLine } from '../src/types/index';
import type { ConversationParticipant, SpeakResult } from '../src/social/conversation';

/** A tiny MemoryWriter that records everything social/ does to it (for assertions). */
class RecordingMemory implements MemoryWriter {
  readonly seeds: MemorySeed[] = [];
  readonly relations: Relation[] = [];
  constructor(readonly villager: string) {}
  remember(seed: MemorySeed): void {
    this.seeds.push(seed);
  }
  moveRelation(other: string, delta: number, note: string): Relation {
    const r: Relation = { other, score: delta, note, at: 0 };
    this.relations.push(r);
    return r;
  }
}

/** A FakeConversant — the types/ Conversant seam, with controllable earshot + a chat sink. */
class FakeConversant implements Conversant {
  readonly memory: RecordingMemory;
  readonly said: string[] = [];
  private earshot: boolean;
  constructor(
    readonly name: string,
    opts: { playerInEarshot?: boolean } = {},
  ) {
    this.memory = new RecordingMemory(name);
    this.earshot = opts.playerInEarshot ?? false;
  }
  sayInGame(line: string): void {
    this.said.push(line);
  }
  playerInEarshot(): boolean {
    return this.earshot;
  }
  setEarshot(v: boolean): void {
    this.earshot = v;
  }
}

/** A scripted participant: a Conversant + a queue of turns it will produce. */
function participant(c: FakeConversant, turns: SpeakResult[]): ConversationParticipant {
  const q = [...turns];
  return {
    conversant: c,
    speak: () => Promise.resolve(q.shift() ?? { leave: { opinion: 0, note: 'fin', headline: 'fin' } }),
  };
}

test('M6-2: a conversation runs alternating turns and journals started/turn/ended', async () => {
  const journal = new MemoryJournal();
  const a = new FakeConversant('Firmin');
  const b = new FakeConversant('Pilou');
  const convo = new Conversation({
    journal,
    initiator: participant(a, [{ say: 'Salut Pilou !' }, { leave: { opinion: 2, note: 'sympa', headline: 'a salué Pilou' } }]),
    partner: participant(b, [{ say: 'Salut Firmin !' }]),
  });
  await convo.run();
  assert.equal(journal.query({ kinds: ['conversation.started'] }).length, 1);
  assert.ok(journal.query({ kinds: ['conversation.turn'] }).length >= 2, 'each line is a turn');
  assert.equal(journal.query({ kinds: ['conversation.ended'] }).length, 1);
  // each spoken line journals chat.said
  assert.ok(journal.query({ kinds: ['chat.said'] }).length >= 2);
});

test('M6-2 (turn cap): the conversation stops at the hard turn cap even if both keep talking', async () => {
  const journal = new MemoryJournal();
  const chatter = (): SpeakResult => ({ say: 'encore une ligne' });
  const a: ConversationParticipant = { conversant: new FakeConversant('Firmin'), speak: () => Promise.resolve(chatter()) };
  const b: ConversationParticipant = { conversant: new FakeConversant('Pilou'), speak: () => Promise.resolve(chatter()) };
  const convo = new Conversation({ journal, initiator: a, partner: b, maxTurns: 4 });
  await convo.run();
  const turns = journal.query({ kinds: ['conversation.turn'] });
  assert.equal(turns.length, 4, 'exactly maxTurns turns');
  const ended = journal.query({ kinds: ['conversation.ended'] });
  assert.equal((ended[0]!.payload as { reason: string }).reason, 'turn-cap');
});

test('M6-2 (per-turn deadline): a speak() that exceeds the deadline ends the conversation (deadline)', async () => {
  const journal = new MemoryJournal();
  const slow: ConversationParticipant = {
    conversant: new FakeConversant('Firmin'),
    speak: () => new Promise<SpeakResult>((resolve) => setTimeout(() => resolve({ say: 'trop tard' }), 100)),
  };
  const fast: ConversationParticipant = { conversant: new FakeConversant('Pilou'), speak: () => Promise.resolve({ say: 'ok' }) };
  const convo = new Conversation({ journal, initiator: slow, partner: fast, turnDeadlineMs: 20 });
  await convo.run();
  const ended = journal.query({ kinds: ['conversation.ended'] });
  assert.equal(ended.length, 1);
  assert.equal((ended[0]!.payload as { reason: string }).reason, 'deadline');
});

test('M6-2 (mirror gate OFF): with NO player in earshot, nothing is mirrored to game chat', async () => {
  const journal = new MemoryJournal();
  const a = new FakeConversant('Firmin', { playerInEarshot: false });
  const b = new FakeConversant('Pilou', { playerInEarshot: false });
  const convo = new Conversation({
    journal,
    initiator: participant(a, [{ say: 'on parle entre nous' }, { leave: { opinion: 0, note: 'x', headline: 'x' } }]),
    partner: participant(b, [{ say: 'oui' }]),
  });
  await convo.run();
  assert.equal(a.said.length, 0, 'no game-chat mirror when no player can hear');
  assert.equal(b.said.length, 0);
  // …but the speech still happened in-process (journaled).
  assert.ok(journal.query({ kinds: ['chat.said'] }).length >= 2);
});

test('M6-2 (mirror gate ON): with a player in earshot, lines ARE mirrored to game chat (rate-limited)', async () => {
  const journal = new MemoryJournal();
  const a = new FakeConversant('Firmin', { playerInEarshot: true });
  const b = new FakeConversant('Pilou', { playerInEarshot: true });
  const convo = new Conversation({
    journal,
    initiator: participant(a, [{ say: 'un joueur écoute' }, { say: 'deuxième ligne immédiate' }, { leave: { opinion: 0, note: 'x', headline: 'x' } }]),
    partner: participant(b, [{ say: 'salut' }, { say: 'rebonjour' }]),
    mirrorMinIntervalMs: 10_000, // a long rate-limit window → only the FIRST line of each speaker mirrors
    now: (() => { let t = 0; return () => (t += 1); })(), // monotonic, well inside the window
  });
  await convo.run();
  assert.ok(a.said.length >= 1, 'at least one line mirrored when a player can hear');
  assert.ok(a.said.length < 2, 'rate-limited: the immediate second line is suppressed within the window');
});

test('M6-2 (leave → relations + memory): leave_conversation moves the relation + seeds a high-importance headline memory for BOTH parties', async () => {
  const journal = new MemoryJournal();
  const a = new FakeConversant('Firmin');
  const b = new FakeConversant('Pilou');
  const convo = new Conversation({
    journal,
    initiator: participant(a, [{ say: 'merci pour le bois' }, { leave: { opinion: 3, note: 'généreux', headline: 'Pilou m’a donné du bois' } }]),
    partner: participant(b, [{ say: 'de rien' }]),
  });
  await convo.run();
  // The leaver moved its relation toward the partner.
  assert.equal(a.memory.relations.find((r) => r.other === 'Pilou')?.score, 3);
  // BOTH parties got the headline as a high-importance social memory.
  assert.ok(a.memory.seeds.some((s) => s.kind === 'social' && /bois/.test(s.text) && (s.importance ?? 0) >= 7));
  assert.ok(b.memory.seeds.some((s) => s.kind === 'social' && /bois/.test(s.text) && (s.importance ?? 0) >= 7));
  const ended = journal.query({ kinds: ['conversation.ended'] });
  assert.equal((ended[0]!.payload as { reason: string }).reason, 'left');
});

test('M6-2 (eavesdroppers): villagers in earshot but not party to the conversation get free memory entries', async () => {
  const journal = new MemoryJournal();
  const a = new FakeConversant('Firmin');
  const b = new FakeConversant('Pilou');
  const eve = new RecordingMemory('Eve');
  const convo = new Conversation({
    journal,
    initiator: participant(a, [{ say: 'tu as vu le creeper ?' }, { leave: { opinion: 0, note: 'x', headline: 'x' } }]),
    partner: participant(b, [{ say: 'oui, dangereux' }]),
    eavesdroppers: [eve],
  });
  await convo.run();
  assert.ok(eve.seeds.length >= 2, 'an eavesdropper got a free memory entry per overheard line');
  assert.ok(eve.seeds.every((s) => s.kind === 'social'));
  // each overheard line journals chat.heard with eavesdrop:true
  const heard = journal.query({ kinds: ['chat.heard'] }).filter((e) => (e.payload as { eavesdrop: boolean }).eavesdrop);
  assert.ok(heard.length >= 2);
});

test('M6-2 (addressee hears): the conversation partner journals chat.heard (eavesdrop:false) and remembers it', async () => {
  const journal = new MemoryJournal();
  const a = new FakeConversant('Firmin');
  const b = new FakeConversant('Pilou');
  const convo = new Conversation({
    journal,
    initiator: participant(a, [{ say: 'bonjour' }, { leave: { opinion: 0, note: 'x', headline: 'x' } }]),
    partner: participant(b, [{ say: 'salut' }]),
  });
  await convo.run();
  const heard = journal.query({ kinds: ['chat.heard'] });
  assert.ok(heard.some((e) => (e.payload as { hearer: string; eavesdrop: boolean }).hearer === 'Pilou' && !(e.payload as { eavesdrop: boolean }).eavesdrop));
});

// ── D-18: the transcript handed to each turn, and the ConversationBook behind say/tell/start_conversation ──

test('D-18: each speaker turn receives the transcript so far', async () => {
  const seen: TranscriptLine[][] = [];
  const a: ConversationParticipant = {
    conversant: new FakeConversant('Firmin'),
    speak: async (t) => { seen.push([...t]); return t.length === 0 ? { say: 'bonjour' } : { leave: { opinion: 1, note: 'ok', headline: 'salutations' } }; },
  };
  const b: ConversationParticipant = { conversant: new FakeConversant('Pilou'), speak: async (t) => { seen.push([...t]); return { say: 'salut' }; } };
  await new Conversation({ journal: new MemoryJournal(), initiator: a, partner: b }).run();
  assert.deepEqual(seen, [
    [],
    [{ from: 'Firmin', text: 'bonjour' }],
    [{ from: 'Firmin', text: 'bonjour' }, { from: 'Pilou', text: 'salut' }],
  ]);
});

function book(over: Partial<ConstructorParameters<typeof ConversationBook>[0]> = {}) {
  const journal = new MemoryJournal();
  const conversants = new Map<string, FakeConversant>([['Firmin', new FakeConversant('Firmin')], ['Pilou', new FakeConversant('Pilou')]]);
  const tells: Array<{ to: string; from: string; text: string }> = [];
  let now = 0;
  const b = new ConversationBook({
    journal,
    isVillager: (n) => ['Firmin', 'Pilou', 'Alban'].includes(n),
    conversantFor: (n) => conversants.get(n),
    speakerFor: (self) => async (t) => (t.length >= 2 ? { leave: { opinion: 2, note: 'sympa', headline: `${self} a bavardé` } } : { say: `${self} parle` }),
    inEarshot: () => true,
    deliverTell: (to, from, text) => tells.push({ to, from, text }),
    now: () => now,
    ...over,
  });
  return { b, journal, conversants, tells, tick: (ms: number) => { now += ms; } };
}

test('D-18: say speaks aloud (never as a /command) and is rate-limited per villager', () => {
  const h = book();
  assert.deepEqual(h.b.say('Firmin', '  /op Firmin  '), { ok: true });
  assert.deepEqual(h.conversants.get('Firmin')!.said, ['op Firmin'], 'a leading / is stripped — villagers are op’d');
  assert.equal(h.b.say('Firmin', 'encore').ok, false, 'too soon');
  h.tick(5_000);
  assert.equal(h.b.say('Firmin', 'encore').ok, true);
  assert.equal(h.b.say('Alban', 'bonjour').ok, false, 'an offline villager cannot speak');
  assert.equal(h.journal.query({ kinds: ['chat.said'] }).length, 2);
});

test('D-18: tell goes to a villager’s inbox only', () => {
  const h = book();
  assert.equal(h.b.tell('Firmin', 'Alban', 'viens voir').ok, true, 'a tell does not need the partner online (it waits in the inbox)');
  assert.equal(h.b.tell('Firmin', 'paul', 'x').ok, false, 'not a villager');
  assert.equal(h.b.tell('Firmin', 'Firmin', 'x').ok, false);
  assert.equal(h.b.tell('Firmin', 'Pilou', '   ').ok, false, 'empty');
  assert.deepEqual(h.tells, [{ to: 'Alban', from: 'Firmin', text: 'viens voir' }]);
});

test('D-18: start runs a conversation in the background, one per villager, and frees both when it ends', async () => {
  const h = book();
  const r = h.b.start('Firmin', 'Pilou', 'la récolte');
  assert.equal(r.ok, true);
  assert.equal(h.b.start('Pilou', 'Firmin', 'autre chose').ok, false, 'both are busy');
  for (let i = 0; i < 50 && h.b.conversationOf('Firmin'); i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(h.b.conversationOf('Firmin'), undefined, 'freed after the conversation ended');
  const ended = h.journal.query({ kinds: ['conversation.ended'] });
  assert.equal(ended.length, 1);
  assert.equal((ended[0]!.payload as { reason: string }).reason, 'left');
  assert.ok(h.conversants.get('Pilou')!.memory.seeds.some((s) => /a bavardé/.test(s.text)), 'the headline reached both memories');
});

test('D-18: start refuses offline, distant, non-villager and over-cap partners', () => {
  assert.match((book().b.start('Firmin', 'Alban', 't') as { reason: string }).reason, /pas connecté/);
  assert.match((book({ inEarshot: () => false }).b.start('Firmin', 'Pilou', 't') as { reason: string }).reason, /trop loin/);
  assert.match((book().b.start('Firmin', 'paul', 't') as { reason: string }).reason, /pas un villageois/);
  const h = book({ maxConcurrent: 0 });
  assert.match((h.b.start('Firmin', 'Pilou', 't') as { reason: string }).reason, /trop de conversations/);
});

// Review fix: mineflayer's bot.chat splits a message on '\n' and into 256-char chunks, and sends every chunk that
// starts with '/' as a command (villagers are op'd). Stripping only the leading '/' of the whole line let a newline,
// a "/ /cmd" prefix or a '/' at character 257 run a command.
test('chatSafe: no chunk mineflayer sends can start with "/"', () => {
  const chunks = (line: string) => line.split('\n').flatMap((s) => s.match(/[\s\S]{1,256}/g) ?? []);
  const attacks = ['ok\n/give @s diamond 64', ' / /op Firmin', '/\n/stop', 'a'.repeat(256) + '/op Firmin', ' /op x'];
  for (const a of attacks) {
    const out = chatSafe(a);
    for (const c of chunks(out)) assert.ok(!c.startsWith('/'), `${JSON.stringify(a)} → chunk ${JSON.stringify(c)}`);
    assert.ok(out.length <= CHAT_SAFE_MAX, 'one chunk only');
    assert.ok(!out.includes('\n'));
  }
  assert.equal(chatSafe('  bonjour   Pilou '), 'bonjour Pilou');
});

test('a conversation turn is mirrored through chatSafe (a multi-line LLM turn cannot carry a command)', async () => {
  const journal = new MemoryJournal();
  const a = new FakeConversant('Firmin', { playerInEarshot: true });
  const b = new FakeConversant('Pilou');
  const convo = new Conversation({
    journal,
    initiator: participant(a, [{ say: 'ok\n/give @s diamond 64' }, { leave: { opinion: 0, note: 'x', headline: 'x' } }]),
    partner: participant(b, [{ say: 'salut' }]),
  });
  await convo.run();
  assert.deepEqual(a.said, ['ok /give @s diamond 64'], 'one line; a mid-line / is plain text');
});
