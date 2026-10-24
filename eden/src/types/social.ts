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

/**
 * The structured relationship beat a `say` may carry (the `leave_conversation{opinion,note,headline}`
 * payload, 04). When present, the social port moves the speaker's relation toward the addressee + seeds a
 * high-importance headline memory for BOTH parties — the same writes social/Conversation performs, so a
 * one-shot tool-driven `say` still closes the conversation→memory/relations loop (R69).
 */
export interface SayBeat {
  /** Relation delta toward the addressee (signed). */
  opinion: number;
  /** The short relation note (replaces the prior note). */
  note: string;
  /** The headline — seeded as a HIGH-importance social memory for BOTH parties (04). */
  headline: string;
}

/**
 * The villager-facing SOCIAL/ECONOMIC port (layer 0 contract) — the seam the layer-3 ToolRegistry drives
 * for `say`/`propose_trade` WITHOUT importing social/ (the social-no-peers rule). main.ts binds one per
 * villager (the speaker `from` is fixed at construction — NEVER a tool arg — so tool input can't inject a
 * raw settlement `from`/`to`/amount outside a negotiated offer). The concrete impls wrap social/
 * {@link Conversant}-backed conversation writes + the TradeService/SettlementClient path.
 */
export interface VillagerSocial {
  /**
   * Speak one line as this villager. `to` (optional) addresses a nearby villager — that villager hears it
   * (journals chat.said/heard + a social memory). An optional {@link SayBeat} moves the relation toward the
   * addressee (closes R69). Returns ok:false with a named reason on a usage error (e.g. unknown addressee).
   * The implementation drops/strips a leading `/` (no command emission — mirror the God-body interceptor).
   */
  say(opts: { to?: string; text: string; beat?: SayBeat }): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Put a typed offer on the table and settle it via the mod's atomic :8767 listener (the ONLY trade path —
   * never a raw inventory mutation). `to` is the partner; `give`/`want` are typed items (coin→paulsbrawls:coin
   * at settlement). Returns the settlement outcome (ok:false names the failure — settlement HTTP/timeout/
   * reject — so a villager's inventory belief can't silently diverge from server truth).
   */
  proposeTrade(opts: { to: string; give: TradeItem[]; want: TradeItem[] }): Promise<{ ok: boolean; reason?: string }>;
}
