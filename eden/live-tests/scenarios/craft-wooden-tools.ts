// Scenario 1 (run SECOND — likely surfaces the next real-mineflayer gap) — craft_wooden_tools.
//
// Real-mineflayer surface exercised: bot.recipesFor / bot.craft + crafting-table windows (the stock
// `craft-item` closes stray windows, pauses auto-eat, and waits on packet-level set_slot/window_items
// quiescence — all UNVALIDATED against real mineflayer). v1 hit the "open window hijacks every
// clickWindow" class of bug here (R1–R3). Capture any NEW gap the way the smoke captured P1/P2/Z.

import { monotonicFactory } from 'ulid';

import type { Scenario } from '../harness';
import { litBox } from '../arenas';
import { chainStatus, hostErrors, inventoryCount, successfulRuns, deathsAmong } from '../checks';

const ulid = monotonicFactory();
const BOT = 'Firmin';
const CRAFT = /craft|pickaxe|pioche|plank|planche|stick|b[aâ]ton|fabriqu/i;

export const craftWoodenTools: Scenario = {
  name: 'craft-wooden-tools',
  description: 'A crafter authors + runs a skill that harvests oak, makes planks→sticks, crafts a wooden_pickaxe on a table.',
  roster: [{ name: BOT, role: 'crafter' }],
  arena: [
    ...litBox(),
    // Oak as 3-tall COLUMNS (a 3×3×3 trunk = 27 logs) so ONE collect-blocks call yields a full column
    // (≥3 logs → ≥12 planks) — enough for a pickaxe in a single harvest, ≥ maxRetries over. A flat patch
    // gave only 1 log/call (gap E starved the chain). Plus a crafting table (a pickaxe is a 3×3 recipe).
    'fill 1 199 1 3 201 3 minecraft:oak_log',
    'setblock 5 199 0 minecraft:crafting_table',
  ],
  // Pin survival (force-gamemode=false → bot keeps its persisted gamemode): a creative bot mines oak with
  // no drops, starving the craft chain. Same guard the defense scenario applies to its guards.
  prepare: () => [`gamemode survival ${BOT}`, `tp ${BOT} 0 199 0`, `clear ${BOT}`],
  tasks: [
    {
      id: ulid(),
      goal: 'Fabrique une pioche en bois (wooden_pickaxe): écris (write_skill) une NOUVELLE compétence qui récolte du chêne, fabrique des planches puis des bâtons, et assemble la pioche sur l’établi; puis exécute-la.',
      assignee: BOT,
      successCriteria: 'Firmin possède une wooden_pickaxe, obtenue par une compétence qu’il a écrite.',
      check: { item: 'wooden_pickaxe', count: 1 },
      context:
        'Du chêne (oak_log) et un établi (crafting_table à 5,199,0) sont à portée. Écris ta propre compétence (write_skill) qui enchaîne récolte → planches → bâtons → pioche (tu peux composer collect-blocks et craft-item). IMPORTANT: après collect-blocks, vérifie que les bûches sont bien dans bot.inventory avant de fabriquer; les noms d’objets sont oak_log, oak_planks, stick, wooden_pickaxe. Puis exécute ta compétence.',
      maxRetries: 8,
    },
  ],
  timeoutMs: 360_000,
  assert: async ({ host, rcon, outcomes, log }) => {
    const rolloutId = outcomes[0]?.result?.rolloutId;
    const pickaxes = await inventoryCount(rcon, BOT, 'wooden_pickaxe');
    const runs = successfulRuns(host);
    const craftRuns = runs.filter((r) => CRAFT.test(r.skill));
    const errs = hostErrors(host);
    const deaths = deathsAmong(host, [BOT]);
    const chain = rolloutId ? chainStatus(host, rolloutId) : undefined;

    log(`wooden_pickaxe held=${pickaxes}; successful runs=[${runs.map((r) => r.skill).join(', ') || '(none)'}]; errors=${errs.length}`);

    const objective = pickaxes >= 1;
    const ranCraft = craftRuns.length > 0;
    const clean = errs.length === 0 && deaths.length === 0;
    const pass = objective && ranCraft && clean;

    const lines = [
      `${objective ? '✓' : '✗'} objective: Firmin holds ${pickaxes}× wooden_pickaxe`,
      `${ranCraft ? '✓' : '✗'} a crafting skill.run{ok} exists (${craftRuns.map((r) => r.skill).join(', ') || 'none'})`,
      `${clean ? '✓' : '✗'} resilience: ${errs.length} system.error, ${deaths.length} ${BOT} death(s)`,
      `${chain?.verdictSuccess ? '★ bonus' : '·'} god.verdict{success} ${chain?.verdictSuccess ? 'captured' : 'not captured'}; ` +
        `skill.admit ${chain?.admit ? 'captured' : 'not captured'}` +
        (chain ? ` (draft=${chain.draftByVillager} run=${chain.runOk} ticket=${chain.ticket} verdict=${chain.verdict} admit=${chain.admit})` : ''),
    ];
    if (errs.length) lines.push(`  system.error: ${errs.slice(0, 3).join(' | ')}`);
    return { pass, report: lines.join('\n') };
  },
};
