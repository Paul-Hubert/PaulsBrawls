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
import { Conversation } from '../src/social/conversation';
import type { Conversant, MemorySeed, MemoryWriter, Relation } from '../src/types/index';
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
