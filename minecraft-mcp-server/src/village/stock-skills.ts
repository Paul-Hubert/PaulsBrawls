import { SkillKind } from './types.js';

/**
 * Stock skills seeded into each villager's library on first boot
 * (VILLAGE_PLAN §4: "the village never *depends* on the LLM writing good
 * code, it just gets richer when it does").
 *
 * These are ordinary villager scripts — strings of the same dialect the bots
 * write — and they install through the full pipeline (typecheck vs API_DTS,
 * AST guards, register-mode run). If one of these fails to install, the
 * pipeline is broken, which makes them a free integration test at every boot.
 *
 * Two budgets shape every script here: reflex handlers race a 20 s wall clock
 * (a timeout is a strike, three strikes disable the skill), and routines hold
 * the per-bot action chain (a reflex preempts them via stopMoving(), which the
 * runtime treats as benign). Keep handlers short; let routines be interrupted.
 */

export interface StockSkill {
  name: string;
  kind: SkillKind;
  description: string;
  code: string;
}

const SELF_DEFENSE = `// Fight back, or run to the guards — the village's basic survival reflex.
// Order matters (learned the hard way): stopMoving() FIRST so a long walk in
// progress can't hold the action chain while we die; tell the guard BEFORE
// fleeing because tell() is instant and flee() might not finish.
bot.on('hurt', async (e) => {
  if (!e.attacker) { return; }
  const me = bot.self();
  if (e.attacker.kind === 'player' || e.attacker.kind === 'villager') {
    bot.think('someone (' + e.attacker.name + ') hit me on purpose?!', 'high');
    if (me.health <= 10) {
      // Don't stand there getting combo-killed while the brain wakes up.
      bot.stopMoving();
      try { await bot.flee(e.attacker.position, 10); }
      catch (err) { console.log('retreat interrupted: ' + err); }
    }
    return;
  }
  if (e.attacker.kind !== 'hostile') { return; }
  bot.stopMoving();
  const guards = bot.nearbyEntities(48).filter((x) => x.role === 'guard');
  try {
    if (guards.length > 0) {
      bot.tell(guards[0].name, 'Au secours ! Un ' + e.attacker.name + ' m\\'attaque pres de chez moi !');
      bot.say('A l\\'aide !');
      await bot.flee(e.attacker.position, 12);
      await bot.goTo(guards[0].position.x, guards[0].position.y, guards[0].position.z, 2);
    } else if (me.health > 12) {
      if (!me.heldItem || !me.heldItem.includes('sword')) {
        if (bot.inventory().some((i) => i.item.includes('sword'))) {
          try { await bot.equip('sword'); }
          catch (err) { console.log('equip failed: ' + err); }
        }
      }
      bot.attack(e.attacker.id);
      bot.remember('fought back against a ' + e.attacker.name);
    } else {
      await bot.flee(e.attacker.position, 20);
      bot.think('attacked by ' + e.attacker.name + ', low health (' + me.health + '), no guards around', 'high');
    }
  } catch (err) {
    console.log('escape interrupted: ' + err);
    bot.think('attacked and my escape was interrupted', 'high');
  }
});`;

const GUARD_RESPOND = `// Answer calls for help: drop everything, run over, deal with the threat.
// Villager tell()s and player chat both count — same response either way.
const HELP = /au secours|aide|help|attaque|monstre|zombie/i;
let responding = false;
const respond = async (from) => {
  if (responding) { return; }
  responding = true;
  try {
    bot.stopMoving();
    bot.say('J\\'arrive, ' + from + ' !');
    if (bot.inventory().some((i) => i.item.includes('sword'))) {
      try { await bot.equip('sword'); }
      catch (err) { console.log('equip failed: ' + err); }
    }
    const sender = bot.nearbyEntities(64).find((x) => x.name === from);
    if (sender) {
      try { await bot.goTo(sender.position.x, sender.position.y, sender.position.z, 3); }
      catch (err) { console.log('rescue path interrupted: ' + err); }
    }
    const hostile = bot.nearbyEntities(16).find((x) => x.kind === 'hostile');
    if (hostile) {
      bot.attack(hostile.id);
      bot.remember('defended ' + from + ' against a ' + hostile.name);
    } else {
      bot.think(from + ' called for help but I see no enemy near them', 'high');
    }
  } finally {
    responding = false;
  }
};
bot.on('message', async (e) => {
  if (HELP.test(e.text)) { await respond(e.from); }
});
bot.on('player-chat', async (e) => {
  if (HELP.test(e.text)) { await respond(e.from); }
});`;

const GUARD_WATCH = `// Engage hostiles that come too close, without waking the brain.
// Creepers are the exception: charging one with a sword levels the village —
// back off and warn instead.
bot.on('entity-spotted', async (e) => {
  if (e.entity.kind !== 'hostile') { return; }
  if (e.entity.distance > 14) { return; }
  if (e.entity.name === 'creeper') {
    bot.say('Un creeper ! Reculez !');
    try { await bot.flee(e.entity.position, 12); }
    catch (err) { console.log('creeper retreat interrupted: ' + err); }
    bot.remember('backed away from a creeper near the village');
    return;
  }
  if (bot.inventory().some((i) => i.item.includes('sword'))) {
    try { await bot.equip('sword'); }
    catch (err) { console.log('equip failed: ' + err); }
  }
  bot.attack(e.entity.id);
  bot.remember('intercepted a ' + e.entity.name + ' near the village');
});`;

const NIGHT_SHELTER = `// Civilians head home at dusk. stopMoving() first so a routine mid-walk
// can't hold the action chain (it gets a benign interruption, not a strike).
bot.on('night-falls', async (e) => {
  const me = bot.self();
  const dx = me.position.x - me.home.x;
  const dz = me.position.z - me.home.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  if (distance <= 3) { return; }
  bot.stopMoving();
  if (distance > 60) {
    // Too far to make it before the handler clock runs out — brain's problem.
    bot.think('night fell and home is ' + Math.round(distance) + ' blocks away — find shelter', 'high');
    return;
  }
  bot.say('La nuit tombe, je rentre.');
  try {
    await bot.goTo(me.home.x, me.home.y, me.home.z, 2);
    bot.remember('made it home for the night');
  } catch (err) { console.log('walk home interrupted: ' + err); }
});`;

const ON_DEATH = `// Wake the brain after a death so it can reflect and re-equip.
bot.on('died', (e) => {
  bot.remember('I died — whatever I was carrying dropped where I fell');
  bot.think('I just died and respawned — recover my gear if it is close, re-equip from my chest, then get back to work', 'low');
});`;

const FARM_LOOP = `// Harvest mature crops around the workstation, replant, bank the surplus.
const me = bot.self();
const base = me.workstation || me.home;
await bot.goTo(base.x, base.y, base.z, 3);
// Top up replanting stock from the chest so a bare field never stalls us.
for (const seed of ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds']) {
  if (!bot.inventory().some((i) => i.item === seed)) {
    try { await bot.withdraw(seed, 8); }
    catch (err) { console.log('no ' + seed + ' in chest'); }
  }
}
let idlePasses = 0;
let harvested = 0;
while (idlePasses < 3) {
  if (bot.timeOfDay() >= 12500) { break; } // dusk — bank and let night-shelter take over
  let workedThisPass = false;
  const crops = [];
  for (const cropName of ['wheat', 'carrots', 'potatoes', 'beetroots']) {
    for (const b of bot.nearbyBlocks(cropName, 16)) {
      if (b.mature) { crops.push(b); }
    }
  }
  for (const crop of crops) {
    try {
      await bot.goTo(crop.position.x, crop.position.y, crop.position.z, 1);
      await bot.dig(crop.position.x, crop.position.y, crop.position.z);
      harvested = harvested + 1;
      workedThisPass = true;
      let replant = 'wheat_seeds';
      if (crop.name === 'carrots') { replant = 'carrot'; }
      if (crop.name === 'potatoes') { replant = 'potato'; }
      if (crop.name === 'beetroots') { replant = 'beetroot_seeds'; }
      if (bot.inventory().some((i) => i.item === replant)) {
        try { await bot.place(replant, crop.position.x, crop.position.y, crop.position.z); }
        catch (err) { console.log('replant failed: ' + err); }
      }
    } catch (err) {
      console.log('harvest failed: ' + err);
    }
  }
  if (workedThisPass) { idlePasses = 0; } else { idlePasses = idlePasses + 1; }
  await sleep(20000);
}
// Bank the harvest; keep some food on hand (auto-eat feeds from inventory)
// and keep the seeds — they are tomorrow's planting stock.
for (const produce of ['wheat', 'beetroot']) {
  const entry = bot.inventory().find((i) => i.item === produce);
  if (entry && entry.count > 0) {
    try { await bot.deposit(produce, entry.count); }
    catch (err) { console.log('deposit ' + produce + ' failed: ' + err); }
  }
}
for (const food of ['carrot', 'potato']) {
  const entry = bot.inventory().find((i) => i.item === food);
  if (entry && entry.count > 12) {
    try { await bot.deposit(food, entry.count - 12); }
    catch (err) { console.log('deposit ' + food + ' failed: ' + err); }
  }
}
if (harvested === 0) {
  bot.remember('farm pass found nothing to harvest (no mature crops in reach)');
  await sleep(120000); // pace the retry so job-done does not spam the brain
} else {
  bot.remember('farm pass finished, harvested ' + harvested + ' crops, surplus banked');
}`;

const GATHER_LOOP = `// Bootstrap supplies for the village: wheat seeds (from grass) and wood.
// Everything lands in the shared chest — the farmer plants the seeds, the
// crafter turns the logs into tools.
const me = bot.self();
const base = me.workstation || me.home;
await bot.goTo(base.x, base.y, base.z, 3);
const seedCount = () => {
  const entry = bot.inventory().find((i) => i.item === 'wheat_seeds');
  return entry ? entry.count : 0;
};
let broken = 0;
let rounds = 0;
let moves = 0;
// Distinct spots scanned; see the wood-loop note — \`moves\` resets after a
// productive scan, so the barren-message count needs its own counter.
let areasSearched = 1;
const dirs = [{ x: 24, z: 0 }, { x: 0, z: 24 }, { x: -24, z: 0 }, { x: 0, z: -24 }];
while (seedCount() < 16 && rounds < 10) {
  rounds = rounds + 1;
  if (bot.timeOfDay() >= 12500) { break; } // dusk — bank what we have
  const grass = [];
  for (const name of ['short_grass', 'tall_grass']) {
    for (const b of bot.nearbyBlocks(name, 16)) { grass.push(b); }
  }
  if (grass.length === 0) {
    // Mowed this spot bare? Walk to fresh grass instead of giving up in place.
    if (moves >= dirs.length) {
      bot.remember('no grass in ' + areasSearched + ' areas around my workstation — more seeds will have to come from harvested wheat');
      break;
    }
    const here = bot.self().position;
    const d = dirs[moves];
    moves = moves + 1;
    // goTo throws ActionError on water/cliffs/no-progress — log and let the next
    // round try the next direction (moves already advanced), never abort.
    try { await bot.goTo(here.x + d.x, here.y, here.z + d.z, 6); areasSearched = areasSearched + 1; }
    catch (err) { console.log('relocation blocked: ' + err); }
    continue;
  }
  moves = 0;
  for (const tuft of grass) {
    if (seedCount() >= 16) { break; }
    try {
      await bot.dig(tuft.position.x, tuft.position.y, tuft.position.z);
      broken = broken + 1;
      // Walk over the spot so the dropped seeds get picked up.
      await bot.goTo(tuft.position.x, tuft.position.y, tuft.position.z, 1);
    } catch (err) {
      console.log('grass at (' + tuft.position.x + ',' + tuft.position.z + ') failed: ' + err);
    }
  }
  await sleep(2000);
}
const banked = seedCount();
if (banked > 0) {
  const farmer = bot.roster().find((x) => x.role === 'farmer' && x.online);
  try {
    await bot.deposit('wheat_seeds', banked);
    if (farmer) { bot.tell(farmer.name, 'J\\'ai mis ' + banked + ' graines de ble dans le coffre !'); }
  } catch (err) {
    console.log('deposit seeds failed: ' + err);
    // No chest yet? Hand the seeds straight to the farmer instead of hoarding
    // them — a two-bot village without infrastructure must not deadlock.
    if (farmer) {
      try {
        const given = await bot.give(farmer.name, 'wheat_seeds', banked);
        bot.tell(farmer.name, 'Pas de coffre — je t\\'ai donne ' + given + ' graines directement.');
      } catch (err2) { console.log('give seeds failed too: ' + err2); }
    } else {
      bot.remember('no chest and no farmer online — keeping ' + banked + ' wheat_seeds on me');
    }
  }
}
bot.remember('seed run done: broke ' + broken + ' grass, banked ' + banked + ' wheat_seeds');
// Now the wood — wood-loop collects logs, replants saplings and banks them.
await bot.invokeSkill('wood-loop');`;

const FARM_SETUP = `// Set up a farm from nothing: hoe, CHEST and seeds (self-crafted when the
// chest has none), find tillable ground next to water, till, plant. Ends by
// invoking farm-loop so anything already mature gets harvested the same day.
const me = bot.self();
const base = me.workstation || me.home;
await bot.goTo(base.x, base.y, base.z, 3);
// Wood helpers — craft() reports exactly what is missing when a step fails.
const planksOf = () => bot.inventory().filter((i) => i.item.includes('planks')).reduce((s, i) => s + i.count, 0);
const ensurePlanks = async (need) => {
  for (const wood of ['oak', 'spruce', 'birch', 'dark_oak', 'acacia', 'jungle', 'cherry']) {
    if (planksOf() >= need) { return; }
    if (bot.inventory().some((i) => i.item === wood + '_log')) {
      try { await bot.craft(wood + '_planks', need - planksOf()); }
      catch (err) { console.log('craft ' + wood + '_planks failed: ' + err); }
    }
  }
};
const ensureTable = async () => {
  if (bot.nearbyBlocks('crafting_table', 16).length > 0) { return; }
  await ensurePlanks(4);
  await bot.craft('crafting_table', 1);
  const spots = [
    { x: base.x + 1, z: base.z }, { x: base.x - 1, z: base.z },
    { x: base.x, z: base.z + 1 }, { x: base.x, z: base.z - 1 },
  ];
  for (const spot of spots) {
    try { await bot.place('crafting_table', spot.x, base.y, spot.z); break; }
    catch (err) { console.log('table spot blocked, trying the next one'); }
  }
};
// 1) A hoe — mine, the chest's, or self-crafted (2 logs are enough).
if (!bot.inventory().some((i) => i.item.includes('hoe'))) {
  for (const hoe of ['wooden_hoe', 'stone_hoe', 'iron_hoe']) {
    try {
      await bot.withdraw(hoe, 1);
      break;
    } catch (err) { console.log('no ' + hoe + ' in chest'); }
  }
}
if (!bot.inventory().some((i) => i.item.includes('hoe'))) {
  try {
    await ensurePlanks(8);
    await ensureTable();
    if (!bot.inventory().some((i) => i.item === 'stick')) { await bot.craft('stick', 4); }
    await bot.craft('wooden_hoe', 1);
    console.log('made my own wooden hoe');
  } catch (err) { console.log('could not craft a hoe myself: ' + err); }
}
// 1b) The village bank. Without a chest every deposit fails forever — and
// nobody should COORDINATE about a chest that does not exist; they should
// build it. deposit/withdraw auto-discover any chest placed near here.
if (bot.nearbyBlocks('chest', 16).length === 0) {
  try {
    await ensurePlanks(8);
    if (planksOf() >= 8) {
      await ensureTable();
      await bot.craft('chest', 1);
      const spots = [
        { x: base.x + 2, z: base.z }, { x: base.x - 2, z: base.z },
        { x: base.x, z: base.z + 2 }, { x: base.x, z: base.z - 2 },
      ];
      for (const spot of spots) {
        try { await bot.place('chest', spot.x, base.y, spot.z); break; }
        catch (err) { console.log('chest spot blocked, trying the next one'); }
      }
      if (bot.nearbyBlocks('chest', 8).length > 0) {
        bot.say('Le coffre du village est pose !');
        bot.remember('placed the village chest near my workstation — deposits work now');
      }
    } else {
      console.log('not enough wood for a chest yet (' + planksOf() + ' planks) — need logs');
    }
  } catch (err) { console.log('could not set up the chest: ' + err); }
}
if (!bot.inventory().some((i) => i.item.includes('hoe'))) {
  // Only ask a crafter who actually EXISTS in this village — waiting on a
  // role nobody holds is how a two-bot roster deadlocks.
  const crafter = bot.roster().find((x) => x.role === 'crafter' && x.online);
  if (crafter) { bot.tell(crafter.name, 'Il me faut une houe pour labourer — tu peux en mettre une dans le coffre ?'); }
  else { console.log('no crafter in this village — getting logs and crafting the hoe myself is the only path'); }
  bot.remember('cannot farm yet: no hoe in my inventory or the chest');
  bot.think('I need a hoe — get logs so I can craft one myself (planks + sticks + crafting table), or have someone bank one in the chest', 'low');
  await sleep(120000); // pace the retry so job-done does not spam the brain
} else {
  // 2) Seeds — the gatherer banks wheat_seeds in the shared chest.
  if (!bot.inventory().some((i) => i.item === 'wheat_seeds')) {
    try { await bot.withdraw('wheat_seeds', 16); }
    catch (err) { console.log('no wheat_seeds in chest'); }
  }
  if (!bot.inventory().some((i) => i.item === 'wheat_seeds')) {
    const gatherer = bot.roster().find((x) => x.role === 'gatherer' && x.online);
    if (gatherer) {
      bot.tell(gatherer.name, 'Le coffre est vide — il me faut des graines de ble pour planter ! Tu peux me les donner directement (give).');
      bot.think('no seeds available — the gatherer needs to bank or hand me some', 'low');
    } else {
      // Nobody gathers here — break grass myself rather than waiting forever.
      bot.remember('no gatherer in this village — getting seeds from grass myself');
      bot.think('no seeds and no gatherer exists — I must break grass for seeds myself, then till and plant', 'low');
    }
    bot.remember('cannot plant yet: no wheat_seeds in my inventory or the chest');
    await sleep(120000);
  } else {
    // 3) Ground — prefer the edge of water (farmland within 4 blocks stays wet).
    const water = bot.nearbyBlocks('water', 24);
    if (water.length > 0) {
      try { await bot.goTo(water[0].position.x, water[0].position.y + 1, water[0].position.z, 3); }
      catch (err) { console.log('cannot reach the water edge: ' + err); }
    }
    const spots = [];
    for (const ground of ['grass_block', 'dirt']) {
      for (const b of bot.nearbyBlocks(ground, 8)) {
        if (water.length === 0) {
          spots.push(b);
        } else if (
          b.position.y === water[0].position.y &&
          Math.abs(b.position.x - water[0].position.x) <= 4 &&
          Math.abs(b.position.z - water[0].position.z) <= 4
        ) {
          spots.push(b);
        }
      }
    }
    let planted = 0;
    for (const spot of spots) {
      if (planted >= 12) { break; }
      if (!bot.inventory().some((i) => i.item === 'wheat_seeds')) { break; }
      try {
        await bot.till(spot.position.x, spot.position.y, spot.position.z);
        await bot.place('wheat_seeds', spot.position.x, spot.position.y + 1, spot.position.z);
        planted = planted + 1;
      } catch (err) {
        console.log('spot (' + spot.position.x + ',' + spot.position.z + ') unusable: ' + err);
      }
    }
    if (planted > 0) {
      bot.say('Le champ est seme !');
      if (water.length > 0) {
        bot.remember('set up the farm: tilled and planted ' + planted + ' wheat next to water');
      } else {
        bot.remember('set up the farm: planted ' + planted + ' wheat but found NO water nearby — growth will be slow');
      }
    } else {
      bot.remember('found no tillable ground here');
      bot.think('I could not till anything around my workstation — scout a better spot for the farm', 'low');
      await sleep(60000);
    }
    // 4) Harvest whatever is already mature, bank the surplus.
    await bot.invokeSkill('farm-loop');
  }
}`;

const WOOD_LOOP = `// Collect logs, replant saplings, bank the wood. When nothing is reachable
// HERE, walk to a NEW area and retry — standing still next to a logged-out
// forest is how the village starves. ("move elsewhere and retry" is advice
// this script must act on itself, not advice for whoever reads the logs.)
const me = bot.self();
const base = me.workstation || me.home;
await bot.goTo(base.x, base.y, base.z, 3);
const logTypes = ['oak_log', 'birch_log', 'spruce_log'];
const dirs = [
  { x: 28, z: 0 }, { x: 0, z: 28 }, { x: -28, z: 0 }, { x: 0, z: -28 },
  { x: 20, z: 20 }, { x: -20, z: -20 },
];
let total = 0;
let moves = 0;
// Distinct spots scanned (the base plus every relocation we walked to). Tracked
// separately from \`moves\` because moves resets to 0 after any productive round,
// so it would understate the search in the mixed barren/productive case — and
// the final \`remember\` reports a count, which must stay truthful.
let areasSearched = 1;
let rounds = 0;
while (rounds < 10) {
  rounds = rounds + 1;
  if (bot.timeOfDay() >= 12500) { break; } // dusk — bank and head home
  let got = 0;
  for (const logType of logTypes) {
    try {
      const n = await bot.collect(logType, 4);
      got = got + n;
      if (got > 0) { break; }
    } catch (err) {
      console.log('no reachable ' + logType + ' here: ' + err);
    }
  }
  if (got === 0) {
    if (moves >= dirs.length) { break; } // searched all around — genuinely barren
    const here = bot.self().position;
    const d = dirs[moves];
    moves = moves + 1;
    console.log('no logs here — trying a new area toward (' + (here.x + d.x) + ',' + (here.z + d.z) + ')');
    // goTo throws ActionError on water/cliffs/no-progress — log and let the next
    // round try the next direction (moves already advanced), never abort.
    try { await bot.goTo(here.x + d.x, here.y, here.z + d.z, 6); areasSearched = areasSearched + 1; }
    catch (err) { console.log('relocation blocked: ' + err); }
    continue;
  }
  moves = 0;
  total = total + got;
  // Replant: drop a sapling on nearby open ground (best-effort).
  const sapling = bot.inventory().find((i) => i.item.includes('sapling'));
  if (sapling) {
    let planted = false;
    for (const ground of bot.nearbyBlocks('grass_block', 8).slice(0, 4)) {
      if (planted) { break; }
      try {
        await bot.place(sapling.item, ground.position.x, ground.position.y + 1, ground.position.z);
        planted = true;
      } catch (err) { console.log('sapling spot blocked, trying another'); }
    }
  }
  await sleep(3000);
}
let chestOk = true;
for (const logType of logTypes) {
  const entry = bot.inventory().find((i) => i.item === logType);
  if (!entry || entry.count === 0) { continue; }
  if (chestOk) {
    try { await bot.deposit(logType, entry.count); continue; }
    catch (err) { chestOk = false; console.log('deposit ' + logType + ' failed: ' + err); }
  }
  // No chest? Hand the wood to the farmer directly — they need it for tools.
  const farmer = bot.roster().find((x) => x.role === 'farmer' && x.online && x.name !== me.name);
  if (farmer) {
    try { await bot.give(farmer.name, logType, entry.count); }
    catch (err2) { console.log('give ' + logType + ' failed too: ' + err2); }
  }
}
if (total > 0) {
  bot.remember('woodcutting done, banked ' + total + ' logs');
} else {
  bot.remember('no reachable logs in ' + areasSearched + ' searched areas — this spot is logged out, the wood camp must move');
  await sleep(30000); // brief pace — the zero-progress wake-up tells the brain
}`;

const CRAFT_BATCH = `// Turn banked logs into planks, sticks and basic wooden tools.
const me = bot.self();
const base = me.workstation || me.home;
await bot.goTo(base.x, base.y, base.z, 3);
const woods = [
  { log: 'oak_log', planks: 'oak_planks' },
  { log: 'birch_log', planks: 'birch_planks' },
  { log: 'spruce_log', planks: 'spruce_planks' },
];
const countOf = (name) => {
  const entry = bot.inventory().find((i) => i.item === name);
  return entry ? entry.count : 0;
};
const planksTotal = () => bot.inventory().filter((i) => i.item.includes('planks')).reduce((sum, i) => sum + i.count, 0);
for (const wood of woods) {
  if (!bot.inventory().some((i) => i.item === wood.log)) {
    try { await bot.withdraw(wood.log, 16); }
    catch (err) { console.log('no ' + wood.log + ' in chest'); }
  }
  const logs = countOf(wood.log);
  if (logs > 0) {
    // craft's count is in OUTPUT items: 1 log yields 4 planks.
    try { await bot.craft(wood.planks, logs * 4); }
    catch (err) { console.log('craft ' + wood.planks + ' failed: ' + err); }
  }
}
if (planksTotal() >= 3) {
  // Tools need a crafting table — build and place one if the area lacks it.
  if (bot.nearbyBlocks('crafting_table', 16).length === 0 && planksTotal() >= 4) {
    try {
      await bot.craft('crafting_table', 1);
      const spots = [
        { x: base.x + 1, z: base.z }, { x: base.x - 1, z: base.z },
        { x: base.x, z: base.z + 1 }, { x: base.x, z: base.z - 1 },
      ];
      for (const spot of spots) {
        try {
          await bot.place('crafting_table', spot.x, base.y, spot.z);
          break;
        } catch (err) { console.log('table spot blocked, trying the next one'); }
      }
    } catch (err) { console.log('could not set up a crafting table: ' + err); }
  }
  if (countOf('stick') < 8) {
    // 12 sticks covers the five wooden tools below (2 each) with spare.
    try { await bot.craft('stick', 12); }
    catch (err) { console.log('craft sticks failed: ' + err); }
  }
  const made = [];
  // Swords first: every villager's self-defense reflex wants one to equip.
  for (const tool of ['wooden_sword', 'wooden_axe', 'wooden_pickaxe', 'wooden_hoe', 'wooden_shovel']) {
    if (planksTotal() >= 3 && countOf('stick') >= 2) {
      try {
        await bot.craft(tool, 1);
        made.push(tool);
      } catch (err) {
        console.log('craft ' + tool + ' failed: ' + err);
      }
    }
  }
  for (const tool of made) {
    try { await bot.deposit(tool, 1); }
    catch (err) { console.log('deposit ' + tool + ' failed: ' + err); }
  }
  for (const wood of woods) {
    const extra = countOf(wood.planks) - 8;
    if (extra > 0) {
      try { await bot.deposit(wood.planks, extra); }
      catch (err) { console.log('deposit ' + wood.planks + ' failed: ' + err); }
    }
  }
  const extraSticks = countOf('stick') - 8;
  if (extraSticks > 0) {
    try { await bot.deposit('stick', extraSticks); }
    catch (err) { console.log('deposit sticks failed: ' + err); }
  }
  if (made.length > 0) {
    bot.remember('crafted ' + made.join(', ') + ' plus planks and sticks, banked the surplus');
  } else {
    bot.remember('crafted planks and sticks, not enough material for tools');
  }
} else {
  bot.remember('no logs or planks available to craft with');
  await sleep(120000); // pace the retry so job-done does not spam the brain
}`;

const MINE_LOOP = `// Quarry stone and surface ores near the workstation, bank the haul.
// Stone drops nothing without a pickaxe — fetch one from the chest first.
const me = bot.self();
const base = me.workstation || me.home;
await bot.goTo(base.x, base.y, base.z, 3);
if (!bot.inventory().some((i) => i.item.includes('pickaxe'))) {
  for (const pick of ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']) {
    try {
      await bot.withdraw(pick, 1);
      break;
    } catch (err) { console.log('no ' + pick + ' in chest'); }
  }
}
if (!bot.inventory().some((i) => i.item.includes('pickaxe'))) {
  bot.remember('cannot mine: no pickaxe in my inventory or my chest');
  bot.think('I need a pickaxe to work — ask the crafter or trade for one', 'low');
  await sleep(120000); // pace the retry so job-done does not spam the brain
} else {
  let productiveRounds = 0;
  let rounds = 0;
  while (rounds < 6) {
    rounds = rounds + 1;
    let dugSomething = false;
    for (const target of ['coal_ore', 'iron_ore', 'stone']) {
      try {
        await bot.collect(target, 3);
        dugSomething = true;
      } catch (err) {
        console.log('no reachable ' + target + ': ' + err);
      }
    }
    if (!dugSomething) { break; }
    productiveRounds = productiveRounds + 1;
    await sleep(3000);
  }
  for (const haul of ['coal', 'raw_iron', 'cobblestone']) {
    const entry = bot.inventory().find((i) => i.item === haul);
    if (entry && entry.count > 0) {
      try { await bot.deposit(haul, entry.count); }
      catch (err) { console.log('deposit ' + haul + ' failed: ' + err); }
    }
  }
  if (productiveRounds > 0) {
    bot.remember('mining done after ' + productiveRounds + ' rounds, haul banked in my chest');
  } else {
    bot.remember('no stone or ore in reach of my workstation');
    await sleep(120000);
  }
}`;

const RESPOND_TO_EVERYONE = `// Wake up when a player calls "Everyone" / "Tout le monde" in public chat.
// The 30 s cooldown prevents repeated broadcasts from stacking deliberations.
// earshot filtering already happened in bot-host, so if this fires the player is nearby.
let lastEveryoneAt = 0;
bot.on('player-chat', (e) => {
  if (!/\\btout le monde\\b|\\beveryone\\b/i.test(e.text)) { return; }
  const now = Date.now();
  if (now - lastEveryoneAt < 30000) { return; }
  lastEveryoneAt = now;
  bot.think(e.from + ' s\\'adresse à tout le monde: "' + e.text + '"', 'low');
});`;

const GUARD_PATROL = `// Walk a loop between my post and my home so guard-watch spots trouble early.
// The goTo legs are deliberately NOT wrapped in try/catch: when a rescue
// reflex calls stopMoving() to grab the action chain, the benign interruption
// ends this patrol cleanly (no strike) instead of fighting the rescue for
// control of the pathfinder.
const me = bot.self();
const post = me.workstation || me.home;
if (bot.inventory().some((i) => i.item.includes('sword'))) {
  try { await bot.equip('sword'); }
  catch (err) { console.log('equip failed: ' + err); }
}
let rounds = 0;
while (rounds < 40) {
  rounds = rounds + 1;
  await bot.goTo(post.x, post.y, post.z, 2);
  await sleep(12000);
  await bot.goTo(me.home.x, me.home.y, me.home.z, 2);
  await sleep(12000);
}
bot.remember('patrol finished after ' + rounds + ' rounds, all quiet');`;

export const STOCK_SKILLS: StockSkill[] = [
  { name: 'self-defense',        kind: 'reflex',  description: 'Fight back (armed), or flee to the guards and call for help when attacked',   code: SELF_DEFENSE        },
  { name: 'on-death',            kind: 'reflex',  description: 'Reflect after dying and plan gear recovery',                                  code: ON_DEATH            },
  { name: 'respond-to-everyone', kind: 'reflex',  description: 'Respond when a player calls "Everyone" / "Tout le monde" in public chat',    code: RESPOND_TO_EVERYONE },
  { name: 'guard-respond',       kind: 'reflex',  description: 'Answer help calls from villagers and players, armed',                         code: GUARD_RESPOND       },
  { name: 'guard-watch',         kind: 'reflex',  description: 'Intercept hostiles that get close; back off from creepers',                   code: GUARD_WATCH         },
  { name: 'night-shelter',       kind: 'reflex',  description: 'Go home when night falls (skips if already home)',                            code: NIGHT_SHELTER       },
  { name: 'farm-setup',          kind: 'routine', description: 'Get hoe and seeds from the chest, till ground near water, plant wheat',       code: FARM_SETUP          },
  { name: 'farm-loop',           kind: 'routine', description: 'Harvest mature crops around the workstation, replant, bank the surplus',      code: FARM_LOOP           },
  { name: 'gather-loop',         kind: 'routine', description: 'Break grass for wheat seeds, bank them, then collect and bank wood',          code: GATHER_LOOP         },
  { name: 'wood-loop',           kind: 'routine', description: 'Collect logs near the workstation, replant saplings, bank the wood',          code: WOOD_LOOP           },
  { name: 'craft-batch',         kind: 'routine', description: 'Craft planks, sticks and wooden tools from banked logs',                      code: CRAFT_BATCH         },
  { name: 'mine-loop',           kind: 'routine', description: 'Quarry stone and surface ores near the workstation, bank the haul',           code: MINE_LOOP           },
  { name: 'guard-patrol',        kind: 'routine', description: 'Patrol between post and home so threats are spotted early',                   code: GUARD_PATROL        },
];
