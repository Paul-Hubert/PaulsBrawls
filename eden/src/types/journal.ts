/**
 * Causality column — what an event belongs to. The website's "rollout view" is
 * `WHERE refs.rolloutId = ? ORDER BY at`, so these are first-class, not invented later.
 */
export interface Refs {
  runId?: string;
  rolloutId?: string;
  taskId?: string;
  verdictId?: string;
  directiveId?: string;
  skill?: string;
  skillVersion?: number;
  conversationId?: string;
  tradeId?: string;
  llmCallId?: string;
}

/**
 * `kind` is typed as `string` here on purpose: types/ imports nothing (the law), so the
 * canonical JournalKind union + per-kind payload types live in journal/kinds.ts (the S1
 * registry). The sole writer (journal.ts) enforces the union at its `append` signature;
 * readers (admin) render unknown kinds generically (05).
 */
export interface JournalEvent {
  /** ulid — sortable, unique. */
  id: string;
  /** epoch ms. */
  at: number;
  /** 'villager:Firmin' | 'god:critic' | 'engine' | 'admin' | 'player:<name>' (R41). */
  actor: string;
  kind: string;
  payload: object;
  refs: Refs;
}

export interface JournalQuery {
  kinds?: string[];
  actor?: string;
  /** Match the single event with this exact ulid (the command bar's id-resolution path). */
  id?: string;
  /** Match any event whose refs contain this exact value (any ref field). */
  ref?: string;
  since?: number;
  until?: number;
  limit?: number;
  /**
   * Result ordering. Default `asc` (chronological). `desc` returns newest-first — what the dashboard's
   * live feeds request. With a `limit`, BOTH orders select the most-recent N (the limit window is the
   * tail of the timeline); only the order they are returned in differs.
   */
  order?: 'asc' | 'desc';
}
