// Assertion helpers for the live-scenario harness — two families. JOURNAL checks read host.journal (the
// durable record of what the loop actually did: draft -> run -> ticket -> verdict -> admit, deaths,
// errors). WORLD checks use RCON to read the live server (inventory counts, surviving mobs) — ground
// truth the journal can't see. Scenarios compose these into a PASS/FAIL verdict; none of them mutate.

import type { EdenHost } from '../src/main';
import type { Author, JournalEvent, RunReport } from '../src/types/index';
import type { RconSend } from './rcon';

// ── World checks (RCON) ──────────────────────────────────────────────────────

/**
 * Count how many of `item` the bot holds. Uses `clear <bot> minecraft:<item> 0` — a maxCount of 0 makes
 * /clear COUNT matching items and remove nothing (documented since 1.13), so it's a non-destructive,
 * NBT-parse-free inventory probe. Returns 0 when none are found.
 */
export async function inventoryCount(rcon: RconSend, bot: string, item: string): Promise<number> {
  const id = item.includes(':') ? item : `minecraft:${item}`;
  const reply = await rcon(`clear ${bot} ${id} 0`);
  const m = /Found (\d+)/i.exec(reply);
  return m ? Number(m[1]) : 0;
}

/**
 * Whether any entity matching `selector` is still alive. Binary — exactly the "all dead?" gate. Pass an
 * AREA-SCOPED selector (a box volume) so pre-existing mobs elsewhere in the loaded world don't pollute it.
 */
export async function entitiesRemain(
  rcon: RconSend,
  selector = '@e[type=minecraft:zombie]',
): Promise<{ remain: boolean; raw: string }> {
  const raw = await rcon(`execute if entity ${selector}`);
  // `execute if entity` replies "Test passed" when ≥1 match, "Test failed" when none.
  return { remain: /passed/i.test(raw), raw };
}

// ── Journal checks ───────────────────────────────────────────────────────────

const payload = <T>(e: JournalEvent): T => e.payload as T;

/** All events tied to a rollout (refs.rolloutId), optionally narrowed to kinds. */
export function eventsForRollout(host: EdenHost, rolloutId: string, kinds?: string[]): JournalEvent[] {
  const q = kinds ? { ref: rolloutId, kinds } : { ref: rolloutId };
  return host.journal.query(q);
}

/** The five-stage M3 chain, as booleans, for one rollout. `draftByVillager` requires a VILLAGER author. */
export interface ChainStatus {
  draftByVillager: boolean;
  runOk: boolean;
  ticket: boolean;
  verdict: boolean;
  verdictSuccess: boolean;
  admit: boolean;
}

export function chainStatus(host: EdenHost, rolloutId: string): ChainStatus {
  const drafts = eventsForRollout(host, rolloutId, ['skill.draft']);
  const runs = eventsForRollout(host, rolloutId, ['skill.run']);
  const verdicts = eventsForRollout(host, rolloutId, ['god.verdict']);
  return {
    draftByVillager: drafts.some((e) => payload<{ author: Author }>(e).author.kind === 'villager'),
    runOk: runs.some((e) => payload<RunReport>(e).outcome.ok),
    ticket: eventsForRollout(host, rolloutId, ['god.ticket']).length > 0,
    verdict: verdicts.length > 0,
    verdictSuccess: verdicts.some((e) => payload<{ success: boolean }>(e).success),
    admit: eventsForRollout(host, rolloutId, ['skill.admit']).length > 0,
  };
}

/** Successful skill runs (optionally for one rollout). Returns the RunReports so callers can inspect. */
export function successfulRuns(host: EdenHost, rolloutId?: string): RunReport[] {
  const evs = rolloutId
    ? eventsForRollout(host, rolloutId, ['skill.run'])
    : host.journal.query({ kinds: ['skill.run'] });
  return evs.map((e) => payload<RunReport>(e)).filter((r) => r.outcome.ok);
}

/** Distinct villagers whose successful runs touched a combat skill (kill-mob or an authored fight skill). */
export function combatRunners(host: EdenHost): string[] {
  const combat = /kill|attack|combat|zombie|defen|fight|mob/i;
  const villagers = new Set<string>();
  for (const r of successfulRuns(host)) {
    if (combat.test(r.skill)) villagers.add(r.villager);
  }
  return [...villagers];
}

/** Host-level errors (the Blocker-Z survival signal: a real boot survives, so this should be empty). */
export function hostErrors(host: EdenHost): string[] {
  return host.journal.query({ kinds: ['system.error'] }).map((e) => payload<{ message: string }>(e).message);
}

/** Deaths among the given villagers (non-combat scenarios expect zero). */
export function deathsAmong(host: EdenHost, names: string[]): Array<{ name: string; cause?: string }> {
  const set = new Set(names);
  return host.journal
    .query({ kinds: ['world.death'] })
    .map((e) => payload<{ name: string; cause?: string }>(e))
    .filter((d) => set.has(d.name));
}

/** A compact kind histogram over the whole journal — handy in PASS/FAIL reports. */
export function kindHistogram(host: EdenHost): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const e of host.journal.query({ limit: 1_000_000 })) hist[e.kind] = (hist[e.kind] ?? 0) + 1;
  return hist;
}
