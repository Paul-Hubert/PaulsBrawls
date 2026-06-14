// Stock skills (layer 2) — Voyager's control primitives, reimplemented on the v1 hardening corpus
// (02 §Composition, §Tiers). They are ordinary library skills with author:'stock', seeded straight
// into `active` (curated review IS their probation, D-12). The ~6 flagged `exemplar:true` are the
// always-in-prompt teaching set — the model learns the dialect by reading working code every call.
//
// The code is JS the engine compiles like any skill: it receives ONLY (bot, args, ctx) — no wrapper
// API (owner #11). The hardening corpus therefore appears in two places by design (04): the TS
// helpers (bots/hardening, bots/helpers) used by the engine/pool, AND hand-rolled inline here so a
// villager can read and compose it. They are validated against FakeBot in CI (no Minecraft); exact
// real-mineflayer surfaces (pathfinder Goal classes, furnace/anvil windows) are a smoke-time concern,
// consistent with M1's deferral of land-bot Movements tuning.

import type { JsonSchema, Tier } from '../../types/index';
import type { SkillLibrary } from '../library';

/** A bundled stock skill: a manifest-shaped header plus its JS body. */
export interface StockSkill {
  name: string;
  summary: string;
  params: JsonSchema;
  returns: JsonSchema;
  tier: Tier;
  exemplar: boolean;
  tags: string[];
  code: string;
}

const obj = (props: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties: props,
  required,
});
const N: JsonSchema = { type: 'number' };
const S: JsonSchema = { type: 'string' };

// ── Mortal stock primitives ─────────────────────────────────────────────────
const GO_TO: StockSkill = {
  name: 'go-to',
  summary: 'aller à une position en marchant par sauts (≤40 blocs)',
  params: obj({ x: N, y: N, z: N, range: N }, ['x', 'y', 'z']),
  returns: obj({ arrived: { type: 'boolean' } }),
  tier: 'mortal',
  exemplar: true,
  tags: ['movement'],
  // R7: walk far/unloaded goals in ≤40-block legs; recompute from the live position each hop.
  code: `async function goTo(bot, { x, y, z, range = 1 }, ctx) {
  const MAX_HOP = 40;
  for (let guard = 0; guard < 1024; guard++) {
    const p = bot.entity.position;
    const dx = x - p.x, dy = y - p.y, dz = z - p.z;
    const remaining = Math.hypot(dx, dy, dz);
    if (remaining <= MAX_HOP) break;
    const t = MAX_HOP / remaining;
    await bot.pathfinder.goto(new ctx.goals.GoalNear(p.x + dx * t, p.y + dy * t, p.z + dz * t, 2));
    ctx.log('hop toward ' + x + ',' + y + ',' + z);
  }
  await bot.pathfinder.goto(new ctx.goals.GoalNear(x, y, z, range));
  return { arrived: true };
}`,
};

const MINE_BLOCK: StockSkill = {
  name: 'mine-block',
  summary: 'casser un bloc à une position',
  params: obj({ x: N, y: N, z: N }, ['x', 'y', 'z']),
  returns: obj({ mined: S }),
  tier: 'mortal',
  exemplar: true,
  tags: ['mining'],
  code: `async function mineBlock(bot, { x, y, z }, ctx) {
  const block = bot.blockAt(new ctx.Vec3(x, y, z));
  if (!block) throw new Error('no block at ' + x + ',' + y + ',' + z + ' (absent or chunk unloaded)');
  await bot.dig(block);
  return { mined: block.name };
}`,
};

const COLLECT_BLOCKS: StockSkill = {
  name: 'collect-blocks',
  summary: 'récolter un tronc d’arbre (colonne reliée au sol, sans toucher les bûches flottantes)',
  params: obj({ x: N, y: N, z: N, maxHeight: N }, ['x', 'y', 'z']),
  returns: obj({ collected: N }),
  tier: 'mortal',
  exemplar: true,
  tags: ['collection', 'wood'],
  // R10: trunk logs only (column connected to ground), one dig per call, skip-on-failure — never
  // chase floating leaf-logs (bulk collect dies mid-list on them).
  code: `async function collectBlocks(bot, { x, y, z, maxHeight = 32 }, ctx) {
  const isLog = (n) => /(_log|_wood|_stem|_hyphae)$/.test(n);
  let collected = 0;
  for (let dy = 0; dy < maxHeight; dy++) {
    const block = bot.blockAt(new ctx.Vec3(x, y + dy, z));
    if (!block || !isLog(block.name)) break;
    try { await bot.dig(block); collected++; }
    catch (e) { ctx.log('skip undiggable log: ' + e.message); }
  }
  return { collected };
}`,
};

const CRAFT_ITEM: StockSkill = {
  name: 'craft-item',
  summary: 'fabriquer un objet en quiétant les fenêtres et mutateurs (R1–R3)',
  params: obj({ item: S, count: N }, ['item']),
  returns: obj({ crafted: N }),
  tier: 'mortal',
  exemplar: true,
  tags: ['crafting'],
  // R1: close any stray window (clickWindow routes to bot.currentWindow regardless of intent).
  // R3: pause auto-eat AND armor-manager (both corrupt a multi-click sequence).
  // R2: trust packet quiescence (set_slot/window_items), NOT the resolved promise.
  code: `async function craftItem(bot, { item, count = 1 }, ctx) {
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  bot.autoEat.disableAuto();
  if (bot.armorManager && bot.armorManager.pause) bot.armorManager.pause();
  try {
    const recipe = bot.recipesFor(item)[0];
    if (!recipe) throw new Error('no recipe for ' + item);
    await bot.craft(recipe, count);
    await new Promise((resolve) => {
      let timer;
      const onPacket = () => { clearTimeout(timer); arm(); };
      const cleanup = () => { bot._client.removeListener('set_slot', onPacket); bot._client.removeListener('window_items', onPacket); };
      function arm() { timer = setTimeout(() => { cleanup(); resolve(); }, 80); }
      bot._client.on('set_slot', onPacket);
      bot._client.on('window_items', onPacket);
      arm();
    });
    return { crafted: count };
  } finally {
    if (bot.armorManager && bot.armorManager.resume) bot.armorManager.resume();
    bot.autoEat.enableAuto();
  }
}`,
};

const USE_CHEST: StockSkill = {
  name: 'use-chest',
  summary: 'aller à un coffre, déposer/retirer des objets, toujours le refermer',
  params: obj({ x: N, y: N, z: N, deposit: { type: 'array' }, withdraw: { type: 'array' } }, ['x', 'y', 'z']),
  returns: obj({ ok: { type: 'boolean' } }),
  tier: 'mortal',
  exemplar: true,
  tags: ['storage'],
  // Composes go-to; pauses the autonomous mutators around the window work (R3).
  code: `async function useChest(bot, { x, y, z, deposit = [], withdraw = [] }, ctx) {
  await ctx.skills.run('go-to', { x, y, z, range: 3 });
  const block = bot.blockAt(new ctx.Vec3(x, y, z));
  if (!block) throw new Error('no chest at ' + x + ',' + y + ',' + z + ' (gone or chunk unloaded)');
  bot.autoEat.disableAuto();
  if (bot.armorManager && bot.armorManager.pause) bot.armorManager.pause();
  const chest = await bot.openContainer(block);
  try {
    for (const it of deposit) await chest.deposit(bot.registry.itemsByName[it.name].id, null, it.count);
    for (const it of withdraw) await chest.withdraw(bot.registry.itemsByName[it.name].id, null, it.count);
    return { ok: true };
  } finally {
    chest.close();
    if (bot.armorManager && bot.armorManager.resume) bot.armorManager.resume();
    bot.autoEat.enableAuto();
  }
}`,
};

const DEPOSIT: StockSkill = {
  name: 'deposit',
  summary: 'déposer des objets dans un coffre (compose use-chest)',
  params: obj({ x: N, y: N, z: N, items: { type: 'array' } }, ['x', 'y', 'z', 'items']),
  returns: obj({ deposited: N }),
  tier: 'mortal',
  exemplar: true,
  tags: ['storage'],
  code: `async function deposit(bot, { x, y, z, items }, ctx) {
  await ctx.skills.run('use-chest', { x, y, z, deposit: items });
  return { deposited: items.length };
}`,
};

const WITHDRAW: StockSkill = {
  name: 'withdraw',
  summary: 'retirer des objets d’un coffre (compose use-chest)',
  params: obj({ x: N, y: N, z: N, items: { type: 'array' } }, ['x', 'y', 'z', 'items']),
  returns: obj({ withdrawn: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['storage'],
  code: `async function withdraw(bot, { x, y, z, items }, ctx) {
  await ctx.skills.run('use-chest', { x, y, z, withdraw: items });
  return { withdrawn: items.length };
}`,
};

const SMELT_ITEM: StockSkill = {
  name: 'smelt-item',
  summary: 'cuire un objet dans un four (fuel + entrée, attendre la sortie)',
  params: obj({ input: S, fuel: S, count: N }, ['input', 'fuel']),
  returns: obj({ smelted: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['smelting'],
  // Not run on FakeBot (no furnace window seam); body kept real for the smoke + as a reading example.
  code: `async function smeltItem(bot, { input, fuel, count = 1 }, ctx) {
  const furnaceBlock = bot.findBlock({ matching: (b) => b.name === 'furnace', maxDistance: 16 });
  if (!furnaceBlock) throw new Error('no furnace within reach');
  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    await furnace.putFuel(bot.registry.itemsByName[fuel].id, null, 1);
    await furnace.putInput(bot.registry.itemsByName[input].id, null, count);
    let smelted = 0;
    while (smelted < count) { await new Promise((r) => setTimeout(r, 1000)); ctx.log('smelting...'); smelted = furnace.outputItem() ? furnace.outputItem().count : smelted; }
    await furnace.takeOutput();
    return { smelted: count };
  } finally { furnace.close(); }
}`,
};

const PLACE_ITEM: StockSkill = {
  name: 'place-item',
  summary: 'placer un bloc contre un bloc de référence',
  params: obj({ item: S, x: N, y: N, z: N, faceX: N, faceY: N, faceZ: N }, ['item', 'x', 'y', 'z']),
  returns: obj({ placed: { type: 'boolean' } }),
  tier: 'mortal',
  exemplar: false,
  tags: ['building'],
  code: `async function placeItem(bot, { item, x, y, z, faceX = 0, faceY = 1, faceZ = 0 }, ctx) {
  await bot.equip(bot.registry.itemsByName[item].id, 'hand');
  const ref = bot.blockAt(new ctx.Vec3(x, y, z));
  if (!ref) throw new Error('no reference block at ' + x + ',' + y + ',' + z);
  await bot.placeBlock(ref, new ctx.Vec3(faceX, faceY, faceZ));
  return { placed: true };
}`,
};

const KILL_MOB: StockSkill = {
  name: 'kill-mob',
  summary: 'attaquer une entité jusqu’à sa mort (via pvp)',
  params: obj({ entityName: S, maxDistance: N }, ['entityName']),
  returns: obj({ killed: { type: 'boolean' } }),
  tier: 'mortal',
  exemplar: false,
  tags: ['combat'],
  code: `async function killMob(bot, { entityName, maxDistance = 16 }, ctx) {
  const target = Object.values(bot.entities).find((e) => e && e.name === entityName && bot.entity.position.distanceTo(e.position) <= maxDistance);
  if (!target) throw new Error('no ' + entityName + ' within ' + maxDistance);
  await bot.pvp.attack(target);
  while (target.isValid) { await new Promise((r) => setTimeout(r, 250)); }
  return { killed: true };
}`,
};

const EXPLORE_UNTIL: StockSkill = {
  name: 'explore-until',
  summary: 'explorer par sauts jusqu’à trouver un bloc cible ou épuiser le budget',
  params: obj({ target: S, maxHops: N }, ['target']),
  returns: obj({ found: { type: 'boolean' }, x: N, y: N, z: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['exploration'],
  code: `async function exploreUntil(bot, { target, maxHops = 8 }, ctx) {
  for (let hop = 0; hop < maxHops; hop++) {
    const found = bot.findBlock({ matching: (b) => b.name === target, maxDistance: 48 });
    if (found) return { found: true, x: found.position.x, y: found.position.y, z: found.position.z };
    const p = bot.entity.position;
    await ctx.skills.run('go-to', { x: p.x + 32, y: p.y, z: p.z, range: 3 });
    ctx.log('explored hop ' + hop);
  }
  return { found: false, x: 0, y: 0, z: 0 };
}`,
};

// ── Divine stock (God-prompt-only; tier-filtered out of every villager prompt, 02 §Tiers) ────
const divine = (
  name: string,
  summary: string,
  params: JsonSchema,
  returns: JsonSchema,
  tags: string[],
  code: string,
): StockSkill => ({ name, summary, params, returns, tier: 'divine', exemplar: false, tags, code });

const DIVINE: StockSkill[] = [
  divine('appear-near', 'téléporter l’avatar près d’un villageois', obj({ villager: S }, ['villager']), obj({ ok: { type: 'boolean' } }), ['body'],
    `async function appearNear(bot, { villager }, ctx) { bot.chat('/tp ' + bot.username + ' ' + villager); return { ok: true }; }`),
  divine('vanish', 'renvoyer l’avatar à son point de stationnement', obj({ x: N, y: N, z: N }), obj({ ok: { type: 'boolean' } }), ['body'],
    `async function vanish(bot, { x = 0, y = 200, z = 0 }, ctx) { bot.chat('/tp ' + bot.username + ' ' + x + ' ' + y + ' ' + z); return { ok: true }; }`),
  divine('gesture', 'jouer un geste corporel (swing/jump/sneak/nod)', obj({ type: S }, ['type']), obj({ ok: { type: 'boolean' } }), ['body'],
    `async function gesture(bot, { type }, ctx) { if (type === 'swing') bot.swingArm(); else if (type === 'jump') { bot.setControlState('jump', true); await new Promise((r) => setTimeout(r, 200)); bot.setControlState('jump', false); } return { ok: true }; }`),
  divine('fly-to', 'voler (mode créatif) vers une position', obj({ x: N, y: N, z: N }, ['x', 'y', 'z']), obj({ arrived: { type: 'boolean' } }), ['movement'],
    `async function flyTo(bot, { x, y, z }, ctx) { await bot.creative.flyTo(new ctx.Vec3(x, y, z)); return { arrived: true }; }`),
  divine('summon-creature', 'invoquer une créature', obj({ entity: S, x: N, y: N, z: N, count: N }, ['entity', 'x', 'y', 'z']), obj({ summoned: N }), ['spawn'],
    `async function summonCreature(bot, { entity, x, y, z, count = 1 }, ctx) { for (let i = 0; i < count; i++) bot.chat('/summon ' + entity + ' ' + x + ' ' + y + ' ' + z); return { summoned: count }; }`),
  divine('smite', 'frapper une cible de la foudre', obj({ x: N, y: N, z: N }, ['x', 'y', 'z']), obj({ ok: { type: 'boolean' } }), ['punish'],
    `async function smite(bot, { x, y, z }, ctx) { bot.chat('/summon lightning_bolt ' + x + ' ' + y + ' ' + z); return { ok: true }; }`),
  divine('teleport-entity', 'téléporter une entité/joueur', obj({ target: S, x: N, y: N, z: N }, ['target', 'x', 'y', 'z']), obj({ ok: { type: 'boolean' } }), ['movement'],
    `async function teleportEntity(bot, { target, x, y, z }, ctx) { bot.chat('/tp ' + target + ' ' + x + ' ' + y + ' ' + z); return { ok: true }; }`),
  divine('give-items', 'donner des objets à un joueur/villageois', obj({ target: S, item: S, count: N }, ['target', 'item']), obj({ given: N }), ['reward'],
    `async function giveItems(bot, { target, item, count = 1 }, ctx) { bot.chat('/give ' + target + ' ' + item + ' ' + count); return { given: count }; }`),
  divine('set-weather', 'changer la météo', obj({ weather: S }, ['weather']), obj({ ok: { type: 'boolean' } }), ['world'],
    `async function setWeather(bot, { weather }, ctx) { bot.chat('/weather ' + weather); return { ok: true }; }`),
];

/** Every bundled stock skill — mortal primitives + divine powers. */
export const STOCK_SKILLS: StockSkill[] = [
  GO_TO,
  MINE_BLOCK,
  COLLECT_BLOCKS,
  CRAFT_ITEM,
  USE_CHEST,
  DEPOSIT,
  WITHDRAW,
  SMELT_ITEM,
  PLACE_ITEM,
  KILL_MOB,
  EXPLORE_UNTIL,
  ...DIVINE,
];

/** Seed all stock skills into the library at `active` (idempotent-ish: re-seeding appends versions). */
export function seedStockSkills(library: SkillLibrary): void {
  for (const s of STOCK_SKILLS) {
    library.seedStock(
      {
        name: s.name,
        summary: s.summary,
        params: s.params,
        returns: s.returns,
        code: s.code,
        author: { kind: 'stock' },
        tier: s.tier,
        exemplar: s.exemplar,
        tags: s.tags,
      },
      'active',
    );
  }
}
