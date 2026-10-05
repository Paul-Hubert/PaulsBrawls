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
import type {
  Conversant,
  ConversationDesk,
  LeaveDecision,
  MemoryWriter,
  SpeakFn,
  SpeakResult,
  TranscriptLine,
} from '../types/index';

const ulid = monotonicFactory();

// The speak-turn types moved to types/social.ts (D-18) so villagers/ can generate turns without importing social/.
export type { LeaveDecision, SpeakFn, SpeakResult, TranscriptLine };

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
  /** Everything said so far — handed to each speaker's turn (D-18). */
  private readonly transcript: TranscriptLine[] = [];

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
        result = await this.withDeadline(speaker.speak([...this.transcript]));
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
    this.transcript.push({ from, text });

    // The addressee hears it (not an eavesdrop) + remembers it.
    this.hear(listener.conversant.memory, from, text, false);

    // Eavesdroppers in earshot get a FREE memory entry (04).
    for (const ear of this.eavesdroppers) this.hear(ear, from, text, true);

    // Mirror to game chat ONLY when a player is in earshot of the SPEAKER, rate-limited per speaker.
    if (speaker.conversant.playerInEarshot() && this.canMirror(from)) {
      speaker.conversant.sayInGame(chatSafe(text));
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ConversationBook (D-18) — the live front of the society layer. It answers the villager speech tools through the
// types/ ConversationDesk seam: `say` (public game chat), `tell` (a private line into another villager's inbox — it
// wakes them, D-17) and `start` (open a turn-taking Conversation with a nearby villager, run in the background).
// Bodies, memories and turn generation are INJECTED by main.ts, so social/ still imports no peer.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Construction deps — every world/brain fact comes in through a function (main.ts wires them). */
export interface ConversationBookOptions {
  journal: IJournal;
  /** True for a roster villager (only villagers converse or receive tells). */
  isVillager: (name: string) => boolean;
  /** The conversant for a CONNECTED villager (memory + chat sink + earshot), or undefined when offline. */
  conversantFor: (name: string) => Conversant | undefined;
  /** The turn generator for `self` talking to `partner` about `topic` (an LLM turn in production). */
  speakerFor: (self: string, partner: string, topic: string) => SpeakFn;
  /** True iff the two villagers are close enough to talk (main.ts: ≤ 16 blocks). */
  inEarshot: (a: string, b: string) => boolean;
  /** Deliver a private line into `to`'s inbox (main.ts: an inbox `tell`, which raises the inbox event). */
  deliverTell: (to: string, from: string, text: string) => void;
  /** Other villagers near the speaker, who overhear (free memory entries, 04). Optional. */
  eavesdroppersFor?: (a: string, b: string) => MemoryWriter[];
  /** Conversations allowed at once, server-wide (each one costs LLM turns). Default 2. */
  maxConcurrent?: number;
  /** Turn cap per conversation. Default 8 (cheaper than the engine's 12). */
  maxTurns?: number;
  /** Per-turn deadline. Default 60 s (a turn waits for the per-villager LLM cooldown, then the call). */
  turnDeadlineMs?: number;
  /** Minimum gap between two `say`s of one villager. Default 4 s. */
  sayMinIntervalMs?: number;
  /** Tells one villager may send ONE partner per {@link tellWindowMs}. Default 3. */
  tellsPerWindow?: number;
  /** The sliding window for {@link tellsPerWindow}. Default 10 min. */
  tellWindowMs?: number;
  now?: () => number;
}

const MAX_LINE = 250;
/** mineflayer's chat chunk is 256 chars (100 on servers with `lessCharsInChat`, not 1.21.1): stay inside one chunk. */
export const CHAT_SAFE_MAX = 250;

/** The conversation registry + speech tools (D-18). */
export class ConversationBook implements ConversationDesk {
  private readonly o: ConversationBookOptions;
  private readonly now: () => number;
  /** villager → id of the conversation it is in. */
  private readonly busy = new Map<string, string>();
  private readonly lastSay = new Map<string, number>();
  /** "from→to" → times of recent tells (sliding window). */
  private readonly recentTells = new Map<string, number[]>();
  private running = 0;

  constructor(opts: ConversationBookOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
  }

  say(villager: string, text: string): { ok: true } | { ok: false; reason: string } {
    const line = clean(text);
    if (!line) return { ok: false, reason: 'rien à dire (texte vide)' };
    const me = this.o.conversantFor(villager);
    if (!me) return { ok: false, reason: `${villager} n'est pas connecté` };
    const last = this.lastSay.get(villager);
    const gap = this.o.sayMinIntervalMs ?? 4_000;
    if (last !== undefined && this.now() - last < gap) return { ok: false, reason: 'tu viens de parler — attends un peu' };
    this.lastSay.set(villager, this.now());
    this.o.journal.append(`villager:${villager}`, 'chat.said', { from: villager, to: '*', text: line });
    me.sayInGame(line);
    return { ok: true };
  }

  tell(from: string, to: string, text: string): { ok: true } | { ok: false; reason: string } {
    const line = clean(text);
    if (!line) return { ok: false, reason: 'rien à dire (texte vide)' };
    if (to === from) return { ok: false, reason: 'tu ne peux pas te parler à toi-même' };
    if (!this.o.isVillager(to)) return { ok: false, reason: `${to} n'est pas un villageois` };
    // Each tell wakes the partner (D-17 inbox), who may tell back: budget each ordered pair so A↔B cannot wake each
    // other forever (review fix).
    const key = `${from}\u0000${to}`;
    const windowMs = this.o.tellWindowMs ?? 10 * 60_000;
    const recent = (this.recentTells.get(key) ?? []).filter((t) => this.now() - t < windowMs);
    if (recent.length >= (this.o.tellsPerWindow ?? 3)) {
      this.recentTells.set(key, recent);
      return { ok: false, reason: `tu as déjà écrit plusieurs fois à ${to} — attends sa réponse ou va lui parler (start_conversation)` };
    }
    recent.push(this.now());
    this.recentTells.set(key, recent);
    this.o.journal.append(`villager:${from}`, 'chat.said', { from, to, text: line });
    this.o.deliverTell(to, from, line);
    return { ok: true };
  }

  start(initiator: string, partner: string, topic: string): { ok: true; id: string } | { ok: false; reason: string } {
    if (partner === initiator) return { ok: false, reason: 'tu ne peux pas converser avec toi-même' };
    if (!this.o.isVillager(partner)) return { ok: false, reason: `${partner} n'est pas un villageois` };
    if (this.busy.has(initiator)) return { ok: false, reason: 'tu es déjà en conversation' };
    if (this.busy.has(partner)) return { ok: false, reason: `${partner} est déjà en conversation` };
    const max = this.o.maxConcurrent ?? 2;
    if (this.running >= max) return { ok: false, reason: `trop de conversations en cours (max ${max}) — réessaie plus tard` };
    const a = this.o.conversantFor(initiator);
    const b = this.o.conversantFor(partner);
    if (!a) return { ok: false, reason: `${initiator} n'est pas connecté` };
    if (!b) return { ok: false, reason: `${partner} n'est pas connecté` };
    if (!this.o.inEarshot(initiator, partner)) return { ok: false, reason: `${partner} est trop loin pour converser — approche-toi d'abord` };

    const subject = clean(topic) || '(sans sujet)';
    const conv = new Conversation({
      journal: this.o.journal,
      initiator: { conversant: a, speak: this.o.speakerFor(initiator, partner, subject) },
      partner: { conversant: b, speak: this.o.speakerFor(partner, initiator, subject) },
      eavesdroppers: this.o.eavesdroppersFor?.(initiator, partner) ?? [],
      maxTurns: this.o.maxTurns ?? 8,
      turnDeadlineMs: this.o.turnDeadlineMs ?? 60_000,
      topic: subject,
      ...(this.o.now ? { now: this.o.now } : {}),
    });
    const id = conv.conversationId();
    this.busy.set(initiator, id);
    this.busy.set(partner, id);
    this.running++;
    const done = (): void => {
      this.busy.delete(initiator);
      this.busy.delete(partner);
      this.running--;
    };
    // Background: the tool returns at once; the conversation journals itself (started/turn/ended) and feeds memory.
    void conv.run().then(done, (e: unknown) => {
      done();
      this.o.journal.append(`villager:${initiator}`, 'system.error', {
        message: `conversation ${id} (${initiator}↔${partner}) failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
    return { ok: true, id };
  }

  /** The conversation `villager` is in, if any (admin/tests). */
  conversationOf(villager: string): string | undefined {
    return this.busy.get(villager);
  }
}

/** Trim + cap a spoken line (one chat message), command-safe — see {@link chatSafe}. */
function clean(text: string): string {
  return chatSafe(text).slice(0, MAX_LINE);
}

/**
 * The only form a villager line may take on its way to `bot.chat`. Villagers are op'd on join, and mineflayer splits
 * a message on newlines and into 256-char chunks, sending EVERY chunk that starts with `/` as a command. So: all
 * whitespace (newlines, U+2028…) collapses to one space, every leading `/` or space is stripped, and the line is
 * capped below one chunk — no chunk can start with `/` (review fix: `"ok\n/give …"` used to run `/give`).
 */
export function chatSafe(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').replace(/^[\s/]+/, '').slice(0, CHAT_SAFE_MAX).trim();
}
