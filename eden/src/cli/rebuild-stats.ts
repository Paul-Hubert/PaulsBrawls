// `eden rebuild-stats` (cli/ — a CONSUMER, like admin/: may import anything; nothing imports it). It
// rebuilds the derived views (views/) PURELY by replaying the journal (05 §Derived-state, 11 §8). The
// deliverable invariant (M7): rebuild-by-replay == live — proven in tests/rebuild-stats.test.ts. This is
// what makes the journal trustworthy as the sole writer: any cached view can be thrown away and rebuilt.
//
// Usage: `npm run rebuild-stats -- [dataDir]` (default '.eden-data'). Prints a JSON summary via logger
// (R23: the CLI prints through logger, never console.*).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Journal } from '../journal/journal';
import type { JournalReader } from '../views/index';
import { SkillStatsView, CompetenceView, RelationsView, TradeLedgerView } from '../views/index';
import { logger } from '../logger';

/** The four rebuilt views' values — exactly the aggregates the admin / website render. */
export interface RebuiltStats {
  skillStats: ReturnType<SkillStatsView['value']>;
  competence: ReturnType<CompetenceView['value']>;
  relations: ReturnType<RelationsView['value']>;
  tradeLedger: ReturnType<TradeLedgerView['value']>;
}

/**
 * Rebuild every derived view by replaying the journal (the pure core — no I/O of its own). Each view's
 * `rebuildByReplay(journal)` folds the whole history; the result MUST equal a live fold (the M7 law).
 */
export function rebuildStats(journal: JournalReader): RebuiltStats {
  const skillStats = new SkillStatsView();
  const competence = new CompetenceView();
  const relations = new RelationsView();
  const tradeLedger = new TradeLedgerView();
  skillStats.rebuildByReplay(journal);
  competence.rebuildByReplay(journal);
  relations.rebuildByReplay(journal);
  tradeLedger.rebuildByReplay(journal);
  return {
    skillStats: skillStats.value(),
    competence: competence.value(),
    relations: relations.value(),
    tradeLedger: tradeLedger.value(),
  };
}

/** Open the real journal at `<dataDir>/eden.db`, rebuild the views, print the summary, close. */
export function main(dataDir = '.eden-data'): void {
  const dbPath = join(dataDir, 'eden.db');
  mkdirSync(dataDir, { recursive: true }); // better-sqlite3 refuses to open if the dir is absent
  const journal = new Journal(dbPath);
  try {
    const stats = rebuildStats(journal);
    const skills = Object.keys(stats.skillStats).length;
    const villagers = Object.keys(stats.competence).length;
    const relations = Object.values(stats.relations).reduce((n, m) => n + Object.keys(m).length, 0);
    logger.info('admin', `rebuild-stats from ${dbPath}: ${skills} skill(s), ${villagers} villager(s), ${relations} relation edge(s), ${stats.tradeLedger.length} trade(s)`);
    logger.info('admin', JSON.stringify(stats, null, 2));
  } finally {
    journal.close();
  }
}

// Run directly: `tsx src/cli/rebuild-stats.ts [dataDir]`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv[2] ?? '.eden-data');
}
