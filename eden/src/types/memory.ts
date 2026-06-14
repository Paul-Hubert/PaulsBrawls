/** One entry in a villager's memory window — tagged, importance-scored, timestamped. */
export interface MemoryEntry {
  kind: 'event' | 'social' | 'trade' | 'thought' | 'system' | 'lesson';
  text: string;
  tags: string[];
  /** 0–10, heuristic by kind at write time; bumped during summarization. */
  importance: number;
  at: number;
}

/**
 * A per-other-villager relation — a score (negative = wary, positive = friendly) plus a short note.
 * Carried over from v1 unchanged (04 §Memory); `leave_conversation` moves it. Stored inside a
 * villager's memory record (journal-derivable later; the live store is the source).
 */
export interface Relation {
  /** The OTHER party's name. */
  other: string;
  /** Cumulative opinion score (clamped to a sane band by the writer). */
  score: number;
  /** A short free-text note (the latest headline/impression). */
  note: string;
  at: number;
}
