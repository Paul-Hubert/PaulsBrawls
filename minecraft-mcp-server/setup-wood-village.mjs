// Stages a small wood->tools village work area on the RUNNING dev server via
// RCON, then writes the matching 3-bot roster (2 lumberjacks + 1 crafter,
// shared bank chest) for `npm run village`.
//
// Idempotent: clears the airspace and re-lays the platform/fixtures each run,
// so re-running restocks the oak grove.
//
//   node setup-wood-village.mjs [--rcon-host 127.0.0.1] [--rcon-port 25575]
//        [--rcon-pass paulsbrawls-eval] [--level ../run/world/level.dat]
//        [--center <x>,<z>] [--out village3.json]

import fs from 'node:fs';
import { Rcon } from 'rcon-client';
import nbt from 'prismarine-nbt';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const RCON_HOST = arg('rcon-host', '127.0.0.1');
const RCON_PORT = Number(arg('rcon-port', '25575'));
const RCON_PASS = arg('rcon-pass', 'paulsbrawls-eval');
const LEVEL_DAT = arg('level', '../run/world/level.dat');
const OUT_FILE = arg('out', 'village3.json');
const CENTER_OVERRIDE = arg('center', '');

const TOLERATED = [
  /already exists/i, /No entity was found/i, /Nothing changed/i, /Test failed/i,
  /That position is already/i, /no blocks were filled/i, /Could not set the time/i,
];
const FATAL = [/^Unknown /i, /Incorrect argument/i, /Expected /i, /Invalid /i, /Cannot place/i];

async function readWorldSpawn() {
  const { parsed } = await nbt.parse(fs.readFileSync(LEVEL_DAT));
  const data = parsed.value.Data.value;
  return { x: data.SpawnX.value, z: data.SpawnZ.value };
}

async function main() {
  let cx, cz;
  if (CENTER_OVERRIDE) {
    [cx, cz] = CENTER_OVERRIDE.split(',').map((s) => Math.floor(Number(s)));
  } else {
    const spawn = await readWorldSpawn();
    // 32 east of spawn so the original spawn area stays untouched.
    cx = spawn.x + 32;
    cz = spawn.z;
    console.log(`world spawn (${spawn.x}, ${spawn.z}) -> village center (${cx}, ${cz})`);
  }

  const rcon = await Rcon.connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASS });
  const send = async (cmd) => {
    const resp = await rcon.send(cmd);
    if (FATAL.some((re) => re.test(resp)) && !TOLERATED.some((re) => re.test(resp))) {
      throw new Error(`command failed: '${cmd}' -> ${resp}`);
    }
    console.log(`[rcon] ${cmd} -> ${resp.replace(/\s+/g, ' ').slice(0, 120)}`);
    return resp;
  };

  const minX = cx - 14, maxX = cx + 13, minZ = cz - 14, maxZ = cz + 13;

  // Keep the region loaded before probing/building (forceload is 2D, no Y needed).
  await send(`forceload add ${minX} ${minZ} ${maxX} ${maxZ}`);

  // Find the surface at the center: coarse downward scan, then refine upward.
  let gy = 200;
  while (gy > -60) {
    const r = await rcon.send(`execute if block ${cx} ${gy} ${cz} minecraft:air`);
    if (!/passed/i.test(r)) break;
    gy -= 8;
  }
  while (gy < 200) {
    const r = await rcon.send(`execute if block ${cx} ${gy + 1} ${cz} minecraft:air`);
    if (/passed/i.test(r)) break;
    gy += 1;
  }
  gy = Math.max(gy, 62); // never build sunken below sea level (ocean -> island)
  console.log(`surface probe: ground Y = ${gy}`);
  const sy = gy + 1; // standing level

  const cmds = [
    // Demo determinism: frozen day, no weather, no mobs.
    'gamerule doMobSpawning false',
    'gamerule doDaylightCycle false',
    'gamerule doWeatherCycle false',
    'gamerule announceAdvancements false',
    'gamerule spawnRadius 0',
    'weather clear',
    'time set 2000',
    `setworldspawn ${cx} ${sy} ${cz}`,
  ];

  // Airspace (also wipes previous fixtures/grove), one layer per fill.
  for (let y = sy; y <= sy + 11; y++) {
    cmds.push(`fill ${minX} ${y} ${minZ} ${maxX} ${y} ${maxZ} minecraft:air`);
  }
  // Platform slab: dirt base + grass top, terrain-independent.
  cmds.push(
    `fill ${minX} ${gy - 2} ${minZ} ${maxX} ${gy - 1} ${maxZ} minecraft:dirt`,
    `fill ${minX} ${gy} ${minZ} ${maxX} ${gy} ${maxZ} minecraft:grass_block`,
    // Fence perimeter with a south gate.
    `fill ${minX} ${sy} ${minZ} ${maxX} ${sy} ${minZ} minecraft:oak_fence`,
    `fill ${minX} ${sy} ${maxZ} ${maxX} ${sy} ${maxZ} minecraft:oak_fence`,
    `fill ${minX} ${sy} ${minZ} ${minX} ${sy} ${maxZ} minecraft:oak_fence`,
    `fill ${maxX} ${sy} ${minZ} ${maxX} ${sy} ${maxZ} minecraft:oak_fence`,
    `setblock ${cx} ${sy} ${maxZ} minecraft:oak_fence_gate[facing=south]`,
    // Shared bank chest + the crafter's table.
    `setblock ${cx} ${sy} ${cz - 3} minecraft:chest[facing=south]`,
    `setblock ${cx + 3} ${sy} ${cz - 3} minecraft:crafting_table`,
    // Light.
    `setblock ${cx + 1} ${sy} ${cz - 3} minecraft:torch`,
    `setblock ${minX + 1} ${sy} ${minZ + 1} minecraft:torch`,
    `setblock ${maxX - 1} ${sy} ${minZ + 1} minecraft:torch`,
    `setblock ${minX + 1} ${sy} ${maxZ - 1} minecraft:torch`,
    `setblock ${maxX - 1} ${sy} ${maxZ - 1} minecraft:torch`,
  );

  // Oak grove in the NW quadrant: 9 trees, 4-log trunks, persistent leaf caps.
  const treeSpots = [];
  for (const tx of [cx - 11, cx - 8, cx - 5]) {
    for (const tz of [cz - 11, cz - 8, cz - 5]) treeSpots.push([tx, tz]);
  }
  for (const [tx, tz] of treeSpots) {
    cmds.push(`fill ${tx} ${sy} ${tz} ${tx} ${sy + 3} ${tz} minecraft:oak_log`);
    const ly = sy + 3;
    cmds.push(
      `setblock ${tx + 1} ${ly} ${tz} minecraft:oak_leaves[persistent=true]`,
      `setblock ${tx - 1} ${ly} ${tz} minecraft:oak_leaves[persistent=true]`,
      `setblock ${tx} ${ly} ${tz + 1} minecraft:oak_leaves[persistent=true]`,
      `setblock ${tx} ${ly} ${tz - 1} minecraft:oak_leaves[persistent=true]`,
      `setblock ${tx} ${ly + 1} ${tz} minecraft:oak_leaves[persistent=true]`
    );
  }

  // Sweep item drops from previous runs.
  cmds.push(`execute positioned ${cx} ${gy} ${cz} run kill @e[type=minecraft:item,distance=..40]`);

  for (const cmd of cmds) await send(cmd);
  await rcon.end();

  // Roster: shared chest is the handoff — lumberjacks bank logs there,
  // the crafter withdraws them (deposit/withdraw use roster.chest).
  const chest = { x: cx, y: sy, z: cz - 3 };
  const roster = {
    settings: {
      llm: {
        provider: 'openai',
        baseUrl: '',
        model: 'gpt-4o-mini',
        apiKey: '',
        timeoutMs: 120000,
        temperature: 0.9,
        maxTokens: 4096,
      },
      concurrency: 3,
      heartbeatSeconds: 60,
      botCooldownMs: 15000,
      earshotRadius: 32,
      settlementUrl: 'http://127.0.0.1:8767',
      dataDir: '.village-data',
      maxConversationTurns: 8,
    },
    bots: [
      {
        name: 'Brindille', role: 'lumberjack',
        personality: "Bûcheronne joviale, plaisante tout le temps, compte ses bûches comme un dragon son or. Dépose toujours sa récolte dans le coffre commun pour qu'Enclume puisse fabriquer des outils.",
        home: { x: cx - 4, y: sy, z: cz + 5 },
        workstation: { x: cx - 8, y: sy, z: cz - 8 },
        chest,
      },
      {
        name: 'Copeau', role: 'lumberjack',
        personality: "Jeune bûcheron zélé, veut impressionner Brindille, ne s'arrête jamais avant d'avoir rempli le coffre commun de bûches.",
        home: { x: cx - 7, y: sy, z: cz + 5 },
        workstation: { x: cx - 5, y: sy, z: cz - 5 },
        chest,
      },
      {
        name: 'Enclume', role: 'crafter',
        personality: "Artisan perfectionniste, déteste le travail bâclé. Rêve d'équiper tout le village en outils en bois : il prend les bûches du coffre commun, fabrique haches, pioches et pelles, et les range dans ce même coffre.",
        home: { x: cx + 5, y: sy, z: cz + 5 },
        workstation: { x: cx + 3, y: sy, z: cz - 2 },
        chest,
      },
    ],
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(roster, null, 2) + '\n');
  console.log(`wrote ${OUT_FILE}`);
  console.log(`village center: (${cx}, ${sy}, ${cz}) — chest (${chest.x}, ${chest.y}, ${chest.z}), grove NW, crafting table at (${cx + 3}, ${sy}, ${cz - 3})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
