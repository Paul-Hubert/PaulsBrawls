/**
 * Shared types for the AI village (see ../../../VILLAGE_PLAN.md).
 *
 * Kept dependency-free (no mineflayer imports) so the pure-logic modules —
 * scheduler, conversation, trade, sandbox — stay unit-testable without a bot.
 */

// ---------------------------------------------------------------------------
// Roster / configuration
// ---------------------------------------------------------------------------

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface RosterBot {
  /** Minecraft username — must be unique, must NOT collide with the God avatar's name. */
  name: string;
  /** Free-form role label ('farmer', 'guard', …). Drives stock skills + prompts. */
  role: string;
  /** Persona blurb injected into the system prompt. */
  personality: string;
  /** Home / respawn anchor. If omitted, spawn position is captured on first connect. */
  home?: Vec3Like;
  /** Where this bot works (farm plot center, mine entrance, …). */
  workstation?: Vec3Like;
  /** Personal storage chest (used by deposit/withdraw). */
  chest?: Vec3Like;
}

/**
 * Runtime corrections to the roster's world anchors, persisted per bot. The
 * roster file is a blind assertion about the world (worlds get regenerated,
 * chests get moved); when validation or a deposit/withdraw discovers where
 * things ACTUALLY are, the corrected position lands here and wins over the
 * roster from then on.
 */
export interface AnchorOverrides {
  home?: Vec3Like;
  chest?: Vec3Like;
}

export interface LLMSettings {
  /** 'openai' | 'lmstudio' | 'ollama' | 'custom' — only changes the default baseUrl. */
  provider: string;
  /** OpenAI-compatible /v1 base URL. Empty → derived from provider. */
  baseUrl: string;
  /** Model id. */
  model: string;
  /**
   * Latency tier (M14): small/fast model for the player-facing calls
   * (conversation turns, player wake-ups, memory summarization). Same
   * provider/baseUrl; empty → no tiering, everything uses `model`.
   */
  fastModel: string;
  /** API key; empty → process.env.OPENAI_API_KEY. */
  apiKey: string;
  /** Per-request timeout (ms). */
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
}

/** Which latency tier a call belongs to — 'fast' falls back to `model` when no fastModel is set. */
export type LLMTier = 'main' | 'fast';

export interface EmbeddingSettings {
  /**
   * 'local'    — in-process transformers.js (downloads the model on first use,
   *              then works offline; no API needed).
   * 'provider' — POST {llm baseUrl}/embeddings (OpenAI, LM Studio with an
   *              embedding model loaded).
   * 'off'      — semantic retrieval disabled; keyword recall still works.
   */
  mode: 'local' | 'provider' | 'off';
  /** Empty → per-mode default (see config.resolveEmbeddingModel). */
  model: string;
}

export interface NeedsSettings {
  /** Rest lost per real minute while a routine runs. */
  restDecayPerMin: number;
  /** Rest regained per real minute while not working. */
  restRecoverPerMin: number;
  /** Social lost per real minute with no company in earshot. */
  socialDecayPerMin: number;
  /** Social regained per real minute in company / conversation. */
  socialRecoverPerMin: number;
  /** Below this a 'tired'/'lonely' event fires (re-armed at 2× the threshold). */
  lowThreshold: number;
}

export interface VillageSettings {
  llm: LLMSettings;
  embeddings: EmbeddingSettings;
  /** Dawn plan deliberations + role-fallback schedules (M11). Slot execution
   *  always runs when a plan exists; this only gates the AUTOMATIC requests. */
  dayPlanning: boolean;
  needs: NeedsSettings;
  /** Proximity greet gate (M12): free check that may spend one deliberation
   *  when two friendly/lonely villagers cross paths. */
  spontaneousChat: boolean;
  /** Max LLM calls in flight across the whole village. */
  concurrency: number;
  /** Base seconds between idle heartbeats per bot (staggered, jittered). */
  heartbeatSeconds: number;
  /** Min ms between deliberations for one bot. */
  botCooldownMs: number;
  /** Players within this radius hear mirrored bot chat. */
  earshotRadius: number;
  /** Java mod settlement listener, e.g. http://127.0.0.1:8767 */
  settlementUrl: string;
  /** Directory for persisted state (memories, skills, ledger). */
  dataDir: string;
  /** Max turns in one bot↔bot conversation before forced wrap-up. */
  maxConversationTurns: number;
}

export interface VillageRosterFile {
  settings: Partial<VillageSettings> & {
    llm?: Partial<LLMSettings>;
    embeddings?: Partial<EmbeddingSettings>;
    needs?: Partial<NeedsSettings>;
  };
  bots: RosterBot[];
}

// ---------------------------------------------------------------------------
// Events (the reflex layer's vocabulary)
// ---------------------------------------------------------------------------

export type VillageEventType =
  | 'hurt'            // I took damage. payload.attacker is best-effort.
  | 'entity-spotted'  // a hostile entered my awareness radius
  | 'message'         // another villager tell()'d me
  | 'player-chat'     // a player spoke within earshot
  | 'item-received'   // I picked something up
  | 'night-falls'     // day→night transition
  | 'new-day'         // night→day transition (a fresh Minecraft day)
  | 'tired'           // my rest need crossed the low threshold
  | 'lonely'          // my social need crossed the low threshold
  | 'died'            // I died (fired after respawn)
  | 'job-done'        // my routine finished
  | 'job-failed';     // my routine threw

export interface EventEntityInfo {
  id: number;
  name: string;
  /** 'hostile' | 'player' | 'villager' | 'animal' | 'other' */
  kind: string;
  position: Vec3Like;
  /** Distance from the perceiving bot, when known. */
  distance?: number;
}

export interface VillageEvent {
  type: VillageEventType;
  /** Best-effort attacker for 'hurt'. */
  attacker?: EventEntityInfo;
  entity?: EventEntityInfo;
  /** Sender for 'message', player name for 'player-chat'. */
  from?: string;
  text?: string;
  item?: string;
  count?: number;
  job?: string;
  error?: string;
  /** For 'tired'/'lonely': the need's current value (0..1). */
  value?: number;
  /** For 'job-done'/'job-failed': the success-check verdict, when one was declared. */
  outcome?: string;
  /** For 'job-done': the routine completed with zero productive actions AND
   *  visible action errors, repeatedly — the approach is not working. */
  futile?: boolean;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Priority order, most urgent first. */
export type ThinkKind = 'player' | 'combat' | 'conversation' | 'error' | 'job' | 'plan' | 'heartbeat';

export const THINK_PRIORITY: Record<ThinkKind, number> = {
  player: 0,
  combat: 1,
  conversation: 2,
  error: 3,
  job: 4,
  plan: 4.5,
  heartbeat: 5,
};

export interface ThinkRequest {
  botName: string;
  kind: ThinkKind;
  /** Coalesced reasons — every trigger that piled up while waiting. */
  reasons: string[];
  enqueuedAt: number;
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export interface ItemStack {
  /** Minecraft item id without namespace, e.g. 'carrot', 'oak_planks', 'coin'. */
  item: string;
  count: number;
}

export interface TradeOffer {
  /** What the offering bot hands over. */
  give: ItemStack[];
  /** What the offering bot wants back. */
  want: ItemStack[];
}

export interface LedgerEntry {
  at: number;
  a: string;
  b: string;
  /** Items that went a→b. */
  aGave: ItemStack[];
  /** Items that went b→a. */
  bGave: ItemStack[];
}

// ---------------------------------------------------------------------------
// Skills (bot-authored code)
// ---------------------------------------------------------------------------

export type SkillKind = 'reflex' | 'routine';

export interface Skill {
  name: string;
  kind: SkillKind;
  description: string;
  code: string;
  version: number;
  status: 'active' | 'disabled';
  errorCount: number;
  lastError?: string;
  /** True for the built-in seeds — they never count toward authored-skill caps. */
  stock?: boolean;
}

// ---------------------------------------------------------------------------
// Daily rhythm (M11)
// ---------------------------------------------------------------------------

export interface DayPlanSlot {
  /** Minecraft day-time bounds, 0..24000 ticks; [from, to). */
  from: number;
  to: number;
  /** 'job:<routine>' | 'visit:<villager>' | 'home' | 'idle' */
  activity: string;
}

export interface DayPlan {
  /** Absolute Minecraft day this plan is for. */
  day: number;
  slots: DayPlanSlot[];
  source: 'llm' | 'fallback';
}

/** Drive levels, 0 (desperate) .. 1 (sated). */
export interface BotNeeds {
  rest: number;
  social: number;
}

// ---------------------------------------------------------------------------
// Benchmark (food-production score, see benchmark.ts)
// ---------------------------------------------------------------------------

/** Monotonic per-bot food counters. Persisted so restarts don't reset the score. */
export interface BotStats {
  foodAcquired: number;
  foodDeposited: number;
  foodWithdrawn: number;
  deaths: number;
  perItem: Record<string, number>;
}

export function emptyBotStats(): BotStats {
  return { foodAcquired: 0, foodDeposited: 0, foodWithdrawn: 0, deaths: 0, perItem: {} };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  at: number;
  kind: 'event' | 'social' | 'trade' | 'thought' | 'system';
  text: string;
  /** Normalized lookup keywords. Absent on entries written by older versions. */
  tags?: string[];
  /**
   * 0–10 salience for retrieval ranking. Heuristic by kind at write time;
   * bumped by the summarization pass. Absent on entries written by older
   * versions (treated as the kind default).
   */
  importance?: number;
}

export interface RelationEntry {
  /** -100..100. */
  score: number;
  notes: string;
}
