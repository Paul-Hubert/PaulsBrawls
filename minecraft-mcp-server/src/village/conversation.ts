import { log, logDebug } from '../logger.js';
import { VillageContext } from './context.js';
import { normalizeKeyword, tokenize } from './memory-index.js';
import { ItemStack } from './types.js';
import type { Villager } from './villager.js';

/**
 * Turn-based bot↔bot conversations (VILLAGE_PLAN §D7).
 *
 * Invariants enforced here:
 *  - a bot is in at most ONE conversation;
 *  - turns strictly alternate; "it's my turn" is one scheduler request;
 *  - a hard turn cap (then a forced wrap-up) makes runaway loops structurally
 *    impossible;
 *  - a per-turn deadline ends conversations whose holder never got budget
 *    (LLM down / overloaded) instead of deadlocking both bots;
 *  - utterances route in-process; the in-game mirror + eavesdropper memory
 *    writes happen on every line.
 */

export interface PendingOffer {
  from: string;
  give: ItemStack[];
  want: ItemStack[];
}

export interface Conversation {
  id: number;
  participants: [string, string];
  transcript: Array<{ speaker: string; text: string }>;
  turnOf: string;
  turns: number;
  state: 'open' | 'closed';
  offer: PendingOffer | null;
  deadline: ReturnType<typeof setTimeout> | null;
  /**
   * Per-speaker count of consecutive turns that near-duplicated that speaker's
   * own previous line. Keyed by participant name. Tracked independently so that
   * bot A accumulating a repeat-streak doesn't falsely trigger the force-end
   * when bot B's NEXT line is also similar to B's own prior — the interleaving
   * is irrelevant; what matters is whether ONE speaker keeps saying the same
   * thing back-to-back across their own turns.
   */
  repeats: Record<string, number>;
}

const TURN_DEADLINE_MS = 150_000;
const MAX_TRANSCRIPT = 40;
const START_RANGE = 16;
/** Token-containment above this = the speaker is rephrasing themselves. */
const REPEAT_SIMILARITY = 0.75;
/** Consecutive near-duplicate turns before the conversation is force-ended. */
const REPEAT_LIMIT = 2;

/**
 * Containment similarity between two chat lines (shared tokens / smaller
 * token set). Catches the agreement ping-pong observed live: "porte-le au
 * coffre" ↔ "avec joie, je te rapporte chaque graine" paraphrased 7 turns in
 * a row, each costing an LLM call while both bots stood still.
 */
export function lineSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

/** Structured wrap-up the leaver attaches to leave_conversation (M12). */
export interface LeaveOpts {
  /** -10..10: how this conversation moved my opinion of them. */
  opinion?: number;
  /** Short note stored with the relation. */
  note?: string;
  /** The memory-worthy takeaway — becomes a high-importance memory for BOTH parties. */
  headline?: string;
}

const NEWS_MIN_IMPORTANCE = 7;
const NEWS_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const NEWS_MAX_LINES = 2;

/**
 * Recent high-importance memories worth telling the partner — the active half
 * of gossip diffusion (eavesdropping is the passive half). Skips memories
 * already involving the partner; zero LLM cost.
 */
export function newsToShare(villager: Villager, partner: string, now = Date.now()): string[] {
  const partnerTag = normalizeKeyword(partner);
  return villager.memory
    .recent(50)
    .filter(
      (m) =>
        (m.importance ?? 0) >= NEWS_MIN_IMPORTANCE &&
        m.kind !== 'system' &&
        now - m.at <= NEWS_MAX_AGE_MS &&
        !(m.tags ?? []).includes(partnerTag)
    )
    .slice(-NEWS_MAX_LINES)
    .map((m) => m.text);
}

export class ConversationManager {
  private ctx!: VillageContext;
  private readonly byName = new Map<string, Conversation>();
  private nextId = 1;

  init(ctx: VillageContext): void {
    this.ctx = ctx;
  }

  get(name: string): Conversation | undefined {
    const conv = this.byName.get(name);
    return conv?.state === 'open' ? conv : undefined;
  }

  activeCount(): number {
    return new Set(Array.from(this.byName.values()).filter((c) => c.state === 'open')).size;
  }

  otherParty(conv: Conversation, name: string): string {
    return conv.participants[0] === name ? conv.participants[1] : conv.participants[0];
  }

  /** Returns an error string, or null on success. */
  start(initiator: string, target: string, opening: string): string | null {
    if (initiator === target) return 'cannot start a conversation with yourself';
    const a = this.ctx.villagers.get(initiator);
    const b = this.ctx.villagers.get(target);
    if (!a || !b) return `no villager named '${target}'`;
    if (this.get(initiator)) return 'you are already in a conversation — leave_conversation first';
    if (this.get(target)) return `${target} is busy talking to someone else — try later`;
    const botA = a.bot();
    const botB = b.bot();
    if (!botA || !botB) return `${target} is not around right now`;
    const distance = botA.entity.position.distanceTo(botB.entity.position);
    if (distance > START_RANGE) {
      const p = botB.entity.position;
      return `${target} is too far away (${distance.toFixed(0)} blocks) — go_to (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}) first`;
    }

    const conv: Conversation = {
      id: this.nextId++,
      participants: [initiator, target],
      transcript: [],
      turnOf: target,
      turns: 0,
      state: 'open',
      offer: null,
      deadline: null,
      repeats: {},
    };
    this.byName.set(initiator, conv);
    this.byName.set(target, conv);
    this.recordLine(conv, a, opening);
    log('info', `[village] conversation #${conv.id}: ${initiator} → ${target}`);
    this.scheduleTurn(conv);
    return null;
  }

  /** A participant speaks. Returns an error string, or null on success. */
  say(speaker: string, text: string): string | null {
    const conv = this.get(speaker);
    if (!conv) return 'you are not in a conversation (use say only mid-conversation, or it goes to the open air)';
    if (conv.turnOf !== speaker) return `it is ${conv.turnOf}'s turn — wait`;
    const villager = this.ctx.villagers.get(speaker);
    if (!villager) return 'unknown speaker';

    // Going-in-circles guard: compare against the speaker's OWN previous line
    // BEFORE recording the new one.
    const prevOwn = [...conv.transcript].reverse().find((l) => l.speaker === speaker);

    this.recordLine(conv, villager, text);
    conv.turns += 1;
    conv.turnOf = this.otherParty(conv, speaker);
    logDebug(speaker, `conversation #${conv.id} turn ${conv.turns}: said "${String(text).slice(0, 120)}" — turn passes to ${conv.turnOf}`);

    if (prevOwn && lineSimilarity(prevOwn.text, String(text)) >= REPEAT_SIMILARITY) {
      conv.repeats[speaker] = (conv.repeats[speaker] ?? 0) + 1;
    } else {
      conv.repeats[speaker] = 0;
    }
    if ((conv.repeats[speaker] ?? 0) >= REPEAT_LIMIT) {
      this.end(conv, 'going in circles — same lines repeated');
      return null;
    }
    if (conv.turns >= this.ctx.settings.maxConversationTurns * 2) {
      this.end(conv, 'reached its natural end');
      return null;
    }
    this.scheduleTurn(conv);
    return null;
  }

  /** Leave (optionally with a farewell line, spoken even off-turn). */
  leave(name: string, farewell?: string, opts: LeaveOpts = {}): string | null {
    const conv = this.get(name);
    if (!conv) return 'you are not in a conversation';
    const villager = this.ctx.villagers.get(name);
    if (farewell && villager) this.recordLine(conv, villager, farewell);

    const other = this.otherParty(conv, name);
    logDebug(
      name,
      `conversation #${conv.id} leave (opinion=${opts.opinion ?? 0}${opts.note ? ` note="${opts.note.slice(0, 60)}"` : ''}${opts.headline ? ` headline="${opts.headline.slice(0, 80)}"` : ''})`
    );
    if (villager && typeof opts.opinion === 'number' && Number.isFinite(opts.opinion) && opts.opinion !== 0) {
      const delta = Math.max(-10, Math.min(10, Math.round(opts.opinion)));
      villager.memory.adjustRelation(other, delta, opts.note?.slice(0, 80));
    }
    const headline = opts.headline?.trim().slice(0, 200);
    if (headline) {
      villager?.memory.append('social', `à retenir de ma discussion avec ${other}: ${headline}`, [name, other], 7);
      this.ctx.villagers.get(other)?.memory.append('social', `${name} m'a confié: ${headline}`, [name, other], 7);
    }

    this.end(conv, `${name} left`);
    return null;
  }

  /** Called by the runtime when a conversation turn produced no move — avoid deadlock. */
  forfeitTurn(name: string): void {
    const conv = this.get(name);
    if (!conv || conv.turnOf !== name) return;
    this.end(conv, `${name} trailed off`);
  }

  /** Prompt block for a participant's deliberation. */
  contextFor(name: string): string | null {
    const conv = this.get(name);
    if (!conv) return null;
    const other = this.otherParty(conv, name);
    const lines = conv.transcript.map((l) => `${l.speaker}: ${l.text}`).join('\n');
    const turnsLeft = this.ctx.settings.maxConversationTurns * 2 - conv.turns;
    let offerBlock = '';
    if (conv.offer) {
      const fmt = (s: ItemStack[]): string => s.map((i) => `${i.count}x ${i.item}`).join(', ') || '(nothing)';
      offerBlock = conv.offer.from === name
        ? `\nYOUR OFFER IS ON THE TABLE: you give [${fmt(conv.offer.give)}] for [${fmt(conv.offer.want)}]. Waiting on ${other}.`
        : `\nOFFER ON THE TABLE from ${other}: they give [${fmt(conv.offer.give)}], they want [${fmt(conv.offer.want)}] from you. accept_trade / reject_trade / counter with propose_trade.`;
    }

    const villager = this.ctx.villagers.get(name);
    const job = villager?.routines.status();
    const jobLine = job
      ? `\nNOTE: you have a job running ('${job.name}', ${Math.floor(job.runningForMs / 60_000)} min). Leave when you're done here so you can get back to work.`
      : turnsLeft <= 4
        ? `\nNOTE: this conversation is wrapping up (~${Math.max(1, Math.floor(turnsLeft / 2))} exchanges left). Finish your thought or leave.`
        : '';

    const news = villager ? newsToShare(villager, other) : [];
    const newsBlock = news.length > 0
      ? `\nNOUVELLES À PARTAGER (si c'est naturel dans la discussion):\n${news.map((n) => `- ${n}`).join('\n')}`
      : '';

    return `=== ACTIVE CONVERSATION with ${other} (it's YOUR turn) ===\n${lines}${offerBlock}${jobLine}${newsBlock}\nSay what you need to say (short, in character), make your trade, or leave_conversation if you're done — don't drag it out. NEVER repeat or rephrase a line you already said: nothing new to add means leave_conversation NOW (repeated lines force-end the conversation). Promises are not actions — if you agree to hand something over, call give or propose_trade BEFORE your say line (speaking ends your turn), not "later". When you leave, rate the encounter (opinion -10..10, note) and pass on the takeaway (headline) if there is one.`;
  }

  private recordLine(conv: Conversation, speaker: Villager, rawText: string): void {
    const text = String(rawText).slice(0, 300);
    conv.transcript.push({ speaker: speaker.name, text });
    if (conv.transcript.length > MAX_TRANSCRIPT) conv.transcript.shift();

    speaker.mirrorChat(text);

    const otherName = this.otherParty(conv, speaker.name);
    const tags = [speaker.name, otherName];
    this.ctx.villagers.get(otherName)?.memory.append('social', `${speaker.name} m'a dit: ${text}`, tags);
    speaker.memory.append('social', `j'ai dit à ${otherName}: ${text}`, tags);

    // Free gossip: villagers in earshot who aren't part of the conversation.
    for (const bystander of speaker.villagersInEarshot(this.ctx.villagers.values())) {
      if (bystander.name === otherName) continue;
      bystander.memory.append('social', `(entendu) ${speaker.name} à ${otherName}: ${text}`, tags);
    }
  }

  private scheduleTurn(conv: Conversation): void {
    this.armDeadline(conv);
    const speaker = this.otherParty(conv, conv.turnOf);
    this.ctx.scheduler.request(conv.turnOf, 'conversation', `${speaker} is waiting on your reply in the conversation`);
  }

  private armDeadline(conv: Conversation): void {
    if (conv.deadline) clearTimeout(conv.deadline);
    conv.deadline = setTimeout(() => {
      if (conv.state === 'open') {
        log('info', `[village] conversation #${conv.id} timed out on ${conv.turnOf}'s turn`);
        this.end(conv, 'fizzled out (no reply)');
      }
    }, TURN_DEADLINE_MS);
    conv.deadline.unref?.();
  }

  private end(conv: Conversation, reason: string): void {
    if (conv.state === 'closed') return;
    conv.state = 'closed';
    logDebug(
      'conversation',
      `#${conv.id} ${conv.participants.join('↔')} closed after ${conv.turns} turns: ${reason}${conv.offer ? ' (offer left on the table)' : ''}`
    );
    if (conv.deadline) clearTimeout(conv.deadline);
    for (const name of conv.participants) {
      this.byName.delete(name);
      this.ctx.scheduler.cancel(name, 'conversation');
      const other = this.otherParty(conv, name);
      const villager = this.ctx.villagers.get(name);
      villager?.memory.append('social', `conversation with ${other} ended (${reason}), ${conv.turns} exchanges`, [other]);
      villager?.memory.adjustRelation(other, 1);
    }
    log('info', `[village] conversation #${conv.id} closed: ${reason}`);
    // Release the participants' held background wake-ups (error/job/heartbeat
    // are gated while a conversation is live — see the scheduler's isHeld).
    this.ctx.scheduler.pump();
  }
}
