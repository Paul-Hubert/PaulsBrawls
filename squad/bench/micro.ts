// Micro-benchmarks of Squad's own overhead (docs/31 §1), no Minecraft server: the real Order, guard, compiler,
// squad.tasks, journal and SSE code, on the test fakes. Each case runs warm-up rounds, then `ROUNDS` timed rounds;
// the result is the median ns (or µs, ms) per operation with the fastest and slowest round.
//
//   cd squad && npm run bench:micro            (results also in bench/.runs/<ts>-micro/micro.json)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { cpus } from 'node:os';
import vm from 'node:vm';

import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';

import { compile } from '../src/script/compile';
import { buildScope } from '../src/api/scope';
import { nearestEntity } from '../src/api/helpers';
import { Journal } from '../src/journal/journal';
import { SquadHttp } from '../src/http/server';
import type { SquadService } from '../src/service';
import type { Order } from '../src/orders/order';
import type { OrderReport } from '../src/types';
import { harness, PAUL, until } from '../tests/fakes/harness';

const here = dirname(fileURLToPath(import.meta.url));
const ROUNDS = 7;
const out: Record<string, { unit: string; median: number; min: number; max: number; note?: string }> = {};

function bench(name: string, ops: number, unit: 'ns' | 'µs' | 'ms', fn: () => void, note?: string): void {
  const scale = unit === 'ns' ? 1e6 : unit === 'µs' ? 1e3 : 1;
  for (let i = 0; i < 2; i++) fn();
  const per: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t = performance.now();
    fn();
    per.push(((performance.now() - t) * scale) / ops);
  }
  record(name, unit, per, note);
}

async function benchAsync(name: string, ops: number, unit: 'ns' | 'µs' | 'ms', fn: () => Promise<void>, note?: string): Promise<void> {
  const scale = unit === 'ns' ? 1e6 : unit === 'µs' ? 1e3 : 1;
  for (let i = 0; i < 2; i++) await fn();
  const per: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t = performance.now();
    await fn();
    per.push(((performance.now() - t) * scale) / ops);
  }
  record(name, unit, per, note);
}

function record(name: string, unit: string, per: number[], note?: string): void {
  per.sort((a, b) => a - b);
  const r = (v: number): number => (v >= 100 ? Math.round(v) : Math.round(v * 100) / 100);
  out[name] = { unit, median: r(per[Math.floor(per.length / 2)] as number), min: r(per[0] as number), max: r(per[per.length - 1] as number), ...(note ? { note } : {}) };
  process.stdout.write(`${name.padEnd(58)} ${String(out[name]!.median).padStart(10)} ${unit}/op  (${out[name]!.min} … ${out[name]!.max})\n`);
}

/** A running order on fake bots (the real Order, leases and guard), held open until stopped. */
async function heldOrder(bots: number): Promise<{ order: Order; h: ReturnType<typeof harness> }> {
  const h = harness();
  for (let i = 0; i < bots; i++) h.bot(`Bot${i}`, [PAUL]);
  h.command(PAUL, 'hold', 'export const manifest = { summary: "hold", duration: "until-stopped" };\nexport default async function (squad) { await squad.untilStopped(); }');
  const r = await h.order(PAUL, 'hold');
  if (!r.ok) throw new Error(r.text);
  const order = h.runner.get(r.orderId) as Order;
  await until(() => order.bots.length === bots);
  return { order, h };
}

async function main(): Promise<void> {
  const runDir = join(here, '.runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-micro`);
  mkdirSync(runDir, { recursive: true });
  process.stdout.write(`node ${process.version}, ${cpus()[0]?.model}, ${cpus().length} logical CPUs\n\n`);

  // -- 1. the lease-guarded proxy (orders/guard.ts) ------------------------------------------------------------
  {
    const { order, h } = await heldOrder(1);
    const guard = order.bots[0] as unknown as Record<string, unknown> & Bot;
    const real = h.pool.bots.get("Bot0") as unknown as Record<string, unknown> & Bot;
    const N = 1_000_000;
    const p = new Vec3(1, 2, 3);
    let sink: unknown;
    bench('guard: raw bot.blockAt(p)', N, 'ns', () => {
      for (let i = 0; i < N; i++) sink = real.blockAt(p);
    });
    bench('guard: guarded bot.blockAt(p) (lease check + unwrap args)', N, 'ns', () => {
      for (let i = 0; i < N; i++) sink = guard.blockAt(p);
    });
    bench('guard: raw bot.entity (property read)', N, 'ns', () => {
      for (let i = 0; i < N; i++) sink = real.entity;
    });
    bench('guard: guarded bot.entity (Proxy get trap)', N, 'ns', () => {
      for (let i = 0; i < N; i++) sink = guard.entity;
    });
    bench('guard: raw bot.pathfinder.isMoving()', N, 'ns', () => {
      for (let i = 0; i < N; i++) sink = (real.pathfinder as { isMoving(): boolean }).isMoving();
    });
    bench('guard: guarded bot.pathfinder.isMoving() (namespace proxy)', N, 'ns', () => {
      for (let i = 0; i < N; i++) sink = (guard.pathfinder as { isMoving(): boolean }).isMoving();
    });
    void sink;
    await order.stop('stopped');
  }

  // -- 2. the loop budget and await fences (script/compile.ts) ------------------------------------------------
  {
    const { order } = await heldOrder(1);
    const scope = buildScope(order);
    const body = `export const manifest = { summary: 'x' };
export function spin(n) { let s = 0; for (let i = 0; i < n; i++) { s += i; } return s; }
export async function spinRound(n) { await null; return spin(n); }
export async function awaits(n) { let s = 0; for (let i = 0; i < n; i++) { s += await i; } return s; }
export default async function () {}`;
    const ex = await compile(body, 'squad:bench/budget@v1.mjs')(scope);
    const plain = new vm.Script(`({ spin(n) { let s = 0; for (let i = 0; i < n; i++) { s += i; } return s; }, async awaits(n) { let s = 0; for (let i = 0; i < n; i++) { s += await i; } return s; } })`, {
      filename: 'plain.js',
    }).runInThisContext() as { spin(n: number): number; awaits(n: number): Promise<number> };
    // One await per round inside the script resets the order's budget (1 000 000 iterations without an await).
    const spinRound = ex.spinRound as (n: number) => Promise<number>;
    const awaits = ex.awaits as (n: number) => Promise<number>;
    const N = 500_000; // under the 1 000 000 budget
    bench('budget: plain loop iteration', N, 'ns', () => void plain.spin(N));
    await benchAsync('budget: instrumented loop iteration (__loopBudget + canary)', N, 'ns', async () => void (await spinRound(N)));
    const A = 200_000;
    await benchAsync('budget: plain `await v` in a loop', A, 'ns', async () => void (await plain.awaits(A)));
    await benchAsync('budget: instrumented `await v` (fence, canary, fence)', A, 'ns', async () => void (await awaits(A)));
    await order.stop('stopped');
  }

  // -- 3. squad.tasks (api/squad.ts): queue overhead per item with 30 bots and a trivial job --------------------
  {
    const h = harness();
    for (let i = 0; i < 30; i++) h.bot(`Bot${i}`, [PAUL]);
    const ITEMS = 20_000;
    h.command(PAUL, 'tasks', `export const manifest = { summary: 't', params: { type: 'object', properties: { n: { type: 'integer', default: 1 } } } };
export default async function (squad, { n }) { const items = Array.from({ length: n }, (_, i) => i); const r = await squad.tasks(items, async (bot, i) => i); return r.length; }`);
    h.command(PAUL, 'loop', `export const manifest = { summary: 'l', params: { type: 'object', properties: { n: { type: 'integer', default: 1 } } } };
export default async function (squad, { n }) { const f = async (bot, i) => i; let c = 0; for (let i = 0; i < n; i++) { await f(squad.bots[i % squad.bots.length], i); c++; } return c; }`);
    const run = async (cmd: string): Promise<void> => {
      const r = await h.order(PAUL, cmd, [`n=${ITEMS}`]);
      if (!r.ok) throw new Error(r.text);
      const o = h.runner.get(r.orderId) as Order;
      await o.waitEnded();
      if (o.report.status !== 'done') throw new Error(`${cmd}: ${o.report.status} ${o.report.error?.message}`);
    };
    await benchAsync('tasks: plain awaited loop, per item (30 bots)', ITEMS, 'µs', () => run('loop'), 'includes starting and ending the order');
    await benchAsync('tasks: squad.tasks, per item (30 bots)', ITEMS, 'µs', () => run('tasks'), 'includes starting and ending the order');
  }

  // -- 4. the journal's synchronous writes (journal/journal.ts) -------------------------------------------------
  {
    const dir = join(runDir, 'journal');
    mkdirSync(dir, { recursive: true });
    const j = new Journal(join(dir, 'squad.db'));
    const base = (id: number, big: boolean): OrderReport => {
      const vitals = (n: number): OrderReport['vitals']['before'] =>
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            `Bot${i}`,
            { health: 20, food: 20, position: [1, 2, 3] as [number, number, number], held: 'iron_axe', inventory: Object.fromEntries(Array.from({ length: big ? 20 : 3 }, (_, k) => [`item_${k}`, 64])) },
          ]),
        );
      return {
        id: String(id),
        command: { author: PAUL, name: 'gather', version: 1 },
        commander: PAUL,
        trial: false,
        args: { block: '_log', count: 64 },
        snap: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, dimension: 'overworld', heldItem: null, lookBlock: null, lookEntity: null },
        status: 'done',
        startedAt: Date.now(),
        endedAt: Date.now(),
        bots: Array.from({ length: big ? 30 : 5 }, (_, i) => ({ name: `Bot${i}`, role: 'all' })),
        events: Array.from({ length: big ? 60 : 5 }, (_, i) => ({ at: Date.now(), kind: 'granted', bot: `Bot${i % 30}`, role: 'all' })),
        failures: Array.from({ length: big ? 60 : 0 }, (_, i) => ({ bot: `Bot${i % 30}`, op: 'tasks', error: 'mineBlock(Bot): no oak_log within 48 blocks of (102, 64, -40)'.repeat(2) })),
        logs: Array.from({ length: big ? 300 : 10 }, (_, i) => `Bot${i % 30}: mineBlock(Bot${i % 30}): skipped (102, 64, -40): Digging aborted because the block changed`.padEnd(big ? 200 : 80, '.')),
        vitals: { before: vitals(big ? 30 : 5), after: vitals(big ? 30 : 5) },
      } as OrderReport;
    };
    const small = JSON.stringify(base(0, false)).length;
    const large = JSON.stringify(base(0, true)).length;
    let id = 1;
    bench(`journal: save() a small report (${Math.round(small / 1024)} KB, WAL, synchronous=NORMAL)`, 200, 'µs', () => {
      for (let i = 0; i < 200; i++) j.save(base(id++, false));
    });
    bench(`journal: save() a large report (${Math.round(large / 1024)} KB: 30 bots, 300 log lines)`, 50, 'µs', () => {
      for (let i = 0; i < 50; i++) j.save(base(id++, true));
    });
    bench('journal: lastReport() (what /bots fix reads)', 200, 'µs', () => {
      for (let i = 0; i < 200; i++) j.lastReport(PAUL.uuid, 'gather');
    });
    j.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // -- 5. the SSE broadcast (http/server.ts) -------------------------------------------------------------------
  {
    const service = { deps: { runner: new EventEmitter(), pool: new EventEmitter() }, authoring: {} } as unknown as SquadService;
    const http = new SquadHttp(service, { port: 0, token: 'micro' });
    const port = await http.listen();
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: { Authorization: 'Bearer micro' }, signal: ac.signal });
    const reader = res.body!.getReader();
    let received = 0;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received += (new TextDecoder().decode(value).match(/event: notice/g) ?? []).length;
        }
      } catch {
        /* aborted */
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    const notice = { to: [PAUL.uuid], text: '[Bots] « gather » terminé : 32/32 _log récoltés.', click: { label: '[Corriger]', command: '/bots fix gather ' } };
    const M = 2_000;
    bench('sse: notice() to one connected mod (stringify + write)', M, 'µs', () => {
      for (let i = 0; i < M; i++) http.notice(notice);
    });
    const want = M * (ROUNDS + 2);
    const t = performance.now();
    while (received < want && performance.now() - t < 10_000) await new Promise((r) => setTimeout(r, 10));
    out['sse: delivered'] = { unit: 'notices', median: received, min: received, max: want };
    ac.abort();
    await http.close();
  }

  // -- 6. nearestEntity (api/helpers.ts): one scan of bot.entities -----------------------------------------------
  {
    for (const count of [20, 100, 400]) {
      const me = { position: new Vec3(0, 64, 0), isValid: true };
      const entities: Record<string, unknown> = { self: me };
      for (let i = 0; i < count; i++) {
        entities[String(i)] = { name: i % 5 === 0 ? 'zombie' : 'cow', type: i % 5 === 0 ? 'hostile' : 'animal', position: new Vec3((i * 7) % 60 - 30, 64, (i * 13) % 60 - 30), isValid: true };
      }
      const bot = { entity: me, entities, registry: { entitiesByName: {} } } as unknown as Bot;
      const N = 20_000;
      bench(`nearestEntity: one scan of ${count} entities`, N, 'µs', () => {
        for (let i = 0; i < N; i++) nearestEntity(bot, 'zombie', 16);
      });
    }
  }

  writeFileSync(join(runDir, 'micro.json'), JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, at: new Date().toISOString(), results: out }, null, 2));
  process.stdout.write(`\n→ ${join(runDir, 'micro.json')}\n`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`micro crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
