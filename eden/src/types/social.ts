// Social seam (layer 0) — the interfaces that let social/{conversation,trade} reach a villager's
// memory + relations WITHOUT importing villagers/ (the dependency law: layer-3 actors never import
// each other). main.ts wires the concrete VillagerMemory (villagers/) behind these interfaces and
// hands them to the social modules — exactly the discipline that keeps god/ out of villagers/ via the
// Inbox. Imports nothing (types/ is layer 0).

import type { MemoryEntry, Relation } from './memory';

/**
 * One line item in a typed trade offer (04 §Trade). `item` is a Minecraft item name; the alias `coin`
 * resolves to `paulsbrawls:coin` at settlement (Gibber is the village currency for free). Typed offer
 * objects — never free text — so the mod can re-validate + swap atomically.
 */
export interface TradeItem {
  item: string;
  count: number;
}

/** A free-text memory a social interaction seeds (the writer assigns `at`). */
export interface MemorySeed {
  kind: MemoryEntry['kind'];
  text: string;
  tags?: string[];
  /** 0–10 (defaulted by kind if omitted). leave_conversation headlines are high-importance. */
  importance?: number;
}

/**
 * What social/ may do to ONE villager's memory — a narrow write surface (S2: the memory module is the
 * sole writer; social/ only asks it to record). `remember` seeds an episodic entry; `moveRelation`
 * adjusts the per-other score + note (leave_conversation). The concrete VillagerMemory satisfies this.
 */
export interface MemoryWriter {
  /** The villager whose memory this writes to. */
  readonly villager: string;
  /** Seed an episodic memory entry. */
  remember(seed: MemorySeed): void;
  /** Adjust the relation toward `other` by `delta`, replacing the note (leave_conversation). */
  moveRelation(other: string, delta: number, note: string): Relation;
}

/**
 * A conversation participant as social/ sees it — name + the narrow memory surface + a "speak to game
 * chat" sink that the mirror gate uses (only fires with a player in earshot). The body itself stays in
 * bots/ (the chat sink is supplied by main.ts so social/ needn't hold a Bot). `playerInEarshot` is the
 * gate the mirror consults.
 */
export interface Conversant {
  readonly name: string;
  readonly memory: MemoryWriter;
  /** Speak one line to the game chat (the mirror gate decides WHETHER to call this). */
  sayInGame(line: string): void;
  /** True iff a (human) player is within earshot — the mirror gate (04: mirror only then). */
  playerInEarshot(): boolean;
}

/** A typed two-sided offer: `from` gives `give`, wants `want` from `to`. Never free text (re-validatable). */
export interface TradeOffer {
  from: string;
  to: string;
  give: TradeItem[];
  want: TradeItem[];
}

/** A settlement outcome — ok on a 2xx swap, else a named failure (the inventories are untouched). */
export interface SettlementResult {
  ok: boolean;
  /** The cause when !ok (HTTP status / network error / re-validation reject / declined / expired) — S10. */
  reason?: string;
}

/** An offer waiting for its partner's answer (TradeBook, social/trade.ts). */
export interface PendingTrade {
  id: string;
  offer: TradeOffer;
  /** Epoch ms after which the offer can no longer be accepted. */
  expiresAt: number;
}

/**
 * What a villager's trade tools may do — the seam that lets villagers/tools.ts reach social/'s TradeBook
 * without importing social/ (layer-3 actors never import each other). main.ts injects the concrete book.
 * Consent is built in: `propose` only puts an offer on the table; nothing moves until the PARTNER
 * `answer`s with accept=true. Neither method throws — every refusal is a named {ok:false, reason}.
 */
export interface TradeDesk {
  /** Validate + record an offer and notify the partner. Returns the pending offer, or why it was refused. */
  propose(offer: TradeOffer): { ok: true; trade: PendingTrade } | { ok: false; reason: string };
  /** The partner (`by`) accepts (→ R33 reach + settlement) or declines a pending offer. */
  answer(id: string, by: string, accept: boolean): Promise<SettlementResult>;
  /** Live (unexpired) offers `villager` made or received. */
  pendingFor(villager: string): PendingTrade[];
}

// ── Conversations (D-18). The speak-turn types live here so villagers/ can implement a turn generator and
//    social/ can run the conversation without either importing the other. ──

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

/** One line already said in a conversation (what the next speaker reads). */
export interface TranscriptLine {
  from: string;
  text: string;
}

/** Asks a participant for its next turn, given everything said so far. The conversation enforces the deadline. */
export type SpeakFn = (transcript: readonly TranscriptLine[]) => Promise<SpeakResult>;

/**
 * What a villager's speech tools may do — the seam that lets villagers/tools.ts reach social/'s ConversationBook
 * (D-18). Neither method throws: a refusal is a named {ok:false, reason} in French (it is read by the villager).
 */
export interface ConversationDesk {
  /** Say a line aloud in the game chat (public; heard by whoever is near). */
  say(villager: string, text: string): { ok: true } | { ok: false; reason: string };
  /** Send a private line to another villager's inbox (it wakes them — D-17). */
  tell(from: string, to: string, text: string): { ok: true } | { ok: false; reason: string };
  /** Open a turn-taking conversation with a nearby villager; it runs in the background. */
  start(initiator: string, partner: string, topic: string): { ok: true; id: string } | { ok: false; reason: string };
}
