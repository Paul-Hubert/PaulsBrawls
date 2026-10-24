// Scenario — detect_and_defend. An ARCHER on a high spot + a SWORDSMAN on the ground learn to DETECT
// hostile mobs BEFORE they attack and kill them WITHOUT taking damage. The proactive-detection seam is the
// real one (M5): the signal adapter's bounded `bot.entities` poll fires `entity-spotted` when a hostile
// ENTERS perception (bots/signals.ts), the EventRouter normalizes it, and the archer/swordsman role-default
// reflexes (roles.json) escalate ONE interrupt-priority deliberation — the villager engages before a hit
// lands. The TASK drives the *learning*: each villager authors (write_skill) + runs a detect-and-engage
// skill, composing the seeded ranged primitive (shoot-mob) / melee (kill-mob), which God judges + admits.
//
// HANDS-OFF WORLD (operator-driven, by design — the user does the spatial setup). Unlike the other
// scenarios this arena does NOT fill terrain, force time/difficulty, or summon mobs. It only sets two
// non-destructive safety gamerules. After the bots connect + are equipped, a MANUAL-SETUP PAUSE
// (setupPauseMs, default 90 s — raise it with EDEN_LIVE_SETUP_PAUSE_MS) holds the run so the operator can:
//   1. build the small tower next to the archer and let it "find a high spot near itself" (find-high-spot),
//   2. place a zombie spawner within aggro range.
// REQUIREMENTS the operator owns (this scenario deliberately does NOT set them): difficulty ≥ easy (so the
// spawner spawns zombies that can fight) and darkness around the spawner (zombies need block-light 0 to
// spawn). Both villagers carry full iron armor + an iron sword + a bow + arrows.

import { monotonicFactory } from 'ulid';

import type { Scenario } from '../harness';
import type { Task } from '../../src/types/index';
import type { EdenHost } from '../../src/main';
import { combatRunners, deathsAmong, hostErrors, successfulRuns } from '../checks';

const ulid = monotonicFactory();

const ARCHER = 'Aldric';
const SWORDSMAN = 'Bertrand';
const BOTH = [ARCHER, SWORDSMAN] as const;

// Where to muster the bots after they connect. null = no teleport (they spawn at world spawn and the
// operator builds the tower + spawner around them). Set to absolute coords (e.g. { x: 0, y: 64, z: 0 }) to
// herd both bots to a known build site first — pick a spot you know is on solid ground (a bad tp drops them).
const MUSTER: { x: number; y: number; z: number } | null = null;

/** Full iron armor onto a bot's armor slots (item replace = deterministic, no pickup/equip race). */
function armorCommands(bot: string): string[] {
  return [
    `item replace entity ${bot} armor.head with minecraft:iron_helmet`,
    `item replace entity ${bot} armor.chest with minecraft:iron_chestplate`,
    `item replace entity ${bot} armor.legs with minecraft:iron_leggings`,
    `item replace entity ${bot} armor.feet with minecraft:iron_boots`,
  ];
}

/** survival + clear + full iron armor + iron sword + bow + a stack of arrows (both villagers carry both). */
function equip(bot: string): string[] {
  return [
    `gamemode survival ${bot}`,
    `clear ${bot}`,
    `give ${bot} minecraft:iron_sword`,
    `give ${bot} minecraft:bow`,
    `give ${bot} minecraft:arrow 64`,
    ...armorCommands(bot),
    ...(MUSTER ? [`tp ${bot} ${MUSTER.x} ${MUSTER.y} ${MUSTER.z}`] : []),
  ];
}

function archerTask(): Task {
  return {
    id: ulid(),
    goal:
      'Poste-toi en hauteur et défends la zone à distance. Trouve un point haut près de toi (run_skill find-high-spot) et grimpe dessus (go-to), puis écris (write_skill) une NOUVELLE compétence qui détecte les zombies hostiles à proximité et les abat à l’arc (compose shoot-mob) AVANT qu’ils ne t’atteignent, et exécute-la. Reste sur ta hauteur — ne subis aucun dégât.',
    assignee: ARCHER,
    successCriteria: 'Les zombies proches sont abattus à distance, Aldric tient son point haut et n’a subi aucun dégât.',
    context:
      'Tu portes une armure en fer, une épée en fer, un arc et des flèches. Une petite tour a été construite près de toi. Monte dessus et tire sur les zombies à l’arc depuis là — ils ne doivent jamais te toucher. shoot-mob(entityName:"zombie") tire jusqu’à la mort de la cible; find-high-spot trouve le sommet praticable le plus proche.',
    maxRetries: 4,
  };
}

function swordsmanTask(): Task {
  return {
    id: ulid(),
    goal:
      'Garde le sol et abats les zombies tôt. Écris (write_skill) une NOUVELLE compétence qui détecte le zombie hostile le plus proche et le tue (compose kill-mob; ou shoot-mob s’il est encore loin) AVANT qu’il ne te touche, puis exécute-la jusqu’à ce qu’il n’en reste plus à proximité — sans subir de dégât.',
    assignee: SWORDSMAN,
    successCriteria: 'Les zombies proches sont tués, Bertrand est en vie et n’a subi aucun dégât.',
    context:
      'Tu portes une armure en fer, une épée en fer, un arc et des flèches. Des zombies hostiles apparaissent à proximité (un générateur a été placé). Intercepte-les et tue-les avant qu’ils ne t’atteignent. kill-mob(entityName:"zombie") attaque au corps-à-corps; shoot-mob(entityName:"zombie") tire à l’arc pour les affaiblir de loin.',
    maxRetries: 4,
  };
}

// ── inline journal probes (this scenario's assertions read the journal directly, no checks.ts change) ──

/** Distinct villagers whose `entity-spotted` reflex FIRED — the proof proactive detection worked. */
function detectedBy(host: EdenHost, names: readonly string[]): string[] {
  const set = new Set(names);
  const out = new Set<string>();
  for (const e of host.journal.query({ kinds: ['subscription.fired'] })) {
    const p = e.payload as { villager: string; on: string };
    if (p.on === 'entity-spotted' && set.has(p.villager)) out.add(p.villager);
  }
  return [...out];
}

/** Whether ANY of our bots took damage: a `hurt` reflex fired/suppressed, a vitals snapshot below full
 *  health, or a death. The signal adapter synthesizes `hurt` on EVERY health decrease, so a fired/suppressed
 *  hurt subscription is the precise per-hit signal; vitals (every 10 s) + deaths backstop it. */
function damageEvidence(host: EdenHost, names: readonly string[]): string[] {
  const set = new Set(names);
  const ev: string[] = [];
  for (const e of host.journal.query({ kinds: ['subscription.fired', 'subscription.suppressed'] })) {
    const p = e.payload as { villager: string; on: string };
    if (p.on === 'hurt' && set.has(p.villager)) ev.push(`${p.villager}:hurt-reflex`);
  }
  for (const e of host.journal.query({ kinds: ['vitals'] })) {
    const p = e.payload as { name: string; health: number };
    if (set.has(p.name) && p.health < 20) ev.push(`${p.name}:hp=${p.health}`);
  }
  return ev;
}

export const detectAndDefend: Scenario = {
  name: 'detect-and-defend',
  description: 'An archer (on a tower) + a swordsman detect hostiles early and kill them — ideally taking no damage.',
  roster: [
    { name: ARCHER, role: 'archer' },
    { name: SWORDSMAN, role: 'swordsman' },
  ],
  // Hands-off world: ONLY two non-destructive safety gamerules (keep gear across iterations; never stick a
  // dead bot on the respawn screen). NO terrain fill, NO forced time/difficulty, NO summoned mobs — the
  // operator builds the tower + places the spawner during the setup pause and owns difficulty/darkness.
  arena: ['gamerule keepInventory true', 'gamerule doImmediateRespawn true'],
  requiredBots: [...BOTH],
  prepare: () => [...equip(ARCHER), ...equip(SWORDSMAN)],
  // The window for the operator to build the tower + place the spawner (raise with EDEN_LIVE_SETUP_PAUSE_MS).
  setupPauseMs: 90_000,
  tasks: [archerTask(), swordsmanTask()],
  timeoutMs: 480_000,
  assert: async ({ host, log }) => {
    const detected = detectedBy(host, BOTH);
    const fighters = combatRunners(host);
    const ranged = successfulRuns(host).filter((r) => /shoot|bow|arc|tir|rang/i.test(r.skill));
    const damage = damageEvidence(host, BOTH);
    const deaths = deathsAmong(host, [...BOTH]);
    const errs = hostErrors(host);
    const admits = host.journal.query({ kinds: ['skill.admit'] }).length;

    log(`detected=[${detected.join(', ') || 'none'}]; combat runners=[${fighters.join(', ') || 'none'}]; ranged runs=${ranged.length}; damage signals=${damage.length}; deaths=${deaths.length}; errors=${errs.length}`);

    const sawHostile = detected.length >= 1;
    const fought = fighters.length >= 1;
    const survived = deaths.length === 0;
    const noCrash = errs.length === 0;
    // Core PASS: detection fired, a combat skill ran, nobody died, no host crash. "No damage" + ranged kills
    // are the refinement targets this scenario hardens toward (docs/20) — reported, not gated, so a first
    // interactive run passes when the machinery works and the ✗ lines show what to tune next.
    const pass = sawHostile && fought && survived && noCrash;

    const usedRanged = ranged.length >= 1;
    const noDamage = damage.length === 0;
    const lines = [
      `${sawHostile ? '✓' : '✗'} proactive detection fired (entity-spotted) for [${detected.join(', ') || 'none'}]`,
      `${fought ? '✓' : '✗'} a combat skill.run{ok} exists (${fighters.join(', ') || 'none'})`,
      `${survived ? '✓' : '✗'} both villagers survived (${deaths.length} death(s): ${deaths.map((d) => d.name).join(', ') || 'none'})`,
      `${noCrash ? '✓' : '✗'} resilience: ${errs.length} system.error`,
      `${noDamage ? '★' : '·'} GOAL — no damage taken (${damage.length} damage signal(s)${damage.length ? ': ' + damage.slice(0, 4).join(', ') : ''})`,
      `${usedRanged ? '★' : '·'} archer engaged at range (${ranged.length} ranged run(s): ${ranged.map((r) => r.skill).slice(0, 3).join(', ') || 'none'})`,
      `${admits > 0 ? '★' : '·'} ${admits} skill.admit (a detect-and-engage skill was learned + admitted)`,
    ];
    if (errs.length) lines.push(`  system.error: ${errs.slice(0, 3).join(' | ')}`);
    return { pass, report: lines.join('\n') };
  },
};
