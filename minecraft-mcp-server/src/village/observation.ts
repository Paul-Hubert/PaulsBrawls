import { describeEntity, inventorySummary } from './actions.js';
import { VillageContext } from './context.js';
import { currentSlotOf } from './day-planner.js';
import { Villager } from './villager.js';

/**
 * Self-relative world snapshot for one deliberation (VILLAGE_PLAN §D8).
 * Everything here is a free mineflayer read — no Java round-trip, no main
 * thread hop. The art is what's OMITTED: the JSON should stay ~2-3k tokens.
 */

const NEARBY_RADIUS = 24;
const MAX_INVENTORY_LINES = 20;
const MAX_ENTITIES_PER_BUCKET = 8;

export function buildObservation(villager: Villager, ctx: VillageContext): Record<string, unknown> {
  const bot = villager.bot();
  if (!bot) {
    return { connected: false, note: 'you are not in the world right now' };
  }

  const pos = bot.entity.position;

  const villagers: Array<Record<string, unknown>> = [];
  const players: Array<Record<string, unknown>> = [];
  const hostiles: Array<Record<string, unknown>> = [];
  let animals = 0;

  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity) continue;
    const distance = pos.distanceTo(entity.position);
    if (distance > NEARBY_RADIUS) continue;
    const info = describeEntity(bot, entity, ctx.villagerNames);
    const compact = {
      name: info.name,
      id: info.id,
      dist: Math.round(distance),
      pos: { x: Math.floor(info.position.x), y: Math.floor(info.position.y), z: Math.floor(info.position.z) },
    };
    if (info.kind === 'villager') {
      const other = ctx.villagers.get(info.name);
      const relation = villager.memory.relationWith(info.name);
      villagers.push({ ...compact, role: other?.roster.role, relation: relation.score });
    } else if (info.kind === 'player') {
      players.push(compact);
    } else if (info.kind === 'hostile') {
      hostiles.push(compact);
    } else if (info.kind === 'animal') {
      animals++;
    }
  }

  const inventory = inventorySummary(bot)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_INVENTORY_LINES);

  const timeOfDay = bot.time.timeOfDay;
  const phase = timeOfDay < 12_000 ? 'day' : timeOfDay < 13_500 ? 'dusk' : timeOfDay < 23_000 ? 'night' : 'dawn';

  const job = villager.routines.status();
  const plan = villager.memory.dayPlan();
  const slot = currentSlotOf(plan, Math.floor(timeOfDay));
  const needs = villager.memory.needs();

  return {
    you: {
      name: villager.name,
      role: villager.roster.role,
      position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      health: bot.health,
      food: bot.food,
      heldItem: bot.heldItem?.name ?? null,
      home: villager.homeAnchor(),
      workstation: villager.roster.workstation ?? null,
      chest: villager.chestAnchor(),
      mood: villager.memory.mood() || null,
      needs: { rest: Math.round(needs.rest * 100) / 100, social: Math.round(needs.social * 100) / 100 },
    },
    inventory,
    nearby: {
      villagers: villagers.slice(0, MAX_ENTITIES_PER_BUCKET),
      players: players.slice(0, MAX_ENTITIES_PER_BUCKET),
      hostiles: hostiles.slice(0, MAX_ENTITIES_PER_BUCKET),
      animals,
    },
    time: { timeOfDay: Math.floor(timeOfDay), phase },
    activeJob: job ? { name: job.name, runningForMin: Math.floor(job.runningForMs / 60_000) } : null,
    dayPlan: plan
      ? {
          source: plan.source,
          now: slot ? `${slot.activity} (until tick ${slot.to})` : null,
          slots: plan.slots.map((s) => `${s.from}-${s.to} ${s.activity}`),
        }
      : null,
    inConversationWith: ctx.conversations.get(villager.name)
      ? ctx.conversations.otherParty(ctx.conversations.get(villager.name)!, villager.name)
      : null,
  };
}
