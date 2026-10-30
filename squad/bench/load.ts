// The load benchmark (docs/31): the real runtime in process (as live-tests/run.ts), N real Mineflayer bots on the
// DEV server, four phases per N held for `--seconds` each:
//   idle    the bots stand still;
//   follow  bot 0 walks short random legs, the others run the stock `follow` with bot 0 as their commander;
//   walk    every bot walks to random points 20–60 blocks away (bench-walk: the real goTo helper, in a loop);
//   gather  the stock `gather _log 1024` (squad.tasks + mineBlock + collectblock + claims), stopped at the end.
// N ramps up (the bots of the previous N stay connected); N = 0 measures the process with no bot at all. Logins use
// the runtime's stagger and are measured as a "login" phase of their own.
//
//   cd squad && npm run bench:load -- --ns 0,1,5,10,20,30 --label baseline
//
// Options: --ns, --phases idle,follow,walk,gather, --seconds 60, --label, --profile 10,30 (a CPU profile per phase at
// those N), --stagger <ms> (default: the runtime's 4000), --center x,z (default: the nearest forest to spawn),
// --no-pregen; experiments (bench-only, the runtime's defaults stay as they are): --tick-timeout, --think-timeout,
// --search-radius, --plugins all|none|-autoEat,-hawkEye…, --view short|normal|tiny|<chunks>, --movements canDig=false,…,
// --astar-budget <ms per 50 ms> (the runtime's pathfinding.astarBudgetMs), --workers <N> (the runtime's
// pathfinding.workers, the pathfinding worker pool), --think-on-compute, --lookahead-cap <ticks>, --lookahead-memo <ticks>,
// --lookahead-blockcache, --stuck-ticks, --mcdata-memo, --cheap-varint, --astar-blockcache, --astar-blockcache-world.
// The server is read from SERVER_PROPERTIES (default ../run/server.properties). The production server is refused.

import './lib/instrument'; // first: it wraps prismarine-physics before mineflayer loads it

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem } from 'node:os';

import mineflayer, { type Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import { parseConfig, DEFAULT_LIMITS } from '../src/config';
import { start, type Started } from '../src/main';
import { boundPathfinder, type AbortableBot } from '../src/bots/hardening';
import { loadPlugins, pathfinder, type PluginSet } from '../src/bots/plugins';
import { keepDecodersAlive, RECIPES_AS_BYTES } from '../src/bots/protocol';
import type { SpawnRequest } from '../src/bots/pool';
import { logger } from '../src/logger';
import type { Player } from '../src/roster';
import { EMPTY_SNAPSHOT, type Snapshot } from '../src/types';
import { Rcon } from '../live-tests/rcon';
import { setAstarBlockCache, setLookahead, setThinkOnCompute } from './lib/instrument';
import { BotMeters, dist, ProcessProbe, r1 } from './lib/probe';
import { keepUpLines, LogTail, pidOnPort, processCpu, readProps, tickQuery, type TickSample } from './lib/server';
import { summaryLine, table, type Phase, type PhaseResult, type ServerPhase } from './lib/table';

const here = dirname(fileURLToPath(import.meta.url));

// -- options ---------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const flag = (name: string): boolean => argv.includes(`--${name}`);
const list = (s: string | undefined, d: number[]): number[] => (s ? s.split(',').map(Number) : d);

const NS = list(opt('ns'), [0, 1, 5, 10, 20, 30]).sort((a, b) => a - b);
const PHASES = (opt('phases') ?? 'idle,follow,walk,gather').split(',') as Phase[];
const SECONDS = Number(opt('seconds') ?? 60);
const PROFILE_NS = new Set(list(opt('profile'), []));
const LABEL = opt('label') ?? 'run';
const STAGGER = Number(opt('stagger') ?? 4_000);
const PREGEN = !flag('no-pregen');
const VARIANT = {
  tickTimeout: Number(opt('tick-timeout') ?? 10),
  thinkTimeout: Number(opt('think-timeout') ?? 5_000),
  searchRadius: Number(opt('search-radius') ?? 64),
  plugins: opt('plugins') ?? 'all',
  view: (/^\d+$/.test(opt('view') ?? '') ? Number(opt('view')) : (opt('view') ?? 'short')) as 'short' | 'normal' | 'tiny' | number,
  /** Overrides of the runtime's Movements (hardening.defaultMovements), e.g. canDig=false,allow1by1towers=false. */
  movements: Object.fromEntries((opt('movements') ?? '').split(',').filter(Boolean).map((kv) => kv.split('=')).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : Number(v)])) as Record<string, unknown>,
  /** The runtime's own A* budget (config pathfinding.astarBudgetMs, the patched AStar.setBudget), not a prototype. */
  astarBudget: Number(opt('astar-budget') ?? 0),
  /** The runtime's pathfinding worker pool (config pathfinding.workers; capped at the cores but one). */
  workers: Number(opt('workers') ?? 0),
  thinkOnCompute: flag('think-on-compute'),
  lookaheadCap: Number(opt('lookahead-cap') ?? 0),
  lookaheadMemo: Number(opt('lookahead-memo') ?? 0),
  lookaheadBlockCache: flag('lookahead-blockcache'),
  /** Applied by lib/instrument.ts when it loads (see there). */
  stuckTicks: flag('stuck-ticks'),
  mcdataMemo: flag('mcdata-memo'),
  cheapVarint: flag('cheap-varint'),
  /** --astar-blockcache (per physics tick) or --astar-blockcache-world (until the block changes). */
  astarBlockCache: (flag('astar-blockcache-world') ? 'world' : flag('astar-blockcache') ? 'tick' : false) as false | 'tick' | 'world',
};

// -- the server --------------------------------------------------------------------------------------------------

const PROPS_FILE = process.env.SERVER_PROPERTIES ? resolve(process.env.SERVER_PROPERTIES) : resolve(here, '..', '..', 'run', 'server.properties');
const props = readProps(PROPS_FILE);
const MC_PORT = Number(props['server-port'] ?? 25599);
if (basename(dirname(PROPS_FILE)) === 'server' || MC_PORT === 25565) {
  throw new Error(`refusing to load-test ${PROPS_FILE} (port ${MC_PORT}): the production server is never load-tested. Use the dev server (run/).`);
}
const RCON_PORT = Number(props['rcon.port'] ?? 25575);
const RCON_PASSWORD = props['rcon.password'] ?? '';
const MAX_PLAYERS = Number(props['max-players'] ?? 20);

const TOKEN = 'bench-token';
const OWNER: Player = { uuid: '33333333-3333-3333-3333-333333333333', name: 'BenchBoss' };
const BOTS = Array.from({ length: 30 }, (_, i) => `Bench${String(i).padStart(2, '0')}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- the bench's own counters, shared with bench commands (they run in this realm) -------------------------------

interface WalkStats {
  legs: Record<string, number>;
  legMs: number[];
  legBlocks: number[];
  examples: string[];
}
const walk: WalkStats = { legs: {}, legMs: [], legBlocks: [], examples: [] };
(globalThis as Record<string, unknown>).__squadBench = {
  leg(kind: string, ms: number, blocks: number, message?: string) {
    walk.legs[kind] = (walk.legs[kind] ?? 0) + 1;
    if (kind === 'ok') {
      walk.legMs.push(ms);
      walk.legBlocks.push(blocks);
    } else if (message && walk.examples.length < 5) walk.examples.push(message.slice(0, 240));
  },
};
function resetWalk(): void {
  walk.legs = {};
  walk.legMs = [];
  walk.legBlocks = [];
  walk.examples = [];
}

let deafTrips = 0;
let skippedPackets = 0;
const warn = logger.warn;
logger.warn = (actor, msg) => {
  if (msg.startsWith('deaf:')) deafTrips++;
  warn(actor, msg);
};

// -- bots: the runtime's createBot and setup, with the experiment's overrides ----------------------------------

function createBot(req: SpawnRequest): Bot {
  return mineflayer.createBot({
    host: req.host,
    port: req.port,
    username: req.username,
    version: req.version,
    viewDistance: VARIANT.view,
    checkTimeoutInterval: req.checkTimeoutInterval,
    plugins: { pathfinder },
    customPackets: RECIPES_AS_BYTES,
  } as Parameters<typeof mineflayer.createBot>[0]);
}

const noop = (): void => undefined;
function pluginOverrides(): Partial<PluginSet> {
  const all: Array<keyof PluginSet> = ['pvp', 'armorManager', 'tool', 'collectBlock', 'hawkEye', 'autoEat'];
  if (VARIANT.plugins === 'all') return {};
  if (VARIANT.plugins === 'none') return Object.fromEntries(all.map((k) => [k, noop]));
  const off = VARIANT.plugins.split(',').filter((s) => s.startsWith('-')).map((s) => s.slice(1));
  return Object.fromEntries(off.map((k) => [k, noop]));
}

function setup(bot: Bot): void {
  boundPathfinder(bot as unknown as AbortableBot);
  const pf = (bot as unknown as AbortableBot).pathfinder;
  if (pf) {
    pf.tickTimeout = VARIANT.tickTimeout;
    pf.thinkTimeout = VARIANT.thinkTimeout;
    pf.searchRadius = VARIANT.searchRadius;
  }
  loadPlugins(bot, { plugins: pluginOverrides() });
}

// -- results ----------------------------------------------------------------------------------------------------

const results: PhaseResult[] = [];
const runDir = join(here, '.runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${LABEL}`);
mkdirSync(join(runDir, 'profiles'), { recursive: true });

// -- main -------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (props['enable-rcon'] !== 'true') throw new Error(`RCON is off in ${PROPS_FILE} (enable-rcon=true)`);
  const maxN = Math.max(...NS);
  if (maxN > MAX_PLAYERS) throw new Error(`max-players=${MAX_PLAYERS} in ${PROPS_FILE}: raise it to at least ${maxN} for this run`);
  if (maxN > BOTS.length) throw new Error(`at most ${BOTS.length} bots`);
  setThinkOnCompute(VARIANT.thinkOnCompute);
  setAstarBlockCache(VARIANT.astarBlockCache);
  setLookahead({ cap: VARIANT.lookaheadCap, memoTicks: VARIANT.lookaheadMemo, blockCache: VARIANT.lookaheadBlockCache });

  const rcon = new Rcon('127.0.0.1', RCON_PORT, RCON_PASSWORD);
  await rcon.connect();
  const serverPid = await pidOnPort(MC_PORT);
  const seed = (await rcon.command('seed')).trim();
  log(`server ${PROPS_FILE} (port ${MC_PORT}, pid ${serverPid ?? '?'}), ${seed}`);
  for (const c of ['time set day', 'gamerule doDaylightCycle false', 'gamerule doMobSpawning false', 'gamerule doWeatherCycle false', 'weather clear', 'difficulty easy']) {
    await rcon.command(c);
  }

  const cfg = parseConfig(
    { minecraft: { port: MC_PORT }, port: 0, dataDir: join(runDir, 'data'), loginStaggerMs: STAGGER, limits: { ...DEFAULT_LIMITS, maxBots: 64 }, pathfinding: { astarBudgetMs: VARIANT.astarBudget, workers: VARIANT.workers } },
    { PAULSBRAWLS_SQUAD_TOKEN: TOKEN },
  );
  const rt = await start(cfg, { connectBots: true, installGuards: true, pool: { createBot, setup } });
  keepDecodersAlive(() => skippedPackets++);
  const { pool, store } = rt.service.deps;
  const meters = new BotMeters();
  pool.on('online', (name: string, bot: Bot) => {
    meters.attach(name, bot);
    // The pool restores this same object after every order, so an override made here holds for the whole run.
    const m = pool.movements(name) as Record<string, unknown> | undefined;
    if (m) Object.assign(m, VARIANT.movements);
  });
  store.addVersion(OWNER, 'bench-walk', readFileSync(join(here, 'commands', 'bench-walk.mjs'), 'utf8'), { request: 'bench', summary: 'bench-walk' });
  // The runtime warms the typecheck worker 2 s after boot (~5 s of compiler work on its own thread): let it finish.
  await sleep(15_000);

  const env = {
    label: LABEL,
    at: new Date().toISOString(),
    variant: VARIANT,
    stagger: STAGGER,
    seconds: SECONDS,
    node: process.version,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramGb: Math.round(totalmem() / 1073741824),
    server: { props: PROPS_FILE, port: MC_PORT, viewDistance: props['view-distance'], simulationDistance: props['simulation-distance'], compression: props['network-compression-threshold'], seed },
    center: null as null | { x: number; z: number },
  };
  const save = (): void => writeFileSync(join(runDir, 'results.json'), JSON.stringify({ env, results }, null, 2));

  try {
    let online = 0;
    let center: { x: number; z: number } | null = null;
    for (const n of NS) {
      if (n > online) {
        await login(rt, rcon, meters, online, n, serverPid);
        online = n;
        if (!center) {
          center = await findCenter(rcon);
          env.center = center;
          log(`centre (nearest forest to spawn): ${center.x}, ${center.z}`);
          if (PREGEN) await pregenerate(rcon, center);
        }
      }
      for (const phase of n === 0 ? (['idle'] as Phase[]) : PHASES) {
        if (n > 0) await place(rt, rcon, center as { x: number; z: number }, n);
        const r: PhaseResult & { pathWorkers?: unknown } = await runPhase(rt, rcon, meters, n, phase, center, serverPid);
        if (rt.pathWorkers) {
          // Cumulative since the start: searches offloaded and answered, and why any stayed on the main thread.
          const st = rt.pathWorkers.stats();
          r.pathWorkers = st;
          log(`path workers: ${st.alive}/${st.workers} alive, ${st.chunks} chunks mirrored, ${st.offloaded} offloaded, ${st.done} answered, fallbacks ${JSON.stringify(st.fallbacks)}, restarts ${st.restarts}`);
        }
        results.push(r);
        save();
        log(summaryLine(r));
      }
    }
  } finally {
    save();
    writeFileSync(join(runDir, 'summary.md'), table(results));
    await rt.stop();
    rcon.close();
  }
  log(`done: ${runDir}`);
  process.exit(0);
}

function log(line: string): void {
  logger.info('bench', line);
}

/** Spawn bots `from`..`to`-1 through the control API (the stagger applies) and measure the logins as a phase. */
async function login(rt: Started, rcon: Rcon, meters: BotMeters, from: number, to: number, serverPid: number | undefined): Promise<void> {
  const names = BOTS.slice(from, to);
  const { pool } = rt.service.deps;
  const watch = await serverWatch(rcon, serverPid);
  const probe = new ProcessProbe();
  meters.reset();
  probe.start();
  for (const name of names) {
    const r = await api(rt, '/api/bots/spawn', { by: OWNER, admin: true, name, owners: [OWNER] });
    if (!r.ok) throw new Error(`spawn ${name}: ${r.text}`);
  }
  const deadline = Date.now() + names.length * (STAGGER + 15_000) + 30_000;
  while (!names.every((b) => pool.status(b) === 'online')) {
    if (Date.now() > deadline) throw new Error(`bots not online: ${names.filter((b) => pool.status(b) !== 'online').join(', ')}`);
    await watch.poll();
    await sleep(500);
  }
  const t = Date.now() + 10_000; // the last login's chunks
  while (Date.now() < t) {
    await watch.poll();
    await sleep(500);
  }
  const proc = probe.stop();
  const server = await watch.end(proc.seconds);
  results.push({ n: to, phase: 'login', process: proc, bots: meters.read(BOTS.slice(0, to), proc.seconds), server, deafTrips: takeDeaf(), skippedPackets: takeSkipped() });
  log(summaryLine(results[results.length - 1] as PhaseResult));
  for (const name of names) {
    await rcon.command(`clear ${name}`);
    await rcon.command(`give ${name} iron_axe`);
    await rcon.command(`give ${name} iron_pickaxe`);
    await rcon.command(`give ${name} bread 32`);
  }
}

function takeDeaf(): number {
  const d = deafTrips;
  deafTrips = 0;
  return d;
}
function takeSkipped(): number {
  const s = skippedPackets;
  skippedPackets = 0;
  return s;
}

async function api(rt: Started, path: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await fetch(`http://127.0.0.1:${rt.port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    return (await r.json()) as { ok: boolean; text: string };
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`POST ${path}: ${(e as Error).message}${cause ? ` (${cause.code ?? ''} ${cause.message ?? ''})` : ''}`);
  }
}

/** The nearest forest to the world spawn (`locate biome`), so `gather` has logs and walks cross a canopy (§16). */
async function findCenter(rcon: Rcon): Promise<{ x: number; z: number }> {
  const c = opt('center');
  if (c) {
    const [x, z] = c.split(',').map(Number);
    return { x: x as number, z: z as number };
  }
  const text = await rcon.command('locate biome minecraft:forest');
  const m = /\[(-?\d+), [^,]+, (-?\d+)\]/.exec(text);
  if (!m) throw new Error(`locate biome minecraft:forest: ${text}`);
  return { x: Number(m[1]), z: Number(m[2]) };
}

/** Walk Bench00 over a 5×5 grid (80 blocks apart) so the server generates every chunk the phases can reach. */
async function pregenerate(rcon: Rcon, c: { x: number; z: number }): Promise<void> {
  log('pre-generating the area (25 stops)');
  for (const dx of [-160, -80, 0, 80, 160]) {
    for (const dz of [-160, -80, 0, 80, 160]) {
      await rcon.command(`spreadplayers ${c.x + dx} ${c.z + dz} 0 1 false Bench00`);
      await sleep(2_500);
    }
  }
}

/** Put bots 0..n-1 on a ring around the centre, on the ground (not on the canopy), and let them settle. */
async function place(rt: Started, rcon: Rcon, c: { x: number; z: number }, n: number): Promise<void> {
  const { pool } = rt.service.deps;
  await rt.service.deps.runner.stopAll('stopped');
  const lead = pool.bot('Bench00') as Bot;
  if (!lead.entity || lead.entity.position.distanceTo(new Vec3(c.x, lead.entity.position.y, c.z)) > 32) {
    await rcon.command(`spreadplayers ${c.x} ${c.z} 0 2 false Bench00`);
    await sleep(3_000);
  }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const r = 3 + (i % 3) * 2;
    const spot = groundNear(lead, Math.floor(c.x + Math.cos(a) * r), Math.floor(c.z + Math.sin(a) * r));
    const name = BOTS[i] as string;
    if (spot) await rcon.command(`tp ${name} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5}`);
    else await rcon.command(`spreadplayers ${c.x} ${c.z} 1 6 false ${name}`);
  }
  await sleep(4_000);
}

/** A standable ground spot (not leaves, not a log) in or near column (x, z), read from a bot's loaded chunks. */
function groundNear(bot: Bot, x: number, z: number): Vec3 | null {
  const y0 = Math.floor(bot.entity?.position?.y ?? 70);
  for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [2, 2], [-2, -2], [2, -2], [-2, 2]] as const) {
    for (let y = y0 + 30; y > y0 - 30; y--) {
      const b = bot.blockAt(new Vec3(x + dx, y, z + dz));
      if (!b || b.boundingBox !== 'block' || /leaves|_log/.test(b.name)) continue;
      const a1 = bot.blockAt(new Vec3(x + dx, y + 1, z + dz));
      const a2 = bot.blockAt(new Vec3(x + dx, y + 2, z + dz));
      if (a1 && a2 && a1.boundingBox === 'empty' && a2.boundingBox === 'empty' && !/water|lava/.test(a1.name)) return new Vec3(x + dx, y + 1, z + dz);
      break;
    }
  }
  return null;
}

interface Watch {
  poll(): Promise<void>;
  end(seconds: number): Promise<ServerPhase>;
}

/** The server side of a phase: `tick query` every 5 s, its log's "Can't keep up!", the JVM's CPU. */
async function serverWatch(rcon: Rcon, pid: number | undefined): Promise<Watch> {
  const tail = LogTail.forServer(PROPS_FILE);
  tail.read();
  const cpu0 = pid ? await processCpu(pid) : undefined;
  const t0 = Date.now();
  const ticks: TickSample[] = [];
  let last = 0;
  const poll = async (): Promise<void> => {
    if (Date.now() - last < 5_000) return;
    last = Date.now();
    const s = await tickQuery(rcon).catch(() => undefined);
    if (s) ticks.push(s);
  };
  return {
    poll,
    async end() {
      const s = await tickQuery(rcon).catch(() => undefined);
      if (s) ticks.push(s);
      const cpu1 = pid ? await processCpu(pid) : undefined;
      const wall = Date.now() - t0;
      const mean = (f: (t: TickSample) => number): number => r1(ticks.reduce((a, t) => a + f(t), 0) / Math.max(1, ticks.length));
      return {
        tick: ticks.length ? { mean: mean((t) => t.meanMs), p50: mean((t) => t.p50), p95: mean((t) => t.p95), p99Max: r1(Math.max(...ticks.map((t) => t.p99))), samples: ticks.length } : null,
        keepUp: keepUpLines(tail.read()),
        cpuPct: cpu0 && cpu1 ? r1(((cpu1.cpuMs - cpu0.cpuMs) / wall) * 100) : null,
        rssMb: cpu1 ? Math.round(cpu1.rssMb) : null,
      };
    },
  };
}

async function runPhase(rt: Started, rcon: Rcon, meters: BotMeters, n: number, phase: Phase, center: { x: number; z: number } | null, serverPid: number | undefined): Promise<PhaseResult> {
  const { pool, runner } = rt.service.deps;
  const names = BOTS.slice(0, n);
  const logsOf = (): number => names.reduce((s, b) => s + (pool.bot(b)?.inventory.items().filter((i) => i.name.endsWith('_log')).reduce((a, i) => a + i.count, 0) ?? 0), 0);
  const logs0 = logsOf();
  resetWalk();
  takeDeaf();
  takeSkipped();
  const watch = await serverWatch(rcon, serverPid);
  const probe = new ProcessProbe();
  meters.reset();

  let session: Session | undefined;
  if (PROFILE_NS.has(n)) {
    session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 1_000 });
    await session.post('Profiler.start');
  }
  probe.start();

  const snap: Snapshot = { ...EMPTY_SNAPSHOT, position: { x: center?.x ?? 0, y: 64, z: center?.z ?? 0 } };
  const started: string[] = [];
  const order = async (commander: Player, command: string, tokens: string[], filters: string[]): Promise<void> => {
    const r = await runner.start({ commander, command, tokens, filters, snap });
    if (!r.ok) throw new Error(`${command}: ${r.text}`);
    started.push(r.orderId);
  };
  const c = center ?? { x: 0, z: 0 };
  if (phase === 'follow') {
    await order(OWNER, 'bench-walk', [`cx=${c.x}`, `cz=${c.z}`, 'min=8', 'max=16', 'keep=20'], ['Bench00']);
    if (n > 1) await order({ uuid: OWNER.uuid, name: 'Bench00' }, 'follow', ['range=3'], names.slice(1));
  } else if (phase === 'walk') {
    await order(OWNER, 'bench-walk', [`cx=${c.x}`, `cz=${c.z}`], names);
  } else if (phase === 'gather') {
    await order(OWNER, 'gather', ['_log', '1024'], names);
  }

  const end = Date.now() + SECONDS * 1000;
  while (Date.now() < end) {
    await watch.poll();
    await sleep(Math.min(1_000, Math.max(0, end - Date.now())));
  }
  const proc = probe.stop();
  const server = await watch.end(proc.seconds);
  const bots = n > 0 ? meters.read(names, proc.seconds) : null;
  let profile: string | undefined;
  if (session) {
    const { profile: p } = await session.post('Profiler.stop');
    profile = join('profiles', `n${n}-${phase}.cpuprofile`);
    writeFileSync(join(runDir, profile), JSON.stringify(p));
    session.disconnect();
  }

  const result: PhaseResult = { n, phase, process: proc, bots, server, deafTrips: takeDeaf(), skippedPackets: takeSkipped(), ...(profile ? { profile } : {}) };
  if (phase === 'walk' || phase === 'follow') {
    result.walk = { legs: { ...walk.legs }, legMs: dist(walk.legMs), blocksPerLeg: dist(walk.legBlocks), examples: [...walk.examples] };
  }
  if (phase === 'gather') {
    const o = runner.get(started[0] as string);
    const report = o?.report;
    result.gather = {
      logsMined: logsOf() - logs0,
      status: report?.status ?? '?',
      failures: report?.failures.length ?? 0,
      failureExamples: (report?.failures ?? []).slice(0, 4).map((f) => `${f.bot}: ${f.error}`.slice(0, 240)),
    };
  }
  await runner.stopAll('stopped');
  return result;
}

const isMain = process.argv[1] && /[\\/]load\.ts$/.test(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    logger.error('bench', `crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(2);
  });
}
