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

// D1: skill bodies are isolated JS strings the engine compiles one at a time — a TS helper isn't visible
// inside them, so this guard is INLINED (not exported, S3/S5) into each body that resolves an item id.
// Replaces the unguarded `bot.registry.itemsByName[name].id` that threw the cryptic "Cannot read properties
// of undefined (reading 'id')" on an unknown name; now the error NAMES the subject and the lookup path (S10).
const ITEM_ID_HELPER = `function itemId(bot, name) {
    const e = bot.registry && bot.registry.itemsByName ? bot.registry.itemsByName[name] : undefined;
    if (!e || e.id == null) throw new Error('unknown item "' + name + '" — not in bot.registry.itemsByName (D1)');
    return e.id;
  }`;

// D4: the SAFE-OPEN/SAFE-CLOSE discipline every stock skill that opens a container/crafting/furnace window
// must self-apply, so authored skills composing them inherit window safety (R1–R3). Live symptom (from the
// journal): `Error: Event windowOpen did not fire within timeout of 20000ms` — a previous window left open on
// `bot.currentWindow` makes the next openChest/openFurnace/table-open HANG or hijack. Same isolation rule as
// ITEM_ID_HELPER: skill bodies are separate JS strings the engine compiles one at a time, so a TS helper is
// out of scope inside them — these are INLINED (not exported, S3/S5) into each body that opens a window.
//   • safeCloseStray  — R1: if a stray window is open, close it BEFORE opening a new one, then let a
//                       macrotask settle so the close lands before the open (a hijack otherwise).
//   • pauseMutators   — R3: pause auto-eat + armor-manager (both auto-click mid-sequence and desync the
//                       window). GUARDED with `?.` so a fake/old plugin with no such API is a no-op, never a
//                       throw — the canonical bots/helpers.ts API (disableAuto/enableAuto, pause/resume).
//   • resumeMutators  — re-enable them; ALWAYS called from the caller's `finally` so an error/abort restores.
const CONTAINER_SAFE_HELPERS = `async function safeCloseStray(bot) {
    if (bot.currentWindow && bot.closeWindow) {
      bot.closeWindow(bot.currentWindow);
      await new Promise((r) => setTimeout(r, 0)); // let the close land before the next open (R1)
    }
  }
  function pauseMutators(bot) {
    bot.autoEat && bot.autoEat.disableAuto && bot.autoEat.disableAuto(); // R3
    bot.armorManager && bot.armorManager.pause && bot.armorManager.pause(); // R3
  }
  function resumeMutators(bot) {
    bot.armorManager && bot.armorManager.resume && bot.armorManager.resume();
    bot.autoEat && bot.autoEat.enableAuto && bot.autoEat.enableAuto();
  }`;

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

const FIND_BLOCK: StockSkill = {
  name: 'find-block',
  summary: 'trouver le bloc le plus proche par nom et renvoyer sa position (utilise bot.findBlock — PAS un scan manuel)',
  params: obj({ name: S, maxDistance: N }, ['name']),
  returns: obj({ x: N, y: N, z: N, name: S }),
  tier: 'mortal',
  exemplar: true,
  tags: ['search', 'collection'],
  // The reliable locate primitive: bot.findBlock scans the loaded world FOR you — by numeric id when the
  // registry knows it (far faster than a function matcher, the same path craft-item uses for the table),
  // else by name predicate. Compose it (find-block → collect-blocks / mine-block) INSTEAD of hand-rolling a
  // bot.blockAt(new Vec3(x+dx,y,z+dz)) grid scan: those step past columns, search one y-plane, depend on the
  // right origin, and flood the log on a miss (seen live: craft-wooden-tools scanned 28 k air blocks).
  code: `async function findBlock(bot, { name, maxDistance = 48 }, ctx) {
  const want = name.indexOf(':') >= 0 ? name.slice(name.indexOf(':') + 1) : name;
  const entry = bot.registry && bot.registry.blocksByName ? bot.registry.blocksByName[want] : null;
  const matching = entry && entry.id != null ? entry.id : (b) => b && b.name === want;
  const block = bot.findBlock({ matching, maxDistance });
  if (!block) throw new Error('aucun bloc "' + want + '" trouvé dans un rayon de ' + maxDistance + ' blocs');
  const p = block.position;
  return { x: p.x, y: p.y, z: p.z, name: block.name };
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
  // Gap E: bot.dig leaves the drops on the ground and mineflayer auto-collects only within ~1 block, but
  // the bot digs from up to its reach — so the logs land out of pickup range. Walk onto the trunk base
  // (the drops fall there) to gather them; best-effort so a NoPath never fails the harvest.
  if (collected > 0 && bot.pathfinder && bot.pathfinder.goto && ctx.goals) {
    await bot.pathfinder.goto(new ctx.goals.GoalNear(x, y, z, 1)).catch((e) => ctx.log('pickup walk skipped: ' + e.message));
    await new Promise((resolve) => setTimeout(resolve, 300));
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
  // Gap C: mineflayer's recipesFor wants the NUMERIC item id (NOT the name), and 3×3 recipes also need
  // the crafting-table BLOCK in reach — passing the name returns nothing ("no recipe for X"). Locate the
  // table, walk to it if needed, and pass both the id and the table.
  code: `async function craftItem(bot, { item, count = 1 }, ctx) {
  ${ITEM_ID_HELPER}
  ${CONTAINER_SAFE_HELPERS}
  await safeCloseStray(bot); // R1: a stray window hijacks the table open + every craft click (D4)
  pauseMutators(bot); // R3
  try {
    const id = itemId(bot, item);
    let table = bot.findBlock ? bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 24 }) : null;
    const p = bot.entity.position;
    if (table && Math.hypot(p.x - table.position.x, p.y - table.position.y, p.z - table.position.z) > 3) {
      await ctx.skills.run('go-to', { x: table.position.x, y: table.position.y, z: table.position.z, range: 2 });
    }
    const recipe = bot.recipesFor(id, null, 1, table || null)[0];
    if (!recipe) throw new Error('pas de recette pour ' + item + (table ? '' : ' (aucun établi à portée pour une recette 3×3)'));
    await bot.craft(recipe, count, table || undefined);
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
    await safeCloseStray(bot); // D4: never leak the table window open on any exit (success/error/abort, R4–R5)
    resumeMutators(bot);
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
  // Composes go-to; closes any stray window first (R1/D4), pauses the autonomous mutators around the
  // window work (R3), and ALWAYS closes the chest on exit (R4–R5) so an error/abort never leaks it open.
  code: `async function useChest(bot, { x, y, z, deposit = [], withdraw = [] }, ctx) {
  ${ITEM_ID_HELPER}
  ${CONTAINER_SAFE_HELPERS}
  await ctx.skills.run('go-to', { x, y, z, range: 3 });
  const block = bot.blockAt(new ctx.Vec3(x, y, z));
  if (!block) throw new Error('no chest at ' + x + ',' + y + ',' + z + ' (gone or chunk unloaded)');
  await safeCloseStray(bot); // R1: a stray window makes openContainer hang ("windowOpen did not fire") or hijack (D4)
  pauseMutators(bot); // R3
  const chest = await bot.openContainer(block);
  try {
    for (const it of deposit) await chest.deposit(itemId(bot, it.name), null, it.count);
    for (const it of withdraw) await chest.withdraw(itemId(bot, it.name), null, it.count);
    return { ok: true };
  } finally {
    chest.close();
    resumeMutators(bot);
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
  // D4: a furnace is a window too — close any stray window first (R1: openFurnace otherwise hangs with
  // "windowOpen did not fire within 20000ms"), pause the autonomous mutators (R3), and ALWAYS close the
  // furnace on exit (R4–R5).
  code: `async function smeltItem(bot, { input, fuel, count = 1 }, ctx) {
  ${ITEM_ID_HELPER}
  ${CONTAINER_SAFE_HELPERS}
  const furnaceBlock = bot.findBlock({ matching: (b) => b.name === 'furnace', maxDistance: 16 });
  if (!furnaceBlock) throw new Error('no furnace within reach');
  await safeCloseStray(bot); // R1/D4
  pauseMutators(bot); // R3
  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    await furnace.putFuel(itemId(bot, fuel), null, 1);
    await furnace.putInput(itemId(bot, input), null, count);
    let smelted = 0;
    while (smelted < count) { await new Promise((r) => setTimeout(r, 1000)); ctx.log('smelting...'); smelted = furnace.outputItem() ? furnace.outputItem().count : smelted; }
    await furnace.takeOutput();
    return { smelted: count };
  } finally { furnace.close(); resumeMutators(bot); }
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
  ${ITEM_ID_HELPER}
  await bot.equip(itemId(bot, item), 'hand');
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

// ── Farming primitives — the confirmed-action pair villagers kept re-deriving wrong (R55). Tilling
//    and sowing are SERVER-confirmed: bot.activateBlock resolves when the use-item packet is SENT,
//    but the block flip (dirt→farmland, farmland→crop) only lands ~1+ tick later when the server's
//    block-update returns. A skill that reads bot.blockAt synchronously sees the STALE block and
//    false-reports "le labour n'a pas fonctionné" — even though the till succeeded. These primitives
//    do the wait correctly (poll until confirmed, or time out) so a villager composes a reliable
//    `till-block`/`sow-seed` instead of reinventing the race. Single-block grain, like mine-block.
const TILL_BLOCK: StockSkill = {
  name: 'till-block',
  summary:
    'labourer UN bloc (dirt/grass_block) en terre cultivée (farmland): équipe la houe, vise le bloc de SURFACE (air au-dessus), et ATTEND la confirmation du serveur',
  params: obj({ x: N, y: N, z: N }, ['x', 'y', 'z']),
  returns: obj({ tilled: { type: 'boolean' }, x: N, y: N, z: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'till'],
  // R55: NEVER trust bot.blockAt synchronously after activateBlock — poll until the server confirms.
  // Two Minecraft rules the live runs kept breaking: (1) the hoe only tills a block with AIR directly
  // above (vise la SURFACE, jamais un bloc enterré à waterY-1 sous la berge); (2) the use is one
  // right-click and is idempotent if the block is already farmland.
  code: `async function tillBlock(bot, { x, y, z }, ctx) {
  const pos = new ctx.Vec3(x, y, z);
  const target = bot.blockAt(pos);
  if (!target) throw new Error('aucun bloc à ' + x + ',' + y + ',' + z + ' (absent ou chunk non chargé)');
  if (target.name === 'farmland') return { tilled: true, x, y, z };
  if (target.name !== 'dirt' && target.name !== 'grass_block' && target.name !== 'dirt_path') {
    throw new Error('bloc non labourable: ' + target.name + ' (il faut dirt, grass_block ou dirt_path)');
  }
  const above = bot.blockAt(new ctx.Vec3(x, y + 1, z));
  if (above && above.name !== 'air' && above.name !== 'cave_air' && above.name !== 'void_air') {
    throw new Error('bloc couvert par ' + above.name + ' au-dessus — la houe ne laboure que la SURFACE (vise un bloc avec de l’air au-dessus, jamais un bloc enterré)');
  }
  const hoe = bot.inventory.items().find((i) => /_hoe$/.test(i.name));
  if (!hoe) throw new Error('pas de houe dans l’inventaire');
  await bot.equip(hoe, 'hand');
  const p = bot.entity.position;
  if (Math.hypot(p.x - x, p.y - y, p.z - z) > 3) await ctx.skills.run('go-to', { x, y, z, range: 2 });
  await bot.activateBlock(target);
  // The use-item packet is sent; wait for the server's block-update to flip dirt→farmland (R55).
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const now = bot.blockAt(pos);
    if (now && now.name === 'farmland') return { tilled: true, x, y, z };
  }
  const after = bot.blockAt(pos);
  throw new Error('labour non confirmé après 2 s (bloc: ' + (after ? after.name : 'absent') + ') — houe équipée, bloc à portée, air au-dessus ?');
}`,
};

const SOW_SEED: StockSkill = {
  name: 'sow-seed',
  summary:
    'semer une graine/un plant (wheat_seeds, carrot, potato, beetroot_seeds…) sur un bloc de farmland: équipe l’objet et ATTEND la confirmation que la culture a poussé',
  params: obj({ x: N, y: N, z: N, seed: S }, ['x', 'y', 'z', 'seed']),
  returns: obj({ sown: { type: 'boolean' }, crop: S, x: N, y: N, z: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'plant', 'sow'],
  // R55 (sibling of till-block): planting is also server-confirmed — the crop appears in the block
  // ABOVE the farmland one tick after activateBlock. A seed refuses to plant on untilled ground, so
  // till-block must run FIRST; then poll the block above until the crop exists.
  code: `async function sowSeed(bot, { x, y, z, seed }, ctx) {
  const pos = new ctx.Vec3(x, y, z);
  const ground = bot.blockAt(pos);
  if (!ground) throw new Error('aucun bloc à ' + x + ',' + y + ',' + z + ' (absent ou chunk non chargé)');
  if (ground.name !== 'farmland') throw new Error('sol non labouré (farmland requis, trouvé: ' + ground.name + ') — appelle d’abord till-block');
  const item = bot.inventory.items().find((i) => i.name === seed);
  if (!item) throw new Error('pas de "' + seed + '" dans l’inventaire');
  await bot.equip(item, 'hand');
  const p = bot.entity.position;
  if (Math.hypot(p.x - x, p.y - y, p.z - z) > 3) await ctx.skills.run('go-to', { x, y, z, range: 2 });
  await bot.activateBlock(ground);
  // The crop spawns in the block ABOVE the farmland — wait for the server to confirm it (R55).
  const cropPos = new ctx.Vec3(x, y + 1, z);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const c = bot.blockAt(cropPos);
    if (c && c.name !== 'air' && c.name !== 'cave_air') return { sown: true, crop: c.name, x, y, z };
  }
  throw new Error('plantation de "' + seed + '" non confirmée après 2 s (rien n’a poussé sur le farmland)');
}`,
};

// ── The bread economy — one canonical skill per ACTION, composed into pairs, then a single loop.
//    These REPLACE the sprawl of LLM-churn farming variants the live runs accreted (8+ "dirt near
//    water" finders, a dozen till-and-plant rows, half a dozen "deposit bread" wrappers — D-12's churn
//    failure mode made flesh). The dedup discipline: a find-skill returns {found,…} (NEVER throws — the
//    caller branches), an action-skill does ONE world effect, a pair composes find→act, and `tend-bread-farm`
//    sequences every pair in a loop. The atomic till/sow already exist as till-block/sow-seed (R55), so we
//    reuse them rather than mint near-duplicates — that is the whole point.

const FIND_TILL_SPOT: StockSkill = {
  name: 'find-till-spot',
  summary: 'trouver un bloc de terre (dirt/grass_block) labourable près de l’eau (sera hydraté), sol dégagé au-dessus',
  params: obj({ maxDistance: N }),
  returns: obj({ found: { type: 'boolean' }, x: N, y: N, z: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'search', 'till'],
  // Hydration rule: water within 4 blocks horizontally keeps farmland wet, at the farmland's level or one
  // below the water. bot.findBlock can't express "dirt NEXT TO water", so we locate the nearest water
  // (cheap, registry-indexed) then scan ONLY the small 9×9×2 hydration box around THAT water for a tillable
  // surface block — bounded + centred on a real hit, never the blind world grid scan find-block warns
  // against (the 28k-air-block flood). Returns {found:false} so the loop tills elsewhere instead of failing.
  code: `async function findTillSpot(bot, { maxDistance = 32 }, ctx) {
  const water = bot.findBlock ? bot.findBlock({ matching: (b) => b && b.name === 'water', maxDistance }) : null;
  if (!water) return { found: false, x: 0, y: 0, z: 0 };
  const w = water.position;
  const tillable = new Set(['dirt', 'grass_block', 'dirt_path']);
  const isOpen = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
  for (const dy of [0, -1]) {
    for (let r = 1; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // walk rings outward = nearest-first
          const x = w.x + dx, y = w.y + dy, z = w.z + dz;
          const here = bot.blockAt(new ctx.Vec3(x, y, z));
          if (!here || !tillable.has(here.name)) continue;
          if (!isOpen(bot.blockAt(new ctx.Vec3(x, y + 1, z)))) continue;
          return { found: true, x, y, z };
        }
      }
    }
  }
  return { found: false, x: 0, y: 0, z: 0 };
}`,
};

const TILL_SPOT_NEAR_WATER: StockSkill = {
  name: 'till-spot-near-water',
  summary: 'trouver une terre près de l’eau (find-till-spot) PUIS la labourer (till-block) — la paire composée',
  params: obj({ maxDistance: N }),
  returns: obj({ tilled: { type: 'boolean' }, x: N, y: N, z: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'till'],
  // The find→act pair for tilling. find-till-spot is a stock `active` skill, so it is composable here.
  code: `async function tillSpotNearWater(bot, { maxDistance = 32 }, ctx) {
  const spot = await ctx.skills.run('find-till-spot', { maxDistance });
  if (!spot.found) return { tilled: false, x: 0, y: 0, z: 0 };
  await ctx.skills.run('till-block', { x: spot.x, y: spot.y, z: spot.z });
  return { tilled: true, x: spot.x, y: spot.y, z: spot.z };
}`,
};

const FIND_HARVESTABLE_PLANT: StockSkill = {
  name: 'find-harvestable-plant',
  summary: 'trouver la culture MÛRE la plus proche (blé/carotte/pomme de terre/betterave) prête à récolter',
  params: obj({ crop: S, maxDistance: N }),
  returns: obj({ found: { type: 'boolean' }, x: N, y: N, z: N, crop: S }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'search', 'harvest'],
  // Age-bearing crops report fullness as block.metadata (wheat/carrots/potatoes max 7, beetroot max 3).
  // Real mineflayer carries it, so an immature seedling is skipped; a block with NO metadata on a known
  // crop name is treated as grown (covers servers/fakes that don't expose age). {found:false}, never throws.
  code: `async function findHarvestablePlant(bot, { crop, maxDistance = 32 }, ctx) {
  const MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
  const names = crop ? [crop] : Object.keys(MAX_AGE);
  const mature = (b) => {
    const max = MAX_AGE[b.name];
    if (max === undefined) return false;
    return typeof b.metadata === 'number' ? b.metadata >= max : true;
  };
  const block = bot.findBlock ? bot.findBlock({ matching: (b) => b && names.indexOf(b.name) >= 0 && mature(b), maxDistance }) : null;
  if (!block) return { found: false, x: 0, y: 0, z: 0, crop: '' };
  const p = block.position;
  return { found: true, x: p.x, y: p.y, z: p.z, crop: block.name };
}`,
};

const HARVEST_PLANT: StockSkill = {
  name: 'harvest-plant',
  summary: 'récolter UNE culture mûre à une position (s’approche puis casse le bloc; les graines/produits tombent au sol)',
  params: obj({ x: N, y: N, z: N }, ['x', 'y', 'z']),
  returns: obj({ harvested: { type: 'boolean' }, crop: S, x: N, y: N, z: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'harvest'],
  // The atomic harvest action (one crop). Unlike mine-block it refuses a non-crop block, so a mis-aimed
  // coordinate fails loud rather than smashing the field. Breaking the crop drops produce + seeds on the
  // ground — gather them with pickup-drops (mineflayer auto-collects only within ~1 block, gap E).
  code: `async function harvestPlant(bot, { x, y, z }, ctx) {
  const CROPS = new Set(['wheat', 'carrots', 'potatoes', 'beetroots']);
  const block = bot.blockAt(new ctx.Vec3(x, y, z));
  if (!block) throw new Error('aucune plante à ' + x + ',' + y + ',' + z + ' (absente ou chunk non chargé)');
  if (!CROPS.has(block.name)) throw new Error('bloc non récoltable: ' + block.name + ' (cultures: wheat/carrots/potatoes/beetroots)');
  const p = bot.entity.position;
  if (Math.hypot(p.x - x, p.y - y, p.z - z) > 3) await ctx.skills.run('go-to', { x, y, z, range: 2 });
  await bot.dig(block);
  return { harvested: true, crop: block.name, x, y, z };
}`,
};

const PICKUP_DROPS: StockSkill = {
  name: 'pickup-drops',
  summary: 'ramasser les objets tombés au sol à proximité (marche jusqu’à chacun; mineflayer les collecte automatiquement)',
  params: obj({ radius: N }),
  returns: obj({ picked: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'collection'],
  // Broken-crop produce lands as item ENTITIES; mineflayer auto-collects within ~1 block, so we just walk
  // onto each nearby drop (gap E, same fix collect-blocks applies to logs). Best-effort per drop — a NoPath
  // to one drop never fails the rest. Degrades to {picked:0} cleanly when there are no item entities.
  // NOTE: identify drops by name/displayName only — entity.objectType is deprecated in prismarine-entity
  // and reading it fires a console.trace per entity per call (flooded the host during bread runs).
  code: `async function pickupDrops(bot, { radius = 8 }, ctx) {
  const me = bot.entity && bot.entity.position;
  if (!me) return { picked: 0 };
  const drops = [];
  for (const e of (bot.entities ? Object.values(bot.entities) : [])) {
    if (!e || !e.position) continue;
    if (e.name !== 'item' && e.displayName !== 'Item') continue;
    if (Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z) <= radius) drops.push(e.position);
  }
  let picked = 0;
  for (const pos of drops) {
    try {
      await ctx.skills.run('go-to', { x: pos.x, y: pos.y, z: pos.z, range: 1 });
      await sleep(200);
      picked++;
    } catch (e) { ctx.log('drop ignoré: ' + e.message); }
  }
  return { picked };
}`,
};

const HARVEST_NEARBY_CROP: StockSkill = {
  name: 'harvest-nearby-crop',
  summary: 'trouver une culture mûre, la récolter, puis ramasser ce qui tombe — la paire récolte composée',
  params: obj({ crop: S, maxDistance: N }),
  returns: obj({ harvested: N, x: N, y: N, z: N, crop: S }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'harvest'],
  // The find→act pair for harvesting (+ the gather tail). NOTE the conditional arg build: passing an
  // absent optional as `crop: undefined` would FAIL the callee's arg validation (string expected), so we
  // only attach `crop` when it is truthy.
  code: `async function harvestNearbyCrop(bot, { crop, maxDistance = 32 }, ctx) {
  const findArgs = { maxDistance };
  if (crop) findArgs.crop = crop;
  const found = await ctx.skills.run('find-harvestable-plant', findArgs);
  if (!found.found) return { harvested: 0, x: 0, y: 0, z: 0, crop: '' };
  await ctx.skills.run('harvest-plant', { x: found.x, y: found.y, z: found.z });
  await ctx.skills.run('pickup-drops', { radius: 8 });
  return { harvested: 1, x: found.x, y: found.y, z: found.z, crop: found.crop };
}`,
};

const FIND_CRAFTING_TABLE: StockSkill = {
  name: 'find-crafting-table',
  summary: 'trouver l’établi (crafting_table) le plus proche et renvoyer sa position',
  params: obj({ maxDistance: N }),
  returns: obj({ found: { type: 'boolean' }, x: N, y: N, z: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['crafting', 'search'],
  code: `async function findCraftingTable(bot, { maxDistance = 32 }, ctx) {
  const t = bot.findBlock ? bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance }) : null;
  if (!t) return { found: false, x: 0, y: 0, z: 0 };
  const p = t.position;
  return { found: true, x: p.x, y: p.y, z: p.z };
}`,
};

const MAKE_BREAD: StockSkill = {
  name: 'make-bread',
  summary: 'cuire du pain (3 blé → 1 pain) à un établi proche — la paire établi+cuisson composée',
  params: obj({ count: N }),
  returns: obj({ crafted: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['crafting', 'farming'],
  // Bread is a 3-wide recipe → it needs a crafting TABLE in reach (a 2×2 inventory grid won't do).
  // Confirm one exists with a clear error first, then delegate to craft-item — which walks to the table
  // and applies the full R1–R3 window discipline. `count` is loaves: the caller sizes it from its wheat.
  code: `async function makeBread(bot, { count = 1 }, ctx) {
  const table = await ctx.skills.run('find-crafting-table', { maxDistance: 32 });
  if (!table.found) throw new Error('aucun établi (crafting_table) à proximité — impossible de cuire du pain');
  const res = await ctx.skills.run('craft-item', { item: 'bread', count });
  return { crafted: res.crafted };
}`,
};

const STORE_IN_CHEST: StockSkill = {
  name: 'store-in-chest',
  summary: 'déposer des objets dans un coffre — coordonnées fournies, sinon le coffre le plus proche est trouvé',
  params: obj({ items: { type: 'array' }, x: N, y: N, z: N }, ['items']),
  returns: obj({ stored: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['storage', 'farming'],
  // The "stash the harvest" action. When no x/y/z is given it locates the nearest chest/barrel itself,
  // then composes deposit (→ use-chest), inheriting the close-stray-window + close-on-exit safety (R1/R4–R5).
  code: `async function storeInChest(bot, { items, x, y, z }, ctx) {
  let cx = x, cy = y, cz = z;
  if (typeof cx !== 'number' || typeof cy !== 'number' || typeof cz !== 'number') {
    const chest = bot.findBlock ? bot.findBlock({ matching: (b) => b && (b.name === 'chest' || b.name === 'barrel'), maxDistance: 32 }) : null;
    if (!chest) throw new Error('aucun coffre à proximité où déposer ' + items.map((i) => i.name).join(', '));
    cx = chest.position.x; cy = chest.position.y; cz = chest.position.z;
  }
  await ctx.skills.run('deposit', { x: cx, y: cy, z: cz, items });
  return { stored: items.reduce((s, i) => s + (i.count || 0), 0) };
}`,
};

const TEND_BREAD_FARM: StockSkill = {
  name: 'tend-bread-farm',
  summary: 'la boucle complète du pain: récolter+replanter OU labourer+semer près de l’eau, cuire le pain quand le blé suffit, ranger les pains',
  params: obj({ cycles: N, seed: S, breadThreshold: N, chest: { type: 'object' } }),
  returns: obj({ harvested: N, planted: N, baked: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'crafting', 'loop'],
  // The whole economy as ONE loop calling every pair above. Each composed step is itself a journaled,
  // criticisable skill — this only sequences them. The per-cycle `sleep` paces the work AND keeps the
  // macrotask queue draining so the engine's wall-clock + stall supervisors stay live (gap W). `ctx.signal`
  // lets a God preempt / a stall abort exit the loop cleanly. Every fragile step (sow on un-tilled ground,
  // craft with no table, deposit with a full chest) is try/caught to a log so one bad cycle never kills the run.
  code: `async function tendBreadFarm(bot, { cycles = 6, seed = 'wheat_seeds', breadThreshold = 3, chest }, ctx) {
  const wheat = () => bot.inventory.items().filter((i) => i.name === 'wheat').reduce((s, i) => s + i.count, 0);
  const haveSeed = () => bot.inventory.items().some((i) => i.name === seed);
  let harvested = 0, planted = 0, baked = 0;
  for (let c = 0; c < cycles; c++) {
    if (ctx.signal.aborted) break;
    const reap = await ctx.skills.run('harvest-nearby-crop', { maxDistance: 32 });
    if (reap.harvested > 0) {
      harvested += reap.harvested;
      if (haveSeed()) {
        // The crop sat on farmland one block below it — replant there.
        try { await ctx.skills.run('sow-seed', { x: reap.x, y: reap.y - 1, z: reap.z, seed }); planted++; }
        catch (e) { ctx.log('replant ignoré: ' + e.message); }
      }
    } else {
      const tilled = await ctx.skills.run('till-spot-near-water', { maxDistance: 32 });
      if (tilled.tilled && haveSeed()) {
        try { await ctx.skills.run('sow-seed', { x: tilled.x, y: tilled.y, z: tilled.z, seed }); planted++; }
        catch (e) { ctx.log('semis ignoré: ' + e.message); }
      }
    }
    if (wheat() >= breadThreshold) {
      try {
        const made = await ctx.skills.run('make-bread', { count: Math.floor(wheat() / breadThreshold) });
        baked += made.crafted || 0;
        if (made.crafted > 0) await ctx.skills.run('store-in-chest', { items: [{ name: 'bread', count: made.crafted }], ...(chest || {}) });
      } catch (e) { ctx.log('cuisson/rangement ignoré: ' + e.message); }
    }
    await sleep(500);
  }
  return { harvested, planted, baked };
}`,
};

// ── Reflex stock skills — the zero-token handlers roles.json names (04 §Subscriptions). A seeded
//    on:'X' → { kind:'skill' } reflex runs one of these the instant the EventRouter normalizes the
//    signal, with NO LLM call. They degrade gracefully when their world precondition is absent (no
//    args, no hostile, no field) so a fired reflex always files a clean RunReport — never a host error.

const FLEE_TO_SAFETY: StockSkill = {
  name: 'flee-to-safety',
  summary: 'fuir le danger en marchant vers la maison (si connue) ou à l’écart',
  params: obj({ home: { type: 'object' }, distance: N }),
  returns: obj({ fled: { type: 'boolean' } }),
  tier: 'mortal',
  exemplar: false,
  tags: ['combat', 'movement', 'reflex'],
  // The everyone hurt→flee reflex. With no `home` anchor it just retreats `distance` blocks; composes
  // go-to so the hop-walk + reach handling (R7) come for free. Zero-token (run by the SubscriptionRouter).
  code: `async function fleeToSafety(bot, { home, distance = 12 }, ctx) {
  const p = bot.entity.position;
  const target = home && typeof home.x === 'number'
    ? { x: home.x, y: home.y, z: home.z }
    : { x: p.x - distance, y: p.y, z: p.z };
  await ctx.skills.run('go-to', { x: target.x, y: target.y, z: target.z, range: 2 });
  return { fled: true };
}`,
};

const DEFEND_SELF: StockSkill = {
  name: 'defend-self',
  summary: 'attaquer l’ennemi hostile le plus proche (le réflexe du garde quand il est touché)',
  params: obj({ maxDistance: N }),
  returns: obj({ defended: { type: 'boolean' } }),
  tier: 'mortal',
  exemplar: false,
  tags: ['combat', 'reflex'],
  // The GUARD hurt→fight reflex (D-15). Robust by design: it finds its OWN nearest hostile rather than
  // trusting $event.byEntity, then composes kill-mob. With no hostile in range (or no entities table on
  // the fake bot) it returns {defended:false} cleanly — a fired-but-no-target reflex is not a failure.
  code: `async function defendSelf(bot, { maxDistance = 16 }, ctx) {
  const HOSTILE = new Set(['zombie','zombie_villager','husk','drowned','skeleton','stray','creeper','spider','cave_spider','witch','pillager','vindicator','illusioner','ravager','slime','silverfish','phantom','zoglin','hoglin','piglin','piglin_brute']);
  const me = bot.entity && bot.entity.position;
  const ents = bot.entities ? Object.values(bot.entities) : [];
  let target = null, best = maxDistance;
  for (const e of ents) {
    if (!e || !e.name || !e.position || !HOSTILE.has(e.name)) continue;
    const dx = e.position.x - me.x, dy = e.position.y - me.y, dz = e.position.z - me.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d <= best) { best = d; target = e; }
  }
  if (!target) { ctx.log('defend-self: aucun ennemi à portée'); return { defended: false }; }
  await ctx.skills.run('kill-mob', { entityName: target.name, maxDistance });
  return { defended: true };
}`,
};

const GO_HOME: StockSkill = {
  name: 'go-home',
  summary: 'rentrer à la maison (l’ancre est passée en argument; sinon ne fait rien)',
  params: obj({ x: N, y: N, z: N, range: N }),
  returns: obj({ home: { type: 'boolean' } }),
  tier: 'mortal',
  exemplar: false,
  tags: ['movement', 'reflex'],
  // The everyone night-falls→go-home reflex. NOTE: the night-falls signal has no live emitter yet
  // (bots/signals.ts forwards only hurt/health/death), and the anchor→args substitution is NOT wired —
  // so today this runs only with explicit x/y/z (e.g. via run_skill) and no-ops cleanly when no anchor
  // is supplied (a villager with no home just stays put). Feed the home-anchor coords into the reflex
  // args when the time emitter lands.
  code: `async function goHome(bot, { x, y, z, range = 2 }, ctx) {
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    ctx.log('go-home: pas d’ancre maison fournie — rien à faire');
    return { home: false };
  }
  await ctx.skills.run('go-to', { x, y, z, range });
  return { home: true };
}`,
};

const HARVEST_FIELD: StockSkill = {
  name: 'harvest-field',
  summary: 'récolter le blé mûr à proximité (le réflexe du fermier à l’aube)',
  params: obj({ maxBlocks: N }),
  returns: obj({ harvested: N }),
  tier: 'mortal',
  exemplar: false,
  tags: ['farming', 'reflex'],
  // The farmer new-day→harvest-field reflex. Uses bot.findBlock to locate mature wheat nearest-first
  // (never a manual grid scan — R-find-block); no field → {harvested:0} cleanly.
  code: `async function harvestField(bot, { maxBlocks = 16 }, ctx) {
  let harvested = 0;
  for (let i = 0; i < maxBlocks; i++) {
    const wheat = bot.findBlock ? bot.findBlock({ matching: (b) => b && b.name === 'wheat', maxDistance: 16 }) : null;
    if (!wheat) break;
    try { await bot.dig(wheat); harvested++; }
    catch (e) { ctx.log('harvest-field: bloc non récoltable: ' + e.message); break; }
  }
  return { harvested };
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
  FIND_BLOCK,
  COLLECT_BLOCKS,
  CRAFT_ITEM,
  USE_CHEST,
  DEPOSIT,
  WITHDRAW,
  SMELT_ITEM,
  PLACE_ITEM,
  KILL_MOB,
  EXPLORE_UNTIL,
  // Farming primitives — confirmed till/sow (R55: wait for the server block-update, never read sync).
  TILL_BLOCK,
  SOW_SEED,
  // The bread economy — one canonical skill per action, composed into find→act pairs, then one loop.
  FIND_TILL_SPOT,
  TILL_SPOT_NEAR_WATER,
  FIND_HARVESTABLE_PLANT,
  HARVEST_PLANT,
  HARVEST_NEARBY_CROP,
  PICKUP_DROPS,
  FIND_CRAFTING_TABLE,
  MAKE_BREAD,
  STORE_IN_CHEST,
  TEND_BREAD_FARM,
  // Reflex stock skills (the zero-token handlers roles.json names — 04 §Subscriptions).
  FLEE_TO_SAFETY,
  DEFEND_SELF,
  GO_HOME,
  HARVEST_FIELD,
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
