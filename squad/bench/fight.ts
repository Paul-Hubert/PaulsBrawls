// The fight benchmark: two identical armies of real Mineflayer bots fight on an arena of the DEV world, the real
// runtime in process (as live-tests/run.ts), and everything a performance analysis needs is recorded per round:
//   • blue: GUARDS guards + ARCHERS archers (the kits of `/bots squad spawn guard|archer`, SquadKits.java), owned by
//     BenchBleu, running `defend` (Paul's squad, docs/35: it stands and fights what comes);
//   • red: the exact same army (same kits, same counts, the mirrored formation), owned by BenchRouge, running `raid`
//     on blue's position (what `/bots raid` starts for Envahisseur);
//   • same arena, same places, same kits and full health at the start of every round, so rounds and runs compare.
// A round ends when one army has no bot left, or after --seconds. A bot that dies is despawned, as docs/35 D2 decided
// (« a bot that dies disconnects »; --dead respawn keeps today's runtime, where it respawns at the world spawn, far
// from the arena, and loads all its chunks again in the middle of the fight); between rounds every bot is brought
// back, healed and re-kitted.
//
// Measured per round (and for --idle seconds of the 2 × N bots standing first):
//   • the process: event-loop delay and utilization, CPU, memory, time in decode / inflate / physics / look-ahead /
//     A* (lib/probe.ts, lib/instrument.ts); per bot: physics ticks/s, packets, path searches and resets;
//   • the helpers as the commands call them (lib/helper-timing.ts): calls, how they ended, wall time and the
//     synchronous part that blocks the loop;
//   • a CPU profile (the rounds of --profile-rounds and the idle phase): self time and total time per function, by
//     cause, by package (profile-summary.ts), and Squad's own frames (runtime, helpers, the commands' code);
//   • a timeline, one row per second: bots alive and health per army, ELU, worst loop delay, CPU, A*/physics ms,
//     helper calls, ticks/s, entities per bot;
//   • the fight: who died when, killed by whom and how (the server log's death messages), friendly kills;
//   • the server: `tick query` every 5 s, "Can't keep up!", the JVM's CPU.
//
//   cd squad && npm run bench:fight -- --label baseline
//
// Needs the dev server (`./gradlew runDevServer`: dev/, port 25599, RCON 25576) with:
//   • max-players ≥ 2 × (guards + archers) in dev/server.properties (default 20: raise it, then put it back);
//   • dev/squad.properties pointing the dev mod at this runtime, for the friendly-fire rule (an archer's arrow or a
//     guard's sweep never hurts its own army; without it the armies kill themselves): enabled=true,
//     url=http\://127.0.0.1\:8779, token=live-test-token; --no-mod runs without it (friendly fire on, not realistic).
//     Set enabled=false again afterwards (dev/README.md).
//
// Options: --guards 10, --archers 10 (per army), --rounds 2, --seconds 240 (a round's limit), --idle 20 (0: none),
// --profile-rounds 1 (how many rounds, from the first, get a CPU profile; the idle phase is profiled when the first
// round is), --sampling-us 1000, --gap 40 (blocks between the two front rows), --blue "defend radius=24",
// --red "raid radius=24" (command and tokens; a raid without x= goes for the other army's position), --arena x,z
// (default 1400,1000, the floor at y 100), --stagger <ms> (default the runtime's 4000), --port 8779, --no-mod,
// --difficulty hard (production's), --dead disconnect|respawn, --workers <N>, --astar-budget <ms>, --label.
// Experiment (bench-only): --hawkeye-every N runs hawkEye's aim (getGrades, a full trajectory search with raycasts,
// on every physics tick of a drawing archer) on one tick in N; the bow is still turned every tick, to the last aim. SERVER_PROPERTIES overrides the
// server (default ../dev/server.properties); the production server is refused.

import './lib/instrument'; // first: it wraps prismarine-physics before mineflayer loads it

import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';

import type { Bot } from 'mineflayer';

import { parseConfig, DEFAULT_LIMITS } from '../src/config';
import { start, type Started } from '../src/main';
import { logger } from '../src/logger';
import type { Player } from '../src/roster';
import { EMPTY_SNAPSHOT, type Snapshot } from '../src/types';
import { Rcon } from '../live-tests/rcon';
import { counters, type Counters } from './lib/instrument';
import { instrumentHelpers, readHelperStats, resetHelperStats, takeCallsPerHelper, type HelperRow } from './lib/helper-timing';
import { BotMeters, ProcessProbe, r1, type BotPhase, type ProcessPhase } from './lib/probe';
import { keepUpLines, LogTail, pidOnPort, processCpu, readProps, tickQuery, type KeepUp, type TickSample } from './lib/server';
import { render, summarise } from './profile-summary';

const here = dirname(fileURLToPath(import.meta.url));

// -- options ---------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const flag = (name: string): boolean => argv.includes(`--${name}`);

const GUARDS = Number(opt('guards') ?? 10);
const ARCHERS = Number(opt('archers') ?? 10);
const ROUNDS = Number(opt('rounds') ?? 2);
const SECONDS = Number(opt('seconds') ?? 240);
const IDLE = Number(opt('idle') ?? 20);
const PROFILE_ROUNDS = Number(opt('profile-rounds') ?? 1);
const SAMPLING_US = Number(opt('sampling-us') ?? 1_000);
const GAP = Number(opt('gap') ?? 40);
const BLUE_ORDER = (opt('blue') ?? 'defend radius=24').trim().split(/\s+/);
const RED_ORDER = (opt('red') ?? 'raid radius=24').trim().split(/\s+/);
const [AX, AZ] = (opt('arena') ?? '1400,1000').split(',').map(Number) as [number, number];
const AY = 100;
const STAGGER = opt('stagger') === undefined ? undefined : Number(opt('stagger'));
const PORT = Number(opt('port') ?? 8779);
const NO_MOD = flag('no-mod');
const DIFFICULTY = opt('difficulty') ?? 'hard';
const DEAD = (opt('dead') ?? 'disconnect') as 'disconnect' | 'respawn';
if (!['disconnect', 'respawn'].includes(DEAD)) throw new Error(`--dead ${DEAD}: disconnect or respawn`);
const WORKERS = Number(opt('workers') ?? 0);
const ASTAR_BUDGET = opt('astar-budget') === undefined ? undefined : Number(opt('astar-budget'));
const LABEL = opt('label') ?? 'fight';
const HAWKEYE_EVERY = Math.max(1, Number(opt('hawkeye-every') ?? 1));
/** The token dev/squad.properties gives the dev mod for the live tests' runtime (dev/README.md). */
const TOKEN = 'live-test-token';

// -- the server --------------------------------------------------------------------------------------------------

const PROPS_FILE = process.env.SERVER_PROPERTIES ? resolve(process.env.SERVER_PROPERTIES) : resolve(here, '..', '..', 'dev', 'server.properties');
const props = readProps(PROPS_FILE);
const MC_PORT = Number(props['server-port'] ?? 25599);
if (['server', 'run'].includes(basename(dirname(PROPS_FILE))) || MC_PORT === 25565) {
  throw new Error(`refusing to fight on ${PROPS_FILE} (port ${MC_PORT}): the production server is never load-tested. Use the dev server (dev/).`);
}
const RCON_PORT = Number(props['rcon.port'] ?? 25576);
const RCON_PASSWORD = props['rcon.password'] ?? '';
const MAX_PLAYERS = Number(props['max-players'] ?? 20);

// -- the armies ------------------------------------------------------------------------------------------------

type Side = 'blue' | 'red';
type Kit = 'guard' | 'archer';
interface Soldier {
  name: string;
  side: Side;
  kit: Kit;
  /** Its place at the start of a round: block centre, feet on the floor. */
  at: { x: number; y: number; z: number };
}

const OWNERS: Record<Side, Player> = {
  blue: { uuid: '44444444-4444-4444-4444-444444444444', name: 'BenchBleu' },
  red: { uuid: '55555555-5555-5555-5555-555555555555', name: 'BenchRouge' },
};
const PREFIX: Record<Side, string> = { blue: 'Bleu', red: 'Rouge' };
/** Which way each army faces (along x): blue looks east at red, red west at blue. Minecraft yaw: −90 east, 90 west. */
const FACING: Record<Side, { dx: number; yaw: number }> = { blue: { dx: 1, yaw: -90 }, red: { dx: -1, yaw: 90 } };
/** Each army's front-row centre. */
const FRONT: Record<Side, { x: number; z: number }> = {
  blue: { x: AX - GAP / 2 + 0.5, z: AZ + 0.5 },
  red: { x: AX + GAP / 2 + 0.5, z: AZ + 0.5 },
};
/** Formation as SquadRaidPlan.spread: rows of ROW, GAP_ apart; guards in the front rows, archers behind. */
const ROW = 5;
const SLOT_GAP = 2;

/** SquadKits.java, item for item: [slot, id, count]; a slot of null goes to the inventory. */
const KITS: Record<Kit, Array<[string | null, string, number]>> = {
  archer: [
    ['armor.head', 'chainmail_helmet', 1],
    ['armor.chest', 'chainmail_chestplate', 1],
    ['armor.legs', 'chainmail_leggings', 1],
    ['armor.feet', 'chainmail_boots', 1],
    ['weapon.mainhand', 'bow', 1],
    [null, 'arrow', 64],
    [null, 'stone_sword', 1],
    [null, 'cooked_beef', 16],
  ],
  guard: [
    ['armor.head', 'iron_helmet', 1],
    ['armor.chest', 'iron_chestplate', 1],
    ['armor.legs', 'iron_leggings', 1],
    ['armor.feet', 'iron_boots', 1],
    ['weapon.mainhand', 'iron_sword', 1],
    ['weapon.offhand', 'shield', 1],
    [null, 'cooked_beef', 16],
  ],
};

function army(side: Side): Soldier[] {
  const out: Soldier[] = [];
  const n = GUARDS + ARCHERS;
  const f = FACING[side];
  const c = FRONT[side];
  for (let i = 0; i < n; i++) {
    const kit: Kit = i < GUARDS ? 'guard' : 'archer';
    const k = kit === 'guard' ? i + 1 : i - GUARDS + 1;
    const row = Math.floor(i / ROW);
    const inRow = Math.min(ROW, n - row * ROW);
    const across = ((i % ROW) - (inRow - 1) / 2) * SLOT_GAP;
    // Row 0 is the front; every row behind is SLOT_GAP further from the enemy.
    out.push({
      name: `${PREFIX[side]}${kit === 'guard' ? 'Garde' : 'Archer'}${String(k).padStart(2, '0')}`,
      side,
      kit,
      at: { x: Math.floor(c.x - f.dx * row * SLOT_GAP) + 0.5, y: AY + 1, z: Math.floor(c.z + across) + 0.5 },
    });
  }
  return out;
}

const SOLDIERS = [...army('blue'), ...army('red')];
const SIDE_OF = new Map(SOLDIERS.map((s) => [s.name, s.side]));
const NAMES = SOLDIERS.map((s) => s.name);
/** The arena: a stone floor at AY, barrier walls around it, room for both armies and the fight between them. */
const HALF_X = Math.ceil(GAP / 2) + 28;
const HALF_Z = 24;

const ADMIN: Player = { uuid: '33333333-3333-3333-3333-333333333333', name: 'BenchBoss' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (line: string): void => logger.info('fight', line);

// -- results ----------------------------------------------------------------------------------------------------

interface Death {
  t: number;
  name: string;
  side: Side;
  /** From the server log: the killer (a bot name) and how ("slain" = melee, "shot" = arrow), when it says. */
  by?: string;
  how?: string;
  line?: string;
}

interface TimelineRow {
  t: number;
  alive: Record<Side, number>;
  hp: Record<Side, number>;
  elu: number;
  loopMaxMs: number;
  cpuPct: number;
  /** ms of this second spent in each instrumented module, all bots together. */
  ms: { astar: number; physics: number; lookahead: number; decode: number; inflate: number };
  /** Helper calls started in this second. */
  calls: Record<string, number>;
  /** Mean physics ticks per alive bot in this second (20 = smooth). */
  ticks: number;
  /** Mean entities each alive bot tracks (arrows in flight count). */
  entities: number;
}

interface OrderSummary {
  side: Side;
  id: string;
  command: string;
  tokens: string[];
  status: string;
  result?: string;
  error?: string;
  bots: number;
  logLines: number;
  /** The most frequent log lines, the bot name and numbers folded away. */
  topLogs: Array<{ line: string; count: number }>;
  failures: number;
}

interface ServerSide {
  tick: { mean: number; p50: number; p95: number; p99Max: number; samples: number } | null;
  keepUp: KeepUp;
  cpuPct: number | null;
  rssMb: number | null;
}

interface RoundResult {
  round: number;
  profiled: boolean;
  profile?: string;
  seconds: number;
  ended: 'blue wiped' | 'red wiped' | 'both wiped' | 'time limit' | 'orders ended';
  winner: Side | 'draw';
  survivors: Record<Side, number>;
  /** Health left, summed over the survivors (20 per bot at the start). */
  hpLeft: Record<Side, number>;
  deaths: Death[];
  kills: { byHow: Record<string, number>; bySide: Record<Side, number>; friendly: number };
  process: ProcessPhase;
  bots: BotPhase;
  server: ServerSide;
  helpers: HelperRow[];
  orders: OrderSummary[];
  timeline: TimelineRow[];
}

const runDir = join(here, '.runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${LABEL}`);
mkdirSync(join(runDir, 'profiles'), { recursive: true });

// -- main -------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (props['enable-rcon'] !== 'true') throw new Error(`RCON is off in ${PROPS_FILE} (enable-rcon=true)`);
  if (SOLDIERS.length > MAX_PLAYERS) throw new Error(`max-players=${MAX_PLAYERS} in ${PROPS_FILE}: raise it to at least ${SOLDIERS.length} for this fight (and restart the dev server)`);

  const rcon = new Rcon('127.0.0.1', RCON_PORT, RCON_PASSWORD);
  await rcon.connect();
  const serverPid = await pidOnPort(MC_PORT);
  const seed = (await rcon.command('seed')).trim();
  log(`server ${PROPS_FILE} (port ${MC_PORT}, pid ${serverPid ?? '?'}), ${seed}`);
  for (const c of [
    'time set day',
    'gamerule doDaylightCycle false',
    'gamerule doMobSpawning false',
    'gamerule doWeatherCycle false',
    // docs/35 D2: a bot that dies drops nothing (and the arena stays free of the dead's kits between rounds).
    'gamerule keepInventory true',
    'gamerule doImmediateRespawn true',
    'gamerule showDeathMessages true',
    'weather clear',
    `difficulty ${DIFFICULTY}`,
  ]) {
    await rcon.command(c);
  }
  await buildArena(rcon);

  const cfg = parseConfig(
    {
      minecraft: { port: MC_PORT },
      port: PORT,
      dataDir: join(runDir, 'data'),
      ...(STAGGER === undefined ? {} : { loginStaggerMs: STAGGER }),
      limits: { ...DEFAULT_LIMITS, maxBots: 64 },
      pathfinding: { ...(ASTAR_BUDGET === undefined ? {} : { astarBudgetMs: ASTAR_BUDGET }), workers: WORKERS },
    },
    { PAULSBRAWLS_SQUAD_TOKEN: TOKEN },
  );
  const rt = await start(cfg, { connectBots: true, installGuards: true });
  instrumentHelpers((bot) => SIDE_OF.get(bot) ?? 'other');
  const { pool } = rt.service.deps;
  const meters = new BotMeters();
  pool.on('online', (name: string, bot: Bot) => {
    meters.attach(name, bot);
    throttleHawkEye(bot);
  });

  const env = {
    label: LABEL,
    at: new Date().toISOString(),
    armies: { guards: GUARDS, archers: ARCHERS, blue: BLUE_ORDER.join(' '), red: RED_ORDER.join(' '), gap: GAP, arena: { x: AX, y: AY, z: AZ } },
    rounds: ROUNDS,
    secondsLimit: SECONDS,
    profileRounds: PROFILE_ROUNDS,
    samplingUs: SAMPLING_US,
    friendlyFireRule: !NO_MOD,
    stagger: cfg.loginStaggerMs,
    pathfinding: cfg.pathfinding,
    difficulty: DIFFICULTY,
    dead: DEAD,
    hawkeyeEvery: HAWKEYE_EVERY,
    node: process.version,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramGb: Math.round(totalmem() / 1073741824),
    server: { props: PROPS_FILE, port: MC_PORT, viewDistance: props['view-distance'], simulationDistance: props['simulation-distance'], compression: props['network-compression-threshold'], seed },
  };
  const out: { env: typeof env; idle: unknown; rounds: RoundResult[] } = { env, idle: null, rounds: [] };
  const save = (): void => writeFileSync(join(runDir, 'results.json'), JSON.stringify(out, null, 2));

  try {
    if (!NO_MOD) await waitForMod(rt);
    // The runtime warms the typecheck worker 2 s after boot (~5 s of compiler work on its own thread): let it finish.
    await sleep(10_000);
    await spawnAll(rt);
    await kitAll(rt, rcon);
    await placeAll(rt, rcon);
    if (IDLE > 0) {
      out.idle = await idlePhase(rt, rcon, meters, serverPid, PROFILE_ROUNDS > 0);
      save();
    }
    for (let r = 1; r <= ROUNDS; r++) {
      if (r > 1) await resetRound(rt, rcon);
      const res = await fightRound(rt, rcon, meters, serverPid, r, r <= PROFILE_ROUNDS);
      out.rounds.push(res);
      save();
      log(roundLine(res));
    }
  } finally {
    save();
    writeFileSync(join(runDir, 'summary.md'), summaryMd(out));
    await rt.service.deps.runner.stopAll('stopped');
    await rt.stop();
    rcon.close();
  }
  log(`done: ${runDir}`);
  process.exit(0);
}

type Listener = (...a: unknown[]) => unknown;

/**
 * --hawkeye-every N: hawkEye registers `getGrades` on physicsTick for every shot (and removes it after); wrap it so it
 * runs on the first tick and then one tick in N. Its autoCalc still looks along the last aim every tick.
 */
function throttleHawkEye(bot: Bot): void {
  if (HAWKEYE_EVERY <= 1) return;
  const e = bot as unknown as { on: (ev: string, fn: Listener) => unknown; addListener: (ev: string, fn: Listener) => unknown; removeListener: (ev: string, fn: Listener) => unknown; off: (ev: string, fn: Listener) => unknown };
  const on = e.on.bind(bot);
  const off = e.removeListener.bind(bot);
  const wrapped = new WeakMap<Listener, Listener>();
  const wrap = (ev: string, fn: Listener): Listener => {
    if (ev !== 'physicsTick' || fn.name !== 'getGrades') return fn;
    let n = 0;
    const w: Listener = function (this: unknown, ...a: unknown[]) {
      if (n++ % HAWKEYE_EVERY === 0) return fn.apply(this, a);
      return undefined;
    };
    wrapped.set(fn, w);
    return w;
  };
  e.on = e.addListener = (ev, fn) => on(ev, wrap(ev, fn));
  e.removeListener = e.off = (ev, fn) => off(ev, wrapped.get(fn) ?? fn);
}

/** The dev mod connects to this runtime's event stream when dev/squad.properties points at it (friendly fire). */
async function waitForMod(rt: Started): Promise<void> {
  const clients = (): number => (rt.http as unknown as { clients: Set<unknown> }).clients.size;
  const deadline = Date.now() + 45_000;
  while (clients() === 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `the dev mod did not connect to this runtime (port ${PORT}) within 45 s: set dev/squad.properties to enabled=true, ` +
          `url=http\\://127.0.0.1\\:${PORT}, token=${TOKEN} and restart the dev server (or --no-mod: friendly fire stays on)`,
      );
    }
    await sleep(500);
  }
  log(`the dev mod is connected (friendly fire between bots of one owner is cancelled)`);
}

async function api(rt: Started, path: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  const r = await fetch(`http://127.0.0.1:${rt.port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  return (await r.json()) as { ok: boolean; text: string };
}

/** A stone floor at AY, air above it, barrier walls 4 high around it (nobody falls off, nobody walks away). */
async function buildArena(rcon: Rcon): Promise<void> {
  const x0 = AX - HALF_X;
  const x1 = AX + HALF_X;
  const z0 = AZ - HALF_Z;
  const z1 = AZ + HALF_Z;
  log(`arena: ${x1 - x0 + 1}×${z1 - z0 + 1} stone at y ${AY}, x ${x0}..${x1}, z ${z0}..${z1}`);
  // Load the chunks first (fill refuses unloaded positions), then let them go when the bots stand there.
  await rcon.command(`forceload add ${x0} ${z0} ${x1} ${z1}`);
  await sleep(3_000);
  const check = async (c: string): Promise<void> => {
    const r = await rcon.command(c);
    if (/not loaded|Unknown|Incorrect|error/i.test(r)) throw new Error(`${c}: ${r}`);
  };
  await check(`fill ${x0} ${AY} ${z0} ${x1} ${AY} ${z1} stone`);
  // Air above in slices (fill takes at most 32 768 blocks).
  for (let y = AY + 1; y <= AY + 12; y += 3) await check(`fill ${x0} ${y} ${z0} ${x1} ${Math.min(AY + 12, y + 2)} ${z1} air`);
  await check(`fill ${x0} ${AY + 1} ${z0} ${x1} ${AY + 4} ${z0} barrier`);
  await check(`fill ${x0} ${AY + 1} ${z1} ${x1} ${AY + 4} ${z1} barrier`);
  await check(`fill ${x0} ${AY + 1} ${z0} ${x0} ${AY + 4} ${z1} barrier`);
  await check(`fill ${x1} ${AY + 1} ${z0} ${x1} ${AY + 4} ${z1} barrier`);
  await clearArena(rcon);
}

/** Arrows, dropped items and any mob on the arena go. */
async function clearArena(rcon: Rcon): Promise<void> {
  const box = `x=${AX - HALF_X},y=${AY - 8},z=${AZ - HALF_Z},dx=${2 * HALF_X},dy=40,dz=${2 * HALF_Z}`;
  for (const type of ['arrow', 'item', 'experience_orb']) await rcon.command(`kill @e[type=${type},${box}]`);
  await rcon.command(`kill @e[type=!player,${box}]`);
}

/** The soldiers not in the roster (all of them at first, the despawned dead later) through the control API, owned by
 *  their army's owner; then wait until every soldier is online. */
async function spawnAll(rt: Started): Promise<void> {
  const { pool, roster } = rt.service.deps;
  const missing = SOLDIERS.filter((s) => !roster.all().some((b) => b.name === s.name));
  for (const s of missing) {
    const r = await api(rt, '/api/bots/spawn', { by: ADMIN, admin: true, name: s.name, owners: [OWNERS[s.side]] });
    if (!r.ok) throw new Error(`spawn ${s.name}: ${r.text}`);
    const t = await api(rt, '/api/bots/tag', { by: ADMIN, admin: true, name: s.name, changes: ['-archer', '-guard', '-miner', '-farmer', `+${s.kit}`] });
    if (!t.ok) throw new Error(`tag ${s.name}: ${t.text}`);
  }
  if (missing.length) log(`${missing.length} bots spawning (${cfgStagger(rt)} ms apart)`);
  const deadline = Date.now() + SOLDIERS.length * ((cfgStagger(rt) ?? 4_000) + 15_000) + 30_000;
  while (!NAMES.every((b) => pool.status(b) === 'online')) {
    if (Date.now() > deadline) throw new Error(`bots not online: ${NAMES.filter((b) => pool.status(b) !== 'online').join(', ')}`);
    await sleep(1_000);
  }
  log('every bot is online');
}

function cfgStagger(rt: Started): number | undefined {
  return (rt.service.deps.pool as unknown as { opts?: { staggerMs?: number } }).opts?.staggerMs;
}

/** The kits of SquadKits.java, full health and food. */
async function kitAll(rt: Started, rcon: Rcon): Promise<void> {
  for (const s of SOLDIERS) {
    await rcon.command(`clear ${s.name}`);
    for (const [slot, id, count] of KITS[s.kit]) {
      await rcon.command(slot ? `item replace entity ${s.name} ${slot} with ${id} ${count}` : `give ${s.name} ${id} ${count}`);
    }
    await rcon.command(`effect clear ${s.name}`);
    await rcon.command(`effect give ${s.name} instant_health 1 10 true`);
    await rcon.command(`effect give ${s.name} saturation 1 10 true`);
  }
  // The inventory and health reach the runtime's bots a tick or two later.
  const { pool } = rt.service.deps;
  const deadline = Date.now() + 20_000;
  const ready = (s: Soldier): boolean => {
    const b = pool.bot(s.name);
    if (!b || !b.entity) return false;
    const items = b.inventory.items().map((i) => i.name);
    const kitted = s.kit === 'archer' ? items.includes('bow') && items.includes('arrow') : items.includes('iron_sword');
    return kitted && b.health >= 19.5;
  };
  while (!SOLDIERS.every(ready)) {
    if (Date.now() > deadline) throw new Error(`kits not seen by the bots: ${SOLDIERS.filter((s) => !ready(s)).map((s) => s.name).join(', ')}`);
    await sleep(500);
  }
}

/** Every soldier on its place, facing the enemy; then settle. */
async function placeAll(rt: Started, rcon: Rcon): Promise<void> {
  const { pool } = rt.service.deps;
  for (const s of SOLDIERS) await rcon.command(`tp ${s.name} ${s.at.x} ${s.at.y} ${s.at.z} ${FACING[s.side].yaw} 0`);
  const deadline = Date.now() + 30_000;
  const placed = (s: Soldier): boolean => {
    const p = pool.bot(s.name)?.entity?.position;
    return !!p && Math.hypot(p.x - s.at.x, p.z - s.at.z) < 1 && Math.abs(p.y - s.at.y) < 1.5;
  };
  while (!SOLDIERS.every(placed)) {
    if (Date.now() > deadline) throw new Error(`not on their places: ${SOLDIERS.filter((s) => !placed(s)).map((s) => `${s.name} ${fmt(pool.bot(s.name)?.entity?.position)}`).join(', ')}`);
    await sleep(500);
  }
  // Their chunks, and the server's entity tracking of 2 × N players standing together.
  await sleep(8_000);
}

/** Between rounds: orders stopped, the dead back online, the arena cleared, kits and health restored, places. */
async function resetRound(rt: Started, rcon: Rcon): Promise<void> {
  await rt.service.deps.runner.stopAll('stopped');
  await spawnAll(rt);
  await clearArena(rcon);
  await kitAll(rt, rcon);
  await placeAll(rt, rcon);
}

/** The server side of a phase: `tick query` every 5 s, its log (Can't keep up!, death messages), the JVM's CPU. */
class ServerWatch {
  private readonly tail = LogTail.forServer(PROPS_FILE);
  private readonly ticks: TickSample[] = [];
  private readonly lines: string[] = [];
  private cpu0?: { cpuMs: number };
  private t0 = Date.now();
  private last = 0;

  constructor(
    private readonly rcon: Rcon,
    private readonly pid: number | undefined,
  ) {}

  async begin(): Promise<void> {
    this.tail.read();
    this.cpu0 = this.pid ? await processCpu(this.pid) : undefined;
    this.t0 = Date.now();
  }

  /** New log lines since the last poll (also kept for keepUp); `tick query` every 5 s. */
  async poll(): Promise<string[]> {
    const fresh = this.tail.read();
    this.lines.push(...fresh);
    if (Date.now() - this.last >= 5_000) {
      this.last = Date.now();
      const s = await tickQuery(this.rcon).catch(() => undefined);
      if (s) this.ticks.push(s);
    }
    return fresh;
  }

  async end(): Promise<ServerSide> {
    this.lines.push(...this.tail.read());
    const s = await tickQuery(this.rcon).catch(() => undefined);
    if (s) this.ticks.push(s);
    const cpu1 = this.pid ? await processCpu(this.pid) : undefined;
    const wall = Date.now() - this.t0;
    const t = this.ticks;
    const mean = (f: (x: TickSample) => number): number => r1(t.reduce((a, x) => a + f(x), 0) / Math.max(1, t.length));
    return {
      tick: t.length ? { mean: mean((x) => x.meanMs), p50: mean((x) => x.p50), p95: mean((x) => x.p95), p99Max: r1(Math.max(...t.map((x) => x.p99))), samples: t.length } : null,
      keepUp: keepUpLines(this.lines),
      cpuPct: this.cpu0 && cpu1 ? r1(((cpu1.cpuMs - this.cpu0.cpuMs) / wall) * 100) : null,
      rssMb: cpu1 ? Math.round(cpu1.rssMb) : null,
    };
  }
}

async function startProfile(on: boolean): Promise<Session | undefined> {
  if (!on) return undefined;
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: SAMPLING_US });
  await session.post('Profiler.start');
  return session;
}

async function stopProfile(session: Session | undefined, name: string): Promise<string | undefined> {
  if (!session) return undefined;
  const { profile } = await session.post('Profiler.stop');
  session.disconnect();
  const file = join('profiles', `${name}.cpuprofile`);
  writeFileSync(join(runDir, file), JSON.stringify(profile));
  return file;
}

async function idlePhase(rt: Started, rcon: Rcon, meters: BotMeters, pid: number | undefined, profiled: boolean): Promise<unknown> {
  log(`idle: ${SOLDIERS.length} bots standing for ${IDLE} s${profiled ? ' (profiled)' : ''}`);
  const watch = new ServerWatch(rcon, pid);
  await watch.begin();
  const probe = new ProcessProbe();
  meters.reset();
  resetHelperStats();
  const session = await startProfile(profiled);
  probe.start();
  const end = Date.now() + IDLE * 1000;
  while (Date.now() < end) {
    await watch.poll();
    await sleep(Math.min(1_000, Math.max(0, end - Date.now())));
  }
  const proc = probe.stop();
  const profile = await stopProfile(session, 'idle');
  const server = await watch.end();
  const bots = meters.read(NAMES, proc.seconds);
  log(`idle: ELU ${proc.elu}, loop p99 ${proc.loop.p99} ms, CPU ${proc.cpuPct} %, ticks/s min ${bots.ticksPerSec.min}`);
  return { seconds: proc.seconds, profiled, profile, process: proc, bots, server };
}

/** "RougeGarde03 was slain by BleuGarde01", "BleuArcher02 was shot by RougeArcher05": [victim, how, killer]. */
const DEATH_RE = /(?:\]: |\(Minecraft\) )(\w{3,16}) (was slain by|was shot by|was killed by|was blown up by|was pummeled by|died|fell|hit the ground|burned|drowned|suffocated|starved|was squashed|went up|tried)(?:[^\w]+(\w{3,16}))?/;

async function fightRound(rt: Started, rcon: Rcon, meters: BotMeters, pid: number | undefined, round: number, profiled: boolean): Promise<RoundResult> {
  const { pool, runner } = rt.service.deps;
  log(`round ${round}: ${GUARDS} guards + ${ARCHERS} archers a side; blue « ${BLUE_ORDER.join(' ')} », red « ${RED_ORDER.join(' ')} »${profiled ? ' (profiled)' : ''}`);
  const watch = new ServerWatch(rcon, pid);
  await watch.begin();
  const probe = new ProcessProbe();
  meters.reset();
  resetHelperStats();

  const dead = new Map<string, Death>();
  const t0 = performance.now();
  const tNow = (): number => r1((performance.now() - t0) / 1000);
  const onGone = (name: string, reason: string): void => {
    const side = SIDE_OF.get(name);
    if (reason !== 'died' || !side || dead.has(name)) return;
    dead.set(name, { t: tNow(), name, side });
    // docs/35 D2: the dead disconnect (it has just respawned at the world spawn: before its chunks pour in).
    if (DEAD === 'disconnect') {
      void api(rt, '/api/bots/despawn', { by: ADMIN, admin: true, name }).then(
        (r) => r.ok || logger.warn('fight', `despawn ${name}: ${r.text}`),
        (e: unknown) => logger.warn('fight', `despawn ${name}: ${(e as Error).message}`),
      );
    }
  };
  pool.on('gone', onGone);

  // Per-bot physics ticks for the timeline (BotMeters keeps its own per phase).
  const ticks = new Map<string, number>();
  /** The whole round's ticks per bot: divided by the time it was alive (a dead bot is despawned). */
  const tickTotal = new Map<string, number>();
  const tickers: Array<() => void> = [];
  for (const n of NAMES) {
    const b = pool.bot(n);
    if (!b) continue;
    const on = (): void => {
      ticks.set(n, (ticks.get(n) ?? 0) + 1);
      if (!dead.has(n)) tickTotal.set(n, (tickTotal.get(n) ?? 0) + 1);
    };
    b.on('physicsTick', on);
    tickers.push(() => b.removeListener('physicsTick', on));
  }

  const session = await startProfile(profiled);
  probe.start();

  const order = async (side: Side, words: string[], other: Side): Promise<string> => {
    const [command, ...tokens] = words as [string, ...string[]];
    if (command === 'raid' && !tokens.some((t) => t.startsWith('x='))) {
      const c = FRONT[other];
      tokens.push(`x=${Math.floor(c.x)}`, `y=${AY + 1}`, `z=${Math.floor(c.z)}`);
    }
    const snap: Snapshot = { ...EMPTY_SNAPSHOT, position: { x: FRONT[side].x, y: AY + 1, z: FRONT[side].z }, yaw: FACING[side].yaw };
    const names = SOLDIERS.filter((s) => s.side === side).map((s) => s.name);
    const r = await runner.start({ commander: OWNERS[side], command, tokens, filters: names, snap });
    if (!r.ok) throw new Error(`${side} ${command}: ${r.text}`);
    return r.orderId as string;
  };
  const ids: Record<Side, string> = { blue: await order('blue', BLUE_ORDER, 'red'), red: await order('red', RED_ORDER, 'blue') };

  const timeline: TimelineRow[] = [];
  const hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();
  let elu0: EventLoopUtilization = performance.eventLoopUtilization();
  let cpu0 = process.cpuUsage();
  let c0: Counters = { ...counters };
  let w0 = performance.now();
  const alive = (side: Side): Soldier[] => SOLDIERS.filter((s) => s.side === side && !dead.has(s.name) && pool.status(s.name) === 'online');
  const sample = (): void => {
    const now = performance.now();
    const wall = now - w0;
    const elu = performance.eventLoopUtilization(elu0);
    const cpu = process.cpuUsage(cpu0);
    const c = { ...counters };
    const live = [...alive('blue'), ...alive('red')];
    const ticksMean = live.length ? live.reduce((a, s) => a + (ticks.get(s.name) ?? 0), 0) / live.length / (wall / 1000) : 0;
    const ents = live.length ? live.reduce((a, s) => a + Object.keys(pool.bot(s.name)?.entities ?? {}).length, 0) / live.length : 0;
    const hp = (side: Side): number => r1(alive(side).reduce((a, s) => a + (pool.bot(s.name)?.health ?? 0), 0));
    timeline.push({
      t: tNow(),
      alive: { blue: alive('blue').length, red: alive('red').length },
      hp: { blue: hp('blue'), red: hp('red') },
      elu: Math.round(elu.utilization * 1000) / 1000,
      loopMaxMs: r1(Math.max(0, hist.max / 1e6 - 10)),
      cpuPct: r1(((cpu.user + cpu.system) / 1000 / wall) * 100),
      ms: {
        astar: r1(c.astarMs - c0.astarMs),
        physics: r1(c.physicsMs - c0.physicsMs),
        lookahead: r1(c.lookaheadMs - c0.lookaheadMs),
        decode: r1(c.decodeMs - c0.decodeMs),
        inflate: r1(c.inflateMs - c0.inflateMs),
      },
      calls: takeCallsPerHelper(),
      ticks: r1(ticksMean),
      entities: r1(ents),
    });
    hist.reset();
    elu0 = performance.eventLoopUtilization();
    cpu0 = process.cpuUsage();
    c0 = c;
    w0 = now;
    ticks.clear();
  };

  const deathLines: string[] = [];
  let ended: RoundResult['ended'] = 'time limit';
  const limit = Date.now() + SECONDS * 1000;
  let next = Date.now() + 1_000;
  for (;;) {
    await sleep(Math.max(0, next - Date.now()));
    next += 1_000;
    sample();
    for (const line of await watch.poll()) if (DEATH_RE.test(line)) deathLines.push(line);
    const b = alive('blue').length;
    const r = alive('red').length;
    if (b === 0 || r === 0) {
      ended = b === 0 && r === 0 ? 'both wiped' : b === 0 ? 'blue wiped' : 'red wiped';
      break;
    }
    if (Date.now() >= limit) break;
    if (!runner.get(ids.blue)?.running && !runner.get(ids.red)?.running) {
      ended = 'orders ended';
      break;
    }
  }
  hist.disable();
  const proc = probe.stop();
  const profile = await stopProfile(session, `fight-r${round}`);
  const seconds = proc.seconds;
  const bots = meters.read(NAMES, seconds);
  // BotMeters divides by the whole round; a bot counts only while it was alive here.
  const perBot = NAMES.map((n) => (tickTotal.get(n) ?? 0) / Math.max(1, dead.get(n)?.t ?? seconds));
  bots.ticksPerSec = { min: r1(Math.min(...perBot, 20)), mean: r1(perBot.reduce((a, b) => a + b, 0) / Math.max(1, perBot.length)) };
  const helpers = readHelperStats();
  const survivors = { blue: alive('blue').length, red: alive('red').length };
  const hpLeft = { blue: timeline.at(-1)?.hp.blue ?? 0, red: timeline.at(-1)?.hp.red ?? 0 };

  const orders: OrderSummary[] = (['blue', 'red'] as Side[]).map((side) => {
    const o = runner.get(ids[side]);
    const rep = o?.report;
    const folded = new Map<string, number>();
    for (const l of rep?.logs ?? []) {
      const k = l.replace(/\b(Bleu|Rouge)(Garde|Archer)\d+\b/g, '<bot>').replace(/-?\d+(\.\d+)?/g, '#').slice(0, 160);
      folded.set(k, (folded.get(k) ?? 0) + 1);
    }
    return {
      side,
      id: ids[side],
      command: (side === 'blue' ? BLUE_ORDER : RED_ORDER).join(' '),
      tokens: side === 'blue' ? BLUE_ORDER.slice(1) : RED_ORDER.slice(1),
      status: String(o?.status ?? rep?.status ?? '?'),
      ...(rep?.result ? { result: rep.result } : {}),
      ...(rep?.error ? { error: `${rep.error.name}: ${rep.error.message}` } : {}),
      bots: rep?.bots.length ?? 0,
      logLines: rep?.logs.length ?? 0,
      topLogs: [...folded.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([line, count]) => ({ line, count })),
      failures: rep?.failures.length ?? 0,
    };
  });
  await runner.stopAll('stopped');
  pool.removeListener('gone', onGone);
  for (const off of tickers) off();
  for (const line of await watch.poll()) if (DEATH_RE.test(line)) deathLines.push(line);
  const server = await watch.end();

  // The server log names the killer: attach it to each death (the first matching line for that victim).
  for (const line of deathLines) {
    const m = DEATH_RE.exec(line);
    if (!m) continue;
    const d = dead.get(m[1] as string);
    if (!d || d.line) continue;
    d.line = line.replace(/^.*?(?:\]: |\(Minecraft\) )/, '');
    d.how = /slain/.test(m[2] as string) ? 'melee' : /shot/.test(m[2] as string) ? 'arrow' : (m[2] as string);
    if (m[3] && SIDE_OF.has(m[3])) d.by = m[3];
  }
  const deaths = [...dead.values()].sort((a, b) => a.t - b.t);
  const byHow: Record<string, number> = {};
  const bySide: Record<Side, number> = { blue: 0, red: 0 };
  let friendly = 0;
  for (const d of deaths) {
    byHow[d.how ?? '?'] = (byHow[d.how ?? '?'] ?? 0) + 1;
    const ks = d.by ? SIDE_OF.get(d.by) : undefined;
    if (ks) bySide[ks]++;
    if (ks && ks === d.side) friendly++;
  }
  const winner: RoundResult['winner'] = survivors.blue > survivors.red ? 'blue' : survivors.red > survivors.blue ? 'red' : 'draw';
  return { round, profiled, ...(profile ? { profile } : {}), seconds, ended, winner, survivors, hpLeft, deaths, kills: { byHow, bySide, friendly }, process: proc, bots, server, helpers, orders, timeline };
}

// -- reporting --------------------------------------------------------------------------------------------------

function fmt(p: { x: number; y: number; z: number } | undefined | null): string {
  return p ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : '?';
}

function roundLine(r: RoundResult): string {
  const p = r.process;
  return (
    `round ${r.round}: ${r.ended} after ${r.seconds} s, winner ${r.winner} (survivors blue ${r.survivors.blue}, red ${r.survivors.red}); ` +
    `ELU ${p.elu}, loop p50/p99/max ${p.loop.p50}/${p.loop.p99}/${p.loop.max} ms, CPU ${p.cpuPct} %, ticks/s min ${r.bots.ticksPerSec.min} mean ${r.bots.ticksPerSec.mean}, ` +
    `A* ${p.share.astar} %, physics ${p.share.physics} %, look-ahead ${p.share.lookahead} %, decode ${p.share.decode} %`
  );
}

function summaryMd(o: { env: Record<string, unknown> & { armies: { guards: number; archers: number; blue: string; red: string } }; idle: unknown; rounds: RoundResult[] }): string {
  const e = o.env;
  const L: string[] = [
    `# Fight benchmark — ${e.label as string} (${e.at as string})`,
    '',
    `${e.armies.guards} guards + ${e.armies.archers} archers a side. Blue « ${e.armies.blue} », red « ${e.armies.red} ». ` +
      `${(e.hawkeyeEvery as number) > 1 ? `**Experiment: hawkEye aims one tick in ${e.hawkeyeEvery as number}.** ` : ''}` +
      `Friendly-fire rule: ${e.friendlyFireRule ? 'on (the dev mod is connected)' : 'OFF (--no-mod)'}. Node ${e.node as string}, ${e.cpu as string} (${e.logicalCpus as number} threads), pathfinding ${JSON.stringify(e.pathfinding)}.`,
    '',
  ];
  const idle = o.idle as { seconds: number; process: ProcessPhase; bots: BotPhase; server: ServerSide } | null;
  L.push('## Rounds', '', '| phase | s | ended | survivors B/R | deaths (melee/arrow/other) | friendly kills | ELU | loop p50/p99/max ms | CPU % | ticks/s min/mean | A* % | physics % | look-ahead % | decode+inflate % | server tick mean/p95 ms | Can\'t keep up | RSS MB |', '|' + '---|'.repeat(17));
  if (idle) {
    const p = idle.process;
    L.push(`| idle | ${idle.seconds} | | | | | ${p.elu} | ${p.loop.p50}/${p.loop.p99}/${p.loop.max} | ${p.cpuPct} | ${idle.bots.ticksPerSec.min}/${idle.bots.ticksPerSec.mean} | ${p.share.astar} | ${p.share.physics} | ${p.share.lookahead} | ${r1(p.share.decode + p.share.inflate)} | ${idle.server.tick?.mean ?? '?'}/${idle.server.tick?.p95 ?? '?'} | ${idle.server.keepUp.count} | ${p.rssMaxMb} |`);
  }
  for (const r of o.rounds) {
    const p = r.process;
    const k = r.kills.byHow;
    const other = r.deaths.length - (k.melee ?? 0) - (k.arrow ?? 0);
    L.push(
      `| round ${r.round}${r.profiled ? ' (profiled)' : ''} | ${r.seconds} | ${r.ended} | ${r.survivors.blue}/${r.survivors.red} | ${r.deaths.length} (${k.melee ?? 0}/${k.arrow ?? 0}/${other}) | ${r.kills.friendly} | ${p.elu} | ${p.loop.p50}/${p.loop.p99}/${p.loop.max} | ${p.cpuPct} | ${r.bots.ticksPerSec.min}/${r.bots.ticksPerSec.mean} | ${p.share.astar} | ${p.share.physics} | ${p.share.lookahead} | ${r1(p.share.decode + p.share.inflate)} | ${r.server.tick?.mean ?? '?'}/${r.server.tick?.p95 ?? '?'} | ${r.server.keepUp.count} | ${p.rssMaxMb} |`,
    );
  }
  L.push('');
  for (const r of o.rounds) {
    L.push(`## Round ${r.round}${r.profiled ? ' (profiled: its timings are slower)' : ''}`, '');
    L.push(`Path searches: ${r.bots.path.success} ok, ${r.bots.path.noPath} no path, ${r.bots.path.timeout} timeouts; planning p50/p95/max ${r.bots.path.planMs.p50}/${r.bots.path.planMs.p95}/${r.bots.path.planMs.max} ms; resets ${JSON.stringify(r.bots.path.resets)}. Packets ${r.bots.packetsPerSecPerBot}/s and ${r.bots.kbPerSecPerBot} KB/s per bot.`, '');
    L.push('### Helpers as the commands call them (all bots)', '', '| helper | calls | ended | wall p50 / p95 / max ms | wall total s | sync total ms | sync mean µs | sync max ms |', '|---|---|---|---|---|---|---|---|');
    for (const h of r.helpers.filter((x) => x.group === 'all')) {
      const ends = Object.entries(h.ends).slice(0, 3).map(([k, v]) => `${k} ${v}`).join('; ');
      L.push(`| ${h.helper} | ${h.calls} | ${ends.replace(/\|/g, '/')} | ${h.wall.p50} / ${h.wall.p95} / ${h.wall.max} | ${r1(h.wall.totalMs / 1000)} | ${h.sync.totalMs} | ${h.sync.meanUs} | ${h.sync.maxMs} |`);
    }
    L.push('', '### Per army', '', '| helper | army | calls | wall p50 / p95 ms | sync total ms |', '|---|---|---|---|---|');
    for (const h of r.helpers.filter((x) => x.group !== 'all')) L.push(`| ${h.helper} | ${h.group} | ${h.calls} | ${h.wall.p50} / ${h.wall.p95} | ${h.sync.totalMs} |`);
    L.push('', '### Deaths', '', '| t s | bot | killed by | how |', '|---|---|---|---|');
    for (const d of r.deaths) L.push(`| ${d.t} | ${d.name} | ${d.by ?? '?'} | ${d.how ?? '?'} |`);
    L.push('', '### Orders', '');
    for (const ord of r.orders) {
      L.push(`- **${ord.side}** #${ord.id} « ${ord.command} »: ${ord.status}${ord.result ? ` — ${ord.result}` : ''}${ord.error ? ` — ${ord.error}` : ''}; ${ord.bots} bots, ${ord.logLines} log lines, ${ord.failures} failures`);
      for (const l of ord.topLogs) L.push(`  - ${l.count} × \`${l.line.replace(/`/g, "'")}\``);
    }
    L.push('', '### Timeline (every 5 s)', '', '| t s | alive B/R | hp B/R | ELU | loop max ms | CPU % | A* ms | physics ms | look-ahead ms | decode ms | ticks/bot | entities/bot | shoot | attack | follow | nearest* |', '|' + '---|'.repeat(16));
    for (const row of r.timeline.filter((_, i) => i % 5 === 4 || i === r.timeline.length - 1)) {
      const c = row.calls;
      L.push(
        `| ${row.t} | ${row.alive.blue}/${row.alive.red} | ${row.hp.blue}/${row.hp.red} | ${row.elu} | ${row.loopMaxMs} | ${row.cpuPct} | ${row.ms.astar} | ${row.ms.physics} | ${row.ms.lookahead} | ${row.ms.decode} | ${row.ticks} | ${row.entities} | ${c.shoot ?? 0} | ${c.attack ?? 0} | ${c.follow ?? 0} | ${(c.nearestEntity ?? 0) + (c.nearestHostile ?? 0)} |`,
      );
    }
    L.push('');
  }
  const profiles = [...(idle && (o.idle as { profile?: string }).profile ? [(o.idle as { profile: string }).profile] : []), ...o.rounds.filter((r) => r.profile).map((r) => r.profile as string)];
  if (profiles.length) {
    L.push('## CPU profiles', '');
    for (const p of profiles) {
      try {
        L.push(render(summarise(join(runDir, p))));
      } catch (err) {
        L.push(`(${p}: ${(err as Error).message})`);
      }
    }
  }
  return L.join('\n');
}

const isMain = process.argv[1] && /[\\/]fight\.ts$/.test(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    logger.error('fight', `crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(2);
  });
}
