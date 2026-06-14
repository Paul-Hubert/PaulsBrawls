// Conversation (layer 3, social/) — bot↔bot speech (04 §Conversations). v1's design wholesale (it
// worked): in-process turn-taking with a hard turn cap + a per-turn deadline; speech mirrored to the
// game chat ONLY when a player is in earshot (rate-limited); structured leave_conversation{opinion,
// note, headline} feeds relations + memory; eavesdropping villagers in earshot get free memory entries.
//
// social/ is LAYER 3 and may import skills/llm/render/journal/config/bots/types — but NEVER god/ or
// villagers/ (the social-no-peers rule). It reaches a villager's memory + chat sink through the types/
// {@link Conversant} / {@link MemoryWriter} interfaces, whose concrete instances (VillagerMemory + a
// bot-backed sayInGame) main.ts wires — the same discipline that keeps god/ out of villagers/.
//
// The brain supplies each participant's turns via an injected {@link SpeakFn} (a real wake-up turn in
// production; a scripted queue in tests), so the conversation engine itself needs no LLM and proves
// entirely on fakes.

import { monotonicFactory } from 'ulid';

import type { IJournal } from '../journal/journal';
import type { Conversant, MemoryWriter } from '../types/index';

const ulid = monotonicFactory();

/** The structured `leave_conversation` payload — moves relations + seeds a headline memory (04). */
export interface LeaveDecision {
  /** Relation delta toward the other party (signed). */
  opinion: number;
  /** The short relation note (replaces the prior note). */
  note: string;
  /** The headline — seeded as a HIGH-importance social memory for BOTH parties (04). */
  headline: string;
}

/** What a participant's turn produces: a line to say, or a decision to leave. */
export type SpeakResult = { say: string } | { leave: LeaveDecision };

/** Asks a participant for its next turn. The conversation enforces the per-turn deadline around it. */
export type SpeakFn = () => Promise<SpeakResult>;

/** A conversation participant: the types/ Conversant (name + memory + chat sink + earshot) + its turn fn. */
export interface ConversationParticipant {
  conversant: Conversant;
  speak: SpeakFn;
}

/** Why a conversation ended (mirrors the conversation.ended journal `reason`). */
export type EndReason = 'left' | 'turn-cap' | 'deadline' | 'partner-gone';

/** Construction deps. */
export interface ConversationOptions {
  journal: IJournal;
  initiator: ConversationParticipant;
  partner: ConversationParticipant;
  /** Villagers in earshot but not party to the conversation — they get free memory entries (04). */
  eavesdroppers?: MemoryWriter[];
  /** Hard turn cap (S7 hardcoded default 12). */
  maxTurns?: number;
  /** Per-turn wall-clock deadline in ms (S7 hardcoded default 30 s). */
  turnDeadlineMs?: number;
  /** Minimum ms between two mirrored lines from the SAME speaker (rate-limit the game-chat mirror). */
  mirrorMinIntervalMs?: number;
  /** Optional topic, recorded on conversation.started. */
  topic?: string;
  now?: () => number;
}

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_TURN_DEADLINE_MS = 30_000;
const DEFAULT_MIRROR_MIN_INTERVAL_MS = 4_000;
/** Importance of a leave-headline memory (high — it's the relationship-defining beat, 04). */
const HEADLINE_IMPORTANCE = 8;
/** Importance of an overheard line a villager remembers for free. */
const OVERHEARD_IMPORTANCE = 3;

/** A single bot↔bot conversation, run to completion. One per encounter; main.ts/the brain spawns it. */
export class Conversation {
  private readonly id = ulid();
  private readonly journal: IJournal;
  private readonly initiator: ConversationParticipant;
  private readonly partner: ConversationParticipant;
  private readonly eavesdroppers: MemoryWriter[];
  private readonly maxTurns: number;
  private readonly turnDeadlineMs: number;
  private readonly mirrorMinIntervalMs: number;
  private readonly topic?: string;
  private readonly now: () => number;

  /** Last mirror time per speaker name (rate-limit the game-chat mirror). */
  private readonly lastMirror = new Map<string, number>();

  constructor(opts: ConversationOptions) {
    this.journal = opts.journal;
    this.initiator = opts.initiator;
    this.partner = opts.partner;
    this.eavesdroppers = opts.eavesdroppers ?? [];
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.turnDeadlineMs = opts.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS;
    this.mirrorMinIntervalMs = opts.mirrorMinIntervalMs ?? DEFAULT_MIRROR_MIN_INTERVAL_MS;
    if (opts.topic !== undefined) this.topic = opts.topic;
    this.now = opts.now ?? Date.now;
  }

  /** The conversation id (for refs.conversationId). */
  conversationId(): string {
    return this.id;
  }

  /** Run the conversation to completion. Resolves with how it ended. */
  async run(): Promise<EndReason> {
    const refs = { conversationId: this.id };
    this.journal.append(this.actor(this.initiator), 'conversation.started', {
      id: this.id,
      initiator: this.initiator.conversant.name,
      partner: this.partner.conversant.name,
      ...(this.topic !== undefined ? { topic: this.topic } : {}),
    }, refs);

    let speaker = this.initiator;
    let listener = this.partner;
    let reason: EndReason = 'turn-cap';
    let leave: LeaveDecision | undefined;
    let endedBy = speaker;

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      let result: SpeakResult;
      try {
        result = await this.withDeadline(speaker.speak());
      } catch {
        reason = 'deadline';
        endedBy = speaker;
        break;
      }

      if ('leave' in result) {
        this.applyLeave(speaker, listener, result.leave);
        reason = 'left';
        leave = result.leave;
        endedBy = speaker;
        break;
      }

      this.journal.append(this.actor(speaker), 'conversation.turn', { id: this.id, speaker: speaker.conversant.name, turn }, refs);
      this.say(speaker, listener, result.say);

      // hand the floor over
      [speaker, listener] = [listener, speaker];

      // reached the cap WITHOUT a leave → turn-cap; the would-be next speaker "owns" the timeout.
      if (turn === this.maxTurns) {
        reason = 'turn-cap';
        endedBy = speaker;
      }
    }

    // ONE conversation.ended (the leave details ride along when the reason is 'left').
    this.journal.append(this.actor(endedBy), 'conversation.ended', {
      id: this.id,
      by: endedBy.conversant.name,
      reason,
      ...(leave ? { opinion: leave.opinion, headline: leave.headline } : {}),
    }, refs);
    return reason;
  }

  /** A speaker says one line: journal chat.said, the listener + eavesdroppers hear it, mirror if a player can hear. */
  private say(speaker: ConversationParticipant, listener: ConversationParticipant, text: string): void {
    const refs = { conversationId: this.id };
    const from = speaker.conversant.name;
    const to = listener.conversant.name;
    this.journal.append(this.actor(speaker), 'chat.said', { from, to, text }, refs);

    // The addressee hears it (not an eavesdrop) + remembers it.
    this.hear(listener.conversant.memory, from, text, false);

    // Eavesdroppers in earshot get a FREE memory entry (04).
    for (const ear of this.eavesdroppers) this.hear(ear, from, text, true);

    // Mirror to game chat ONLY when a player is in earshot of the SPEAKER, rate-limited per speaker.
    if (speaker.conversant.playerInEarshot() && this.canMirror(from)) {
      speaker.conversant.sayInGame(text);
      this.lastMirror.set(from, this.now());
    }
  }

  /** Journal chat.heard + seed a memory for the hearer (the free-memory rule, 04). */
  private hear(memory: MemoryWriter, from: string, text: string, eavesdrop: boolean): void {
    this.journal.append(`villager:${memory.villager}`, 'chat.heard', { hearer: memory.villager, from, text, eavesdrop }, { conversationId: this.id });
    memory.remember({
      kind: 'social',
      text: eavesdrop ? `Entendu ${from} dire: « ${text} »` : `${from} m'a dit: « ${text} »`,
      importance: OVERHEARD_IMPORTANCE,
    });
  }

  /** leave_conversation: move the leaver's relation toward the partner + seed the headline for BOTH (04).
   *  The single conversation.ended journal entry is emitted by run() (with the leave details). */
  private applyLeave(speaker: ConversationParticipant, listener: ConversationParticipant, leave: LeaveDecision): void {
    // The leaver moves its relation toward the other party.
    speaker.conversant.memory.moveRelation(listener.conversant.name, leave.opinion, leave.note);
    // The headline is a HIGH-importance social memory for BOTH parties (the relationship beat).
    speaker.conversant.memory.remember({ kind: 'social', text: leave.headline, importance: HEADLINE_IMPORTANCE });
    listener.conversant.memory.remember({ kind: 'social', text: leave.headline, importance: HEADLINE_IMPORTANCE });
  }

  /** Wrap a participant's turn with the per-turn deadline (a slow turn ends the conversation, R39 valve). */
  private withDeadline<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`conversation ${this.id}: turn exceeded ${this.turnDeadlineMs}ms`)), this.turnDeadlineMs);
      if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref();
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
      );
    });
  }

  /** True if `speaker` is outside its mirror rate-limit window (no prior mirror → always allowed). */
  private canMirror(speaker: string): boolean {
    const last = this.lastMirror.get(speaker);
    if (last === undefined) return true;
    return this.now() - last >= this.mirrorMinIntervalMs;
  }

  private actor(p: ConversationParticipant): string {
    return `villager:${p.conversant.name}`;
  }
}
