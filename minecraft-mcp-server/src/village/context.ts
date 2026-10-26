import type { Persistence } from './persistence.js';
import type { DailyRhythm } from './day-planner.js';
import type { EmbeddingService } from './embeddings.js';
import type { LLMClient } from './llm-client.js';
import type { VillageScheduler } from './scheduler.js';
import type { VillageSettings } from './types.js';
import type { Villager } from './villager.js';
import type { ConversationManager } from './conversation.js';
import type { TradeManager } from './trade.js';

/**
 * The wiring hub passed to every subsystem. Type-only imports everywhere keep
 * the module graph acyclic at runtime; main.ts assembles the real thing.
 */
export interface VillageContext {
  settings: VillageSettings;
  llm: LLMClient;
  scheduler: VillageScheduler;
  persistence: Persistence;
  embeddings: EmbeddingService;
  rhythm: DailyRhythm;
  villagers: Map<string, Villager>;
  /** Fast "is this username one of ours" lookups (chat routing, entity tagging). */
  villagerNames: ReadonlySet<string>;
  conversations: ConversationManager;
  trades: TradeManager;
  startedAt: number;
}
