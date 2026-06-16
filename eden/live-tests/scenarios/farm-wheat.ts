// Scenario 3 (run FIRST — lowest real-mineflayer risk) — farm_wheat.
//
// Real-mineflayer surface exercised: breaking crop blocks (≈ `mine-block` → bot.dig on a Vec3) and
// drop-pickup. This is the harness's end-to-end prover: it should reach a clean `admit` once P1/P2/Z hold.
// If it fails, the gap is in crop-block handling or drop-pickup, not the loop.

import { monotonicFactory } from 'ulid';

import type { Scenario } from '../harness';
import { litBox } from '../arenas';
import { chainStatus, hostErrors, inventoryCount, successfulRuns, deathsAmong } from '../checks';

const ulid = monotonicFactory();
const BOT = 'Firmin';
const HARVEST = /harvest|mine|wheat|crop|collect|recolt|bl[eé]|moisson/i;

export const farmWheat: Scenario = {
  name: 'farm-wheat',
  description: 'A farmer authors + runs a skill that breaks mature wheat until it holds 3 wheat.',
  roster: [{ name: BOT, role: 'farmer' }],
  arena: [
    ...litBox(),
    // A 3×3 farmland bed on the floor with mature wheat on top — 9 ready crops (≥ maxRetries harvests).
    'fill 1 198 1 3 198 3 minecraft:farmland',
    'fill 1 199 1 3 199 3 minecraft:wheat[age=7]',
  ],
  // `force-gamemode=false` (server.properties) means the bot keeps its PERSISTED gamemode — pin survival
  // explicitly so a villager that ever logged in creative still drops blocks when it mines (no drops in
  // creative → wheat never reaches 3 → spurious FAIL). The defense scenario pins survival for the same reason.
  prepare: () => [`gamemode survival ${BOT}`, `tp ${BOT} 0 199 0`, `clear ${BOT}`],
  tasks: [
    {
      id: ulid(),
      goal: 'Récolte du blé: écris (write_skill) une NOUVELLE compétence qui casse le blé mûr à proximité, puis exécute-la (run_skill) jusqu’à avoir au moins 3 wheat en inventaire.',
      assignee: BOT,
      successCriteria: 'Firmin possède au moins 3 wheat, obtenus par une compétence qu’il a écrite et exécutée.',
      check: { item: 'wheat', count: 3 },
      context:
        'Du blé mûr (minecraft:wheat[age=7]) pousse juste à côté de toi, sur de la terre labourée. Écris ta propre compétence avec write_skill (tu peux composer mine-block / collect-blocks), puis exécute-la pour casser le blé et ramasser les graines/épis.',
      maxRetries: 5,
    },
  ],
  timeoutMs: 300_000,
  assert: async ({ host, rcon, outcomes, log }) => {
    const rolloutId = outcomes[0]?.result?.rolloutId;
    const wheat = await inventoryCount(rcon, BOT, 'wheat');
    const runs = successfulRuns(host);
    const harvestRuns = runs.filter((r) => HARVEST.test(r.skill));
    const errs = hostErrors(host);
    const deaths = deathsAmong(host, [BOT]);
    const chain = rolloutId ? chainStatus(host, rolloutId) : undefined;

    log(`wheat held=${wheat}; successful runs=[${runs.map((r) => r.skill).join(', ') || '(none)'}]; errors=${errs.length}`);

    const objective = wheat >= 3;
    const ranHarvest = harvestRuns.length > 0;
    const clean = errs.length === 0 && deaths.length === 0;
    const pass = objective && ranHarvest && clean;

    const lines = [
      `${objective ? '✓' : '✗'} objective: Firmin holds ${wheat}/3 wheat`,
      `${ranHarvest ? '✓' : '✗'} a harvesting skill.run{ok} exists (${harvestRuns.map((r) => r.skill).join(', ') || 'none'})`,
      `${clean ? '✓' : '✗'} resilience: ${errs.length} system.error, ${deaths.length} ${BOT} death(s)`,
      `${chain?.admit ? '★ bonus' : '·'} skill.admit ${chain?.admit ? 'captured' : 'not captured'}` +
        (chain ? ` (draft=${chain.draftByVillager} run=${chain.runOk} ticket=${chain.ticket} verdict=${chain.verdict}/${chain.verdictSuccess} admit=${chain.admit})` : ''),
    ];
    if (errs.length) lines.push(`  system.error: ${errs.slice(0, 3).join(' | ')}`);
    return { pass, report: lines.join('\n') };
  },
};
