// Scenario 2 (run LAST — the richest: pvp + reactivity + multi-villager) — cooperative_mob_defense.
//
// Real-mineflayer surface exercised: bot.pvp.attack (the stock `kill-mob` tick loop — UNVALIDATED real
// pvp targeting/range/swing), armor-manager auto-equip on pickup, and multi-villager scheduling under the
// LLM concurrency cap. Expect new gaps in pvp targeting / the combat tick / armor equip — capture them
// the way the smoke captured P1/P2/Z.
//
// COOPERATION DISPATCH — design choice (documented per the kickoff). The options were: (a) one task per
// villager, (b) an orchestrator directive `to:'all'`, (c) a seeded `on:'hurt'` reactivity subscription
// (M5). We use (a): inject ONE defense task per guard and run both rollouts CONCURRENTLY (the harness
// Promise.all's the tasks). It's the most deterministic — it guarantees both villagers deliberate without
// depending on the orchestrator's fan-out heuristics or a reactivity seam the coordinator doesn't wire at
// the harness level — and it directly produces the "≥2 distinct villagers ran a combat skill" signal the
// assertion needs. (b)/(c) remain natural follow-ups once the pvp surface itself is proven.

import { monotonicFactory } from 'ulid';

import type { Scenario } from '../harness';
import type { Task } from '../../src/types/index';
import { combatArena } from '../arenas';
import { combatRunners, deathsAmong, entitiesRemain, hostErrors } from '../checks';

const ulid = monotonicFactory();
const GUARDS = ['Firmin', 'Alban'] as const;
// Arena box volume (combatArena: -7..7 footprint, interior y201..203) — scope the zombie check here so
// pre-existing underground mobs don't read as "zombies remain".
const ZOMBIE_SELECTOR = '@e[type=minecraft:zombie,x=-7,y=200,z=-7,dx=14,dy=4,dz=14]';

function armorCommands(bot: string): string[] {
  return [
    `item replace entity ${bot} armor.head with minecraft:iron_helmet`,
    `item replace entity ${bot} armor.chest with minecraft:iron_chestplate`,
    `item replace entity ${bot} armor.legs with minecraft:iron_leggings`,
    `item replace entity ${bot} armor.feet with minecraft:iron_boots`,
  ];
}

function defenseTask(bot: string): Task {
  return {
    id: ulid(),
    goal: 'Défends l’arène: écris (write_skill) une NOUVELLE compétence qui attaque le zombie le plus proche jusqu’à ce qu’il n’en reste aucun, puis exécute-la. Reste en vie et coordonne-toi avec l’autre garde.',
    assignee: bot,
    successCriteria: 'Tous les zombies de l’arène sont morts et le garde est en vie.',
    context:
      'Des zombies hostiles sont dans l’arène avec toi. Tu portes une épée en fer et une armure en fer. Écris ta propre compétence (tu peux composer kill-mob: run_skill("kill-mob", {entityName:"zombie"})) qui cherche et tue les zombies à proximité, puis exécute-la jusqu’à ce qu’il n’en reste plus.',
    maxRetries: 4,
  };
}

export const cooperativeMobDefense: Scenario = {
  name: 'cooperative-mob-defense',
  description: 'Two armed guards each author + run a combat skill; together they clear 3 zombies and survive.',
  roster: [
    { name: GUARDS[0], role: 'guard' },
    { name: GUARDS[1], role: 'guard' },
  ],
  arena: combatArena(),
  requiredBots: [...GUARDS],
  prepare: () => [
    `gamemode survival ${GUARDS[0]}`,
    `gamemode survival ${GUARDS[1]}`,
    `tp ${GUARDS[0]} -2 201 0`,
    `tp ${GUARDS[1]} 2 201 0`,
    `clear ${GUARDS[0]}`,
    `clear ${GUARDS[1]}`,
    `give ${GUARDS[0]} minecraft:iron_sword`,
    `give ${GUARDS[1]} minecraft:iron_sword`,
    ...armorCommands(GUARDS[0]),
    ...armorCommands(GUARDS[1]),
    // Persistent so they don't despawn mid-run; spread so each guard has a nearby target.
    'summon minecraft:zombie 0 201 4 {PersistenceRequired:1b}',
    'summon minecraft:zombie 3 201 3 {PersistenceRequired:1b}',
    'summon minecraft:zombie -3 201 3 {PersistenceRequired:1b}',
  ],
  tasks: [defenseTask(GUARDS[0]), defenseTask(GUARDS[1])],
  timeoutMs: 360_000,
  assert: async ({ host, rcon, log }) => {
    const zombies = await entitiesRemain(rcon, ZOMBIE_SELECTOR);
    const deaths = deathsAmong(host, [...GUARDS]);
    const fighters = combatRunners(host);
    const errs = hostErrors(host);

    log(`zombies remain=${zombies.remain} (raw="${zombies.raw}"); combat runners=[${fighters.join(', ') || 'none'}]; deaths=${deaths.length}; errors=${errs.length}`);

    const allDead = !zombies.remain;
    const survived = deaths.length === 0;
    const cooperated = fighters.length >= 2;
    const noCrash = errs.length === 0;
    const pass = allDead && survived && cooperated && noCrash;

    const lines = [
      `${allDead ? '✓' : '✗'} all arena zombies dead (${zombies.raw})`,
      `${survived ? '✓' : '✗'} both guards survived (${deaths.length} death(s): ${deaths.map((d) => d.name).join(', ') || 'none'})`,
      `${cooperated ? '✓' : '✗'} ≥2 villagers ran a combat skill (${fighters.join(', ') || 'none'})`,
      `${noCrash ? '✓' : '✗'} resilience: ${errs.length} system.error`,
    ];
    if (errs.length) lines.push(`  system.error: ${errs.slice(0, 3).join(' | ')}`);
    return { pass, report: lines.join('\n') };
  },
};
