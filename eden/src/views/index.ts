// views/ — LAYER 1 derived folds (11 §8, 05 §Derived-state). Each view FOLDS the journal into a cached
// aggregate; it is NEVER primary state (P4/S2: writers append facts, readers fold facts). The journal
// stays the sole writer; a view can be thrown away and rebuilt purely by replay — `rebuildByReplay`
// MUST equal a live fold (the M7 deliverable, proven in tests/views.test.ts + tests/rebuild-stats.test.ts).
//
// Dependency law: views/ imports ONLY journal/ + types/ (the `views-only-journal-types` depcruise rule),
// so admin/, skills/library, and god/ may read views UPWARD without importing each other (08 / IMPL-PLAN
// §1.1 "Placing it lower than skills/ is what keeps those reads legal").

import type { JournalEvent, RunReport, SkillStats, TradeItem } from '../types/index';
import type { IJournal } from '../journal/journal';

/** The journal read surface a view needs to rebuild itself (just `query`). */
export type JournalReader = Pick<IJournal, 'query'>;

/**
 * A derived view (11 §8). `fold` folds one event (the live path, from the journal subscribe stream);
 * `rebuildByReplay` rebuilds the whole aggregate from the journal (the `eden rebuild-stats` path).
 * `value` returns the current aggregate. The rebuild-by-replay == live invariant is the design law.
 */
export abstract class DerivedView<V> {
  /** Fold one journal event into the running aggregate (idempotency is NOT assumed — feed each event once). */
  abstract fold(event: JournalEvent): void;
  /** The current derived value (a fresh structural read; callers must not mutate it in place). */
  abstract value(): V;
  /** Reset internal state to empty — called by rebuildByReplay before a clean replay. */
  protected abstract reset(): void;

  /** Rebuild the whole aggregate by replaying the journal in chronological order (P4 derived-state). */
  rebuildByReplay(journal: JournalReader): void {
    this.reset();
    for (const e of journal.query()) this.fold(e);
  }
}

// ── SkillStatsView (from skill.run) ─────────────────────────────────────────
/** Per-skill run statistics, folded from `skill.run` RunReports (skill page; library read_skill stats). */
export class SkillStatsView extends DerivedView<Record<string, SkillStats>> {
  private stats: Record<string, SkillStats> = {};

  fold(event: JournalEvent): void {
    if (event.kind !== 'skill.run') return;
    const r = event.payload as RunReport;
    const s = (this.stats[r.skill] ??= { runs: 0, successes: 0, failures: 0, stalls: 0, avgMs: 0 });
    // Maintain a running mean without keeping every sample (avgMs * n + new) / (n+1).
    const prevRuns = s.runs;
    s.avgMs = (s.avgMs * prevRuns + r.durationMs) / (prevRuns + 1);
    s.runs += 1;
    if (r.outcome.ok) {
      s.successes += 1;
    } else {
      s.failures += 1;
      s.lastError = r.outcome.error;
    }
    if (r.aborted === 'stalled') s.stalls += 1;
    s.lastRunAt = event.at;
  }

  value(): Record<string, SkillStats> {
    // Round avgMs so the JSON page is readable; the running mean stays exact internally.
    const out: Record<string, SkillStats> = {};
    for (const [k, v] of Object.entries(this.stats)) out[k] = { ...v, avgMs: Math.round(v.avgMs) };
    return out;
  }

  protected reset(): void {
    this.stats = {};
  }
}

// ── CompetenceView (per-villager × skill success, from skill.run) ────────────
/**
 * Per-villager, per-skill success counts folded from `skill.run` (11 §9: "RunReport already records
 * villager × skill × outcome"). NOTE: the design's "per-tag" competence needs the live skill manifest's
 * tags, which the journal does not carry — a journal-pure fold keys by SKILL name (the dimension the
 * journal actually has). God's dossier still folds tag-competence from the live library at verdict time
 * (god/god.ts updateDossier); this view is the journal-derivable, rebuild-by-replay-safe variant.
 */
export class CompetenceView extends DerivedView<Record<string, Record<string, { runs: number; successes: number }>>> {
  private comp: Record<string, Record<string, { runs: number; successes: number }>> = {};

  fold(event: JournalEvent): void {
    if (event.kind !== 'skill.run') return;
    const r = event.payload as RunReport;
    const byVillager = (this.comp[r.villager] ??= {});
    const c = (byVillager[r.skill] ??= { runs: 0, successes: 0 });
    c.runs += 1;
    if (r.outcome.ok) c.successes += 1;
  }

  value(): Record<string, Record<string, { runs: number; successes: number }>> {
    const out: Record<string, Record<string, { runs: number; successes: number }>> = {};
    for (const [villager, skills] of Object.entries(this.comp)) {
      out[villager] = {};
      for (const [skill, c] of Object.entries(skills)) out[villager][skill] = { ...c };
    }
    return out;
  }

  protected reset(): void {
    this.comp = {};
  }
}

// ── RelationsView (from conversation.ended opinions) ──────────────────────────
/** A folded relation: the leaver's cumulative opinion of the partner + the latest headline note. */
interface FoldedRelation {
  score: number;
  note: string;
  at: number;
}

/** Per-villager → per-other relation scores, folded from `conversation.ended` leave opinions (04). */
export class RelationsView extends DerivedView<Record<string, Record<string, FoldedRelation>>> {
  private rel: Record<string, Record<string, FoldedRelation>> = {};
  // conversation.started records the pair so conversation.ended can resolve the partner of the leaver.
  private readonly pairs = new Map<string, { initiator: string; partner: string }>();

  fold(event: JournalEvent): void {
    if (event.kind === 'conversation.started') {
      const p = event.payload as { id: string; initiator: string; partner: string };
      this.pairs.set(p.id, { initiator: p.initiator, partner: p.partner });
      return;
    }
    if (event.kind !== 'conversation.ended') return;
    const p = event.payload as { id: string; by: string; opinion?: number; headline?: string };
    if (p.opinion === undefined) return; // turn-cap / deadline / partner-gone close without a leave opinion
    const pair = this.pairs.get(p.id);
    if (!pair) return;
    const other = p.by === pair.initiator ? pair.partner : pair.initiator;
    const byVillager = (this.rel[p.by] ??= {});
    const r = (byVillager[other] ??= { score: 0, note: '', at: 0 });
    r.score += p.opinion;
    if (p.headline) r.note = p.headline;
    r.at = event.at;
  }

  value(): Record<string, Record<string, FoldedRelation>> {
    const out: Record<string, Record<string, FoldedRelation>> = {};
    for (const [villager, others] of Object.entries(this.rel)) {
      out[villager] = {};
      for (const [other, r] of Object.entries(others)) out[villager][other] = { ...r };
    }
    return out;
  }

  protected reset(): void {
    this.rel = {};
    this.pairs.clear();
  }
}

// ── TradeLedgerView (from trade.proposed/settled/failed) ─────────────────────
/** One trade as the ledger view sees it: the offer + its terminal status. */
export interface TradeLedgerEntry {
  id: string;
  from: string;
  to: string;
  give: TradeItem[];
  want: TradeItem[];
  status: 'proposed' | 'settled' | 'failed';
  reason?: string;
  at: number;
}

/** The trade ledger folded from `trade.proposed/settled/failed` — one entry per trade id (04 §Trade). */
export class TradeLedgerView extends DerivedView<TradeLedgerEntry[]> {
  private readonly byId = new Map<string, TradeLedgerEntry>();

  fold(event: JournalEvent): void {
    if (event.kind === 'trade.proposed') {
      const p = event.payload as { id: string; from: string; to: string; give: TradeItem[]; want: TradeItem[] };
      this.byId.set(p.id, { id: p.id, from: p.from, to: p.to, give: p.give, want: p.want, status: 'proposed', at: event.at });
      return;
    }
    if (event.kind === 'trade.settled') {
      const p = event.payload as { id: string; from: string; to: string; give: TradeItem[]; want: TradeItem[] };
      const e = this.byId.get(p.id) ?? { id: p.id, from: p.from, to: p.to, give: p.give, want: p.want, status: 'proposed' as const, at: event.at };
      e.status = 'settled';
      e.at = event.at;
      this.byId.set(p.id, e);
      return;
    }
    if (event.kind === 'trade.failed') {
      const p = event.payload as { id: string; from: string; to: string; reason: string };
      const e = this.byId.get(p.id) ?? { id: p.id, from: p.from, to: p.to, give: [], want: [], status: 'proposed' as const, at: event.at };
      e.status = 'failed';
      e.reason = p.reason;
      e.at = event.at;
      this.byId.set(p.id, e);
    }
  }

  value(): TradeLedgerEntry[] {
    return [...this.byId.values()].map((e) => ({ ...e, give: [...e.give], want: [...e.want] })).sort((a, b) => a.at - b.at);
  }

  protected reset(): void {
    this.byId.clear();
  }
}

/** The four concrete views — the rebuild-stats CLI + the rebuild==live test iterate this set. */
export const ALL_VIEWS = [SkillStatsView, CompetenceView, RelationsView, TradeLedgerView] as const;
