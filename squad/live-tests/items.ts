// The live scenarios of orders bound to items (docs/29 §5.4), run by run.ts (LIVE_ONLY=items runs only these).
//
// A captain, LiveCaptain, is a plain mineflayer client the test logs in itself: a real online player who is not in
// the roster, so `ctx.commander.entity(bot)` finds them and the mod takes their clicks (it ignores roster bots').
// Their offline UUID (what the server gives an offline-mode player) owns three guards (iron sword, shield in the
// off-hand) and two archers (bow, arrows), on a stone floor the test lays high over the dev world. RCON gives the
// kits and the ground truth (Pos, Rotation, SelectedItem); a raised shield is read as the captain's client sees it,
// the living-entity flags (metadata index 8 in 1.21.1: 0x01 hand active, 0x02 off-hand).
//
// Two kinds of scenario:
//   • the runtime alone: the test posts /api/orders/trigger with a snapshot it writes (what the mod would send);
//   • through the mod: the captain types /bots orders bind, looks and right-clicks or shoots, and the dev server's
//     mod sends the triggers. Those need the dev mod talking to this runtime: dev/squad.properties with
//     url=http://127.0.0.1:8779 and token=live-test-token, and LIVE_RUNTIME_PORT=8779 (another port: set it in both, and
//     LIVE_MOD_PORT to it). Otherwise they are skipped.

import { createHash } from 'node:crypto';

import mineflayer, { type Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

import { lineSlots, lookDir } from '../src/api/helpers';
import { RECIPES_AS_BYTES } from '../src/bots/protocol';
import type { Started } from '../src/main';
import type { Order } from '../src/orders/order';
import type { Notice, ReportEvent, Snapshot } from '../src/types';
import type { Rcon } from './rcon';

export interface LiveKit {
  rcon: Rcon;
  rt: Started;
  mcPort: number;
  /** Whether the world may be changed (the dev server only). */
  setupWorld: boolean;
  notices: Notice[];
  api: (path: string, body: unknown) => Promise<Record<string, unknown> & { ok: boolean; text: string }>;
  scenario: (name: string, fn: () => Promise<string>) => Promise<void>;
  until: (cond: () => boolean | Promise<boolean>, ms: number, what: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** The admin who spawns and despawns bots. */
  admin: { uuid: string; name: string };
}

/** The port dev/squad.properties points the dev mod at. */
export const MOD_RUNTIME_PORT = Number(process.env.LIVE_MOD_PORT ?? 8779);

/** The UUID an offline-mode server gives a player: UUID v3 of MD5("OfflinePlayer:" + name). */
export function offlineUuid(name: string): string {
  const b = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  b[6] = (b[6]! & 0x0f) | 0x30;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const CAPTAIN = { uuid: offlineUuid('LiveCaptain'), name: 'LiveCaptain' };
const GUARDS = ['LiveGuard1', 'LiveGuard2', 'LiveGuard3'];
const ARCHERS = ['LiveBow1', 'LiveBow2'];
const ALL = [...GUARDS, ...ARCHERS];
/** The guard whose shield starts in the inventory (raiseShield equips it into the off-hand, slot 45). */
const POCKET = 'LiveGuard3';
/** The arena: a 49×49 stone floor at y 100 (feet at 101), 200 blocks from the ladder scenario's. */
const A = { x: 1200, y: 100, z: 1000 };
/** The captain's spot, the middle of the floor. */
const C = { x: A.x + 0.5, y: A.y + 1, z: A.z + 0.5 };
/** Tag of the mobs the scenarios summon (killed at the end). */
const TAG = 'squaditems';

const hdist = (p: { x: number; z: number }, q: { x: number; z: number }): number => Math.hypot(p.x - q.x, p.z - q.z);
/** The difference of two yaws in degrees, in [0, 180]. */
const yawDiff = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
const fmt = (p: { x: number; y: number; z: number } | undefined | null): string => (p ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : '?');

export async function itemScenarios(k: LiveKit): Promise<void> {
  const { rcon, rt, api, scenario, until, sleep, notices } = k;
  const { pool, runner } = rt.service.deps;
  const viaMod = rt.port === MOD_RUNTIME_PORT;
  if (!k.setupWorld) {
    await scenario('items: bound-item scenarios', async () => 'skipped (they build an arena on the dev world only)');
    return;
  }

  // -- ground truth -------------------------------------------------------------------------------------------
  const floats = (s: string): number[] => [...s.matchAll(/(-?\d+(?:\.\d+)?(?:E-?\d+)?)[dfF]/g)].map((m) => Number(m[1]));
  const rconPos = async (name: string): Promise<Vec3> => {
    const r = await rcon.command(`data get entity ${name} Pos`);
    const [x, y, z] = floats(r);
    if (x === undefined || y === undefined || z === undefined) throw new Error(`no Pos for ${name}: ${r.trim()}`);
    return new Vec3(x, y, z);
  };
  const rconYaw = async (name: string): Promise<number> => {
    const r = await rcon.command(`data get entity ${name} Rotation`);
    const [yaw] = floats(r);
    if (yaw === undefined) throw new Error(`no Rotation for ${name}: ${r.trim()}`);
    return yaw;
  };
  const pos = (name: string): Vec3 | undefined => pool.bot(name)?.entity?.position;
  /**
   * Arrows a bot has shot since the scenarios began: the arrow entities spawned with it as their owner (the spawn
   * packet's data is the owner's entity id), as its own client hears them. Not its inventory: the archers' bows have
   * Infinity, so the count never drops (docs/35 F3).
   */
  const shotCounts = new Map<string, number>();
  const counting = new WeakSet<object>();
  const arrowsShot = (name: string): number => {
    const b = pool.bot(name)!;
    if (!counting.has(b)) {
      counting.add(b);
      const arrow = (b.registry.entitiesByName.arrow as { internalId?: number; id: number }) ?? { id: -1 };
      b._client.on('spawn_entity', (p: { type: number; objectData?: number }) => {
        if (p.type === (arrow.internalId ?? arrow.id) && p.objectData === b.entity?.id) shotCounts.set(name, (shotCounts.get(name) ?? 0) + 1);
      });
    }
    return shotCounts.get(name) ?? 0;
  };

  // -- the captain ---------------------------------------------------------------------------------------------
  let captain: Bot | undefined;
  const chat: string[] = [];
  const cap = (): Bot => {
    if (!captain) throw new Error('the captain is not connected');
    return captain;
  };
  /** The living-entity flags of a bot as the captain's client sees it (0x01 using an item, 0x02 with the off-hand). */
  const handFlags = (name: string): number => {
    const e = cap().players[name]?.entity as { metadata?: unknown[] } | undefined;
    const v = e?.metadata?.[8];
    return typeof v === 'number' ? v : 0;
  };
  const shieldUp = (name: string): boolean => (handFlags(name) & 3) === 3;
  const placeCaptain = async (yaw: number): Promise<void> => {
    await rcon.command(`tp ${CAPTAIN.name} ${C.x} ${C.y} ${C.z} ${yaw} 0`);
    await sleep(500);
  };
  /** Look at a point (the look packet goes out with the next physics tick, hence the wait). */
  const look = async (p: { x: number; y: number; z: number }): Promise<void> => {
    await cap().lookAt(new Vec3(p.x, p.y, p.z), true);
    await sleep(300);
  };
  const rightClick = async (): Promise<void> => {
    cap().activateItem();
    await sleep(300);
    cap().deactivateItem();
  };
  const said = (re: RegExp, from = 0): boolean => chat.slice(from).some((m) => re.test(m));
  /** Type a /bots command as the captain and wait for its answer; the mod may still be connecting to this runtime. */
  const command = async (line: string, answer: RegExp): Promise<string> => {
    const end = Date.now() + 45_000;
    for (;;) {
      const from = chat.length;
      cap().chat(line);
      try {
        await until(() => said(answer, from) || said(/injoignable|désactivé/, from), 10_000, `the answer to ${line}`);
      } catch {
        /* no answer yet: try again below */
      }
      const got = chat.slice(from).find((m) => answer.test(m));
      if (got) return got;
      if (Date.now() > end) throw new Error(`no answer ${answer} to ${line}: ${chat.slice(from).join(' | ') || 'nothing'}`);
      await sleep(3000);
    }
  };

  // -- orders --------------------------------------------------------------------------------------------------
  const snap = (yaw: number, extra: Partial<Snapshot> = {}): Snapshot => ({
    position: { x: C.x, y: C.y, z: C.z },
    yaw,
    pitch: 20,
    dimension: 'overworld',
    heldItem: null,
    lookBlock: null,
    lookEntity: null,
    ...extra,
  });
  const block = (x: number, z: number) => ({ x, y: A.y, z, name: 'stone' });
  const use = (item: string) => ({ kind: 'use' as const, item });
  /** A right-click of a bound shield with that yaw, looking at `lookBlock` (the snapshot the mod would send). */
  const shieldClick = (yaw: number, lookBlock: Snapshot['lookBlock']): Snapshot => snap(yaw, { lookBlock, heldItem: 'shield', trigger: use('shield') });
  const trigger = (command: string, s: Snapshot, stop = false) =>
    api('/api/orders/trigger', { by: CAPTAIN, command, tokens: [], filters: [], ...(stop ? { stop: true } : {}), snap: s });
  const mine = (command: string): Order | undefined => runner.running().find((o) => o.command.name === command && o.commander.uuid === CAPTAIN.uuid);
  const triggers = (o: Order): ReportEvent[] => o.report.events.filter((e) => e.kind === 'trigger');
  /**
   * The slot `epee` gives a bot around a held point: guards on a ring of 3 (from angle 0), archers on one of 6 (from
   * π/8), by the bot's index in its role, offsets rounded to 0.1, then the centre of that column's block (groundAt).
   */
  const ringSlot = (name: string, point: { x: number; z: number }): { x: number; z: number } => {
    const guard = GUARDS.includes(name);
    const [i, n, r, phase] = guard ? [GUARDS.indexOf(name), GUARDS.length, 3, 0] : [ARCHERS.indexOf(name), ARCHERS.length, 6, Math.PI / 8];
    const a = phase + (2 * Math.PI * i) / n;
    const off = (v: number): number => Math.round(v * r * 10) / 10;
    return { x: Math.floor(point.x + off(Math.cos(a))) + 0.5, z: Math.floor(point.z + off(Math.sin(a))) + 0.5 };
  };
  /**
   * Every bot on its own slot: within RING_SLACK of it. GoalNear(slot, 1) counts whole blocks, so a bot stops in a block
   * next to the slot's, up to about 1.7 from its centre, and is sent again only beyond 1.5.
   */
  const RING_SLACK = 1.8;
  const holding = (point: { x: number; z: number }): boolean => ALL.every((b) => hdist(pos(b)!, ringSlot(b, point)) <= RING_SLACK);
  /** Each bot: distance to the point and to its slot, and its pathfinder goal (for a failure). */
  const ringReport = (point: { x: number; z: number }): string =>
    ALL.map((name) => {
      const slot = ringSlot(name, point);
      const b = pool.bot(name)!;
      const goal = b.pathfinder.goal as { constructor: { name: string }; x?: number; z?: number } | null;
      const g = goal ? `${goal.constructor.name}(${goal.x},${goal.z})` : 'none';
      const d = (q: { x: number; z: number }): string => hdist(pos(name)!, q).toFixed(1);
      return `${name} ${fmt(pos(name))} ${d(point)} from the point, ${d(slot)} from slot ${slot.x},${slot.z}, goal ${g}, moving ${b.pathfinder.isMoving()}`;
    }).join('; ');
  /** The top centre of the block a snapshot looked at: where pointedTarget puts the point (null: the sky). */
  const topOf = (s: Snapshot): { x: number; y: number; z: number } | null =>
    s.lookBlock ? { x: s.lookBlock.x + 0.5, y: s.lookBlock.y + 1, z: s.lookBlock.z + 0.5 } : null;
  const describeTriggers = (o: Order): string => triggers(o).map((e) => `${e.trigger ?? '-'}:${e.outcome}${e.pos ? '@' + e.pos.join(',') : ''}`).join(' ');

  /** Every guard on a line: along z at `x` (lineAxis 'z') or along x at `z`; distinct places about `spacing` apart. */
  const onLine = (names: string[], axis: 'x' | 'z', at: number, centre: number, tol = 1.0): boolean => {
    const ps = names.map(pos);
    if (ps.some((p) => !p)) return false;
    const across = (p: Vec3): number => (axis === 'z' ? p.x : p.z);
    const along = (p: Vec3): number => (axis === 'z' ? p.z : p.x);
    if (ps.some((p) => Math.abs(across(p!) - at) > tol || Math.abs(along(p!) - centre) > names.length)) return false;
    const sorted = ps.map((p) => along(p!)).sort((a, b) => a - b);
    return sorted.every((v, i) => i === 0 || v - sorted[i - 1]! >= 0.6);
  };
  /** Positions, Rotation yaws and shields of the guards (RCON for the first two). */
  const wallEvidence = async (): Promise<string> => {
    const parts: string[] = [];
    for (const g of GUARDS) parts.push(`${g} ${fmt(await rconPos(g))} yaw ${(await rconYaw(g)).toFixed(1)} flags ${handFlags(g)}`);
    return parts.join('; ');
  };
  const checkWall = async (axis: 'x' | 'z', at: number, centre: number, yaw: number, what: string): Promise<string> => {
    try {
      await until(() => onLine(GUARDS, axis, at, centre), 40_000, `the guards on the line (${what})`);
      // Rotation is set once on the slot, the shield right after: both within a few looks (200 ms each).
      await until(async () => {
        for (const g of GUARDS) if (yawDiff(await rconYaw(g), yaw) > 10 || !shieldUp(g)) return false;
        return true;
      }, 10_000, `the guards facing yaw ${yaw} with shields up (${what})`);
    } catch (e) {
      throw new Error(`${(e as Error).message}: ${await wallEvidence()}`);
    }
    return wallEvidence();
  };

  try {
    await scenario('items: captain and five bots on the arena', async () => {
      await rcon.command(`forceload add ${A.x - 32} ${A.z - 32} ${A.x + 32} ${A.z + 32}`);
      await rcon.command(`fill ${A.x - 24} ${A.y} ${A.z - 24} ${A.x + 24} ${A.y} ${A.z + 24} stone`);
      await rcon.command(`fill ${A.x - 24} ${A.y + 1} ${A.z - 24} ${A.x + 24} ${A.y + 12} ${A.z + 24} air`);
      await rcon.command(`kill @e[type=!minecraft:player,x=${A.x - 30},y=${A.y - 10},z=${A.z - 30},dx=60,dy=40,dz=60]`);

      captain = mineflayer.createBot({
        host: '127.0.0.1',
        port: k.mcPort,
        username: CAPTAIN.name,
        auth: 'offline',
        version: '1.21.1',
        customPackets: RECIPES_AS_BYTES,
      } as Parameters<typeof mineflayer.createBot>[0]);
      captain.on('messagestr', (m: string) => {
        chat.push(m);
        if (/\[Bots\]/.test(m)) console.log('   captain ←', m);
      });
      captain.on('kicked', (r: unknown) => console.log('   captain kicked:', JSON.stringify(r)));
      captain.on('error', (e: Error) => console.log('   captain error:', e.message));
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('the captain did not spawn in 30 s')), 30_000);
        cap().once('spawn', () => {
          clearTimeout(t);
          resolve();
        });
      });
      // The UUID the server gave the captain must be the one the roster's owners name.
      await sleep(1000);
      const uuid = (cap() as unknown as { player?: { uuid?: string } }).player?.uuid ?? '';
      if (uuid.replace(/-/g, '') !== CAPTAIN.uuid.replace(/-/g, '')) throw new Error(`the server gave LiveCaptain ${uuid}, expected ${CAPTAIN.uuid}`);
      await rcon.command(`gamemode survival ${CAPTAIN.name}`);
      await rcon.command(`clear ${CAPTAIN.name}`);
      await rcon.command(`effect give ${CAPTAIN.name} minecraft:resistance infinite 4 true`);
      await placeCaptain(90);

      for (const name of ALL) {
        if (pool.status(name) === 'online') continue;
        const r = await api('/api/bots/spawn', { by: k.admin, admin: true, name, owners: [CAPTAIN] });
        if (!r.ok) throw new Error(r.text);
      }
      await until(() => ALL.every((b) => pool.status(b) === 'online'), 90_000, 'all five bots online');
      await sleep(1500);
      // Guards south-east of the captain, archers north of them: out of the way of the captain's own arrow (west).
      for (const [i, g] of GUARDS.entries()) {
        await rcon.command(`tp ${g} ${C.x + 3 + i} ${C.y} ${C.z + 3}`);
        await rcon.command(`clear ${g}`);
        await rcon.command(`give ${g} iron_sword`);
        // The last guard's shield goes in its inventory, not the off-hand: raiseShield must move it to slot 45.
        if (g === POCKET) await rcon.command(`give ${g} shield`);
        else await rcon.command(`item replace entity ${g} weapon.offhand with minecraft:shield`);
      }
      for (const [i, a] of ARCHERS.entries()) {
        await rcon.command(`tp ${a} ${C.x} ${C.y} ${C.z - 4 - 2 * i}`);
        await rcon.command(`clear ${a}`);
        // The archer kit's bow (docs/35 D6): shoot must see its arrows leave by their spawn, not by the count.
        await rcon.command(`give ${a} bow[enchantments={levels:{"minecraft:infinity":1,"minecraft:unbreaking":3}}]`);
        await rcon.command(`give ${a} arrow 64`);
      }
      // Fed for the whole run: a bot eating lowers its shield (auto-eat), which is not what these scenarios check.
      for (const name of ALL) await rcon.command(`effect give ${name} minecraft:saturation infinite 1 true`);
      await sleep(2000);
      const missing = GUARDS.filter((g) => g !== POCKET && pool.bot(g)!.inventory.slots[45]?.name !== 'shield');
      if (missing.length) throw new Error(`no shield in the off-hand of ${missing.join(', ')}`);
      const pocket = pool.bot(POCKET)!;
      if (pocket.inventory.slots[45] || !pocket.inventory.items().some((i) => i.name === 'shield')) {
        throw new Error(`${POCKET} should have its shield in the inventory, not the off-hand`);
      }
      return `captain ${CAPTAIN.uuid} at ${fmt(cap().entity.position)}; ${ALL.length} bots online`;
    });
    if (!captain || !ALL.every((b) => pool.status(b) === 'online')) return;

    /** The bots back at their first spots: guards south-east of the captain's spot, archers north of it. */
    const home = async (): Promise<void> => {
      for (const [i, g] of GUARDS.entries()) await rcon.command(`tp ${g} ${C.x + 3 + i} ${C.y} ${C.z + 3}`);
      for (const [i, a] of ARCHERS.entries()) await rcon.command(`tp ${a} ${C.x} ${C.y} ${C.z - 4 - 2 * i}`);
      await sleep(1000);
    };
    /**
     * A scenario that starts from the same place and leaves nothing behind, failed or not: the bots at home first, and
     * at the end the captain's orders stopped and the husks killed. A failure once left an `epee` running, and the next
     * scenarios' clicks reached it instead of starting their own orders.
     */
    const clean = (name: string, fn: () => Promise<string>): Promise<void> =>
      scenario(name, async () => {
        await home();
        try {
          return await fn();
        } finally {
          await api('/api/orders/stop', { by: CAPTAIN, target: 'all' }).catch(() => undefined);
          await rcon.command(`kill @e[type=minecraft:husk,tag=${TAG}]`).catch(() => '');
        }
      });

    await clean('items: mur-de-boucliers (runtime): a wall across yaw 90, re-formed across yaw 0 by a second click; a husk that only stands there is left alone, one that attacks is hit back until dead', async () => {
      // Looking west at the block 6 west of the captain: the wall runs along z at x = A.x − 5.5.
      const first = await trigger('mur-de-boucliers', shieldClick(90, block(A.x - 6, A.z)));
      if (!first.ok || first.started !== true) throw new Error(`first click: ${first.text}`);
      const id = String(first.orderId);
      const west = await checkWall('z', A.x - 5.5, A.z + 0.5, 90, 'yaw 90');
      // Its shield up (flags 3) means raiseShield equipped it into the off-hand first.
      if (pool.bot(POCKET)!.inventory.slots[45]?.name !== 'shield') throw new Error(`${POCKET}'s shield is not in its off-hand`);
      // Looking south at the block 6 south: the same order re-forms along x at z = A.z + 6.5.
      const second = await trigger('mur-de-boucliers', shieldClick(0, block(A.x, A.z + 6)));
      if (!second.ok || second.delivered !== true || String(second.orderId) !== id) {
        throw new Error(`second click not delivered to #${id}: ${JSON.stringify(second)}`);
      }
      const south = await checkWall('x', A.z + 6.5, A.x + 0.5, 0, 'yaw 0');
      // A husk that never attacks (NoAI) 1.5 blocks in front of the wall: nobody goes after it, every shield stays up.
      const order = runner.get(id)!;
      await rcon.command(`summon husk ${A.x + 0.5} ${A.y + 1} ${A.z + 8} {PersistenceRequired:1b,NoAI:1b,Tags:["${TAG}"]}`);
      for (let t = 0; t < 10; t++) {
        await sleep(300);
        const down = GUARDS.filter((g) => !shieldUp(g));
        if (down.length) throw new Error(`a shield went down for a husk that does not attack: ${down.join(', ')}; ${await wallEvidence()}`);
      }
      await rcon.command(`kill @e[type=minecraft:husk,tag=${TAG}]`);
      // One that attacks, 2 blocks in front, more than STUCK_MS (10 s) after the guards reached their slots: each blow
      // on a shield is answered once (meleeHit from entity status 29 and the husk's swing), until it is dead; then
      // each guard is back on its slot exactly. (Its stuck timer used to run from the first walk, so it came back to a
      // loose goal and stood up to 2.5 blocks off: docs/29 §16.)
      await sleep(11_000);
      const logs0 = order.report.logs.length;
      await rcon.command(`summon husk ${A.x + 0.5} ${A.y + 1} ${A.z + 8.5} {PersistenceRequired:1b,Tags:["${TAG}"]}`);
      const huskGone = async (): Promise<boolean> => !/passed/i.test(await rcon.command(`execute if entity @e[type=minecraft:husk,tag=${TAG}]`));
      await until(huskGone, 60_000, 'the guards hitting the attacking husk back until it dies');
      const blows = order.report.logs.slice(logs0).filter((l) => /hit back at husk/.test(l));
      if (blows.length === 0) throw new Error(`the husk died but no guard hit back: ${order.report.logs.slice(logs0).join(' | ')}`);
      const slotsSouth = [-0.5, 0.5, 1.5].map((dx) => ({ x: A.x + dx, z: A.z + 6.5 }));
      const off = (): number[] => GUARDS.map((g) => Math.min(...slotsSouth.map((s) => hdist(pos(g)!, s))));
      // A sword's sweep knocks the striker's neighbours (the knockback comes before the damage the friendly-fire hook
      // cancels): one can stand a block off when the husk dies, and walks back.
      const bumped = Math.max(...off());
      try {
        await until(() => off().every((d) => d <= 0.8), 8_000, 'every guard back on its slot');
      } catch (e) {
        throw new Error(`${(e as Error).message}: ${off().map((d) => d.toFixed(2)).join(', ')} blocks off; ${await wallEvidence()}`);
      }
      const after = await checkWall('x', A.z + 6.5, A.x + 0.5, 0, 'after the fight');
      const stop = await trigger('mur-de-boucliers', snap(0, { trigger: use('shield') }), true);
      if (!stop.ok || stop.stopped !== true) throw new Error(`stop: ${stop.text}`);
      // Leaving the order lowers the shield (the abort sequence's deactivateItem).
      await until(() => GUARDS.every((g) => !shieldUp(g)), 5_000, 'the shields lowered after the stop');
      return (
        `#${id} (${describeTriggers(order)}); ${POCKET}'s shield equipped from the inventory into the off-hand; ` +
        `west: ${west} | south: ${south} | a NoAI husk left alone, shields up | an attacking husk killed by ${blows.length} blow(s) back ` +
        `(${[...new Set(blows.map((l) => l.split(':')[0]))].join(', ')}; farthest off a slot at its death ${bumped.toFixed(2)}), back in line: ${after} | stopped: "${stop.text}", shields down`
      );
    });

    await clean('items: mur-de-boucliers (runtime) at yaws not axis-aligned: each guard on its exact place, a straight line (three at 45°; two at 87°, whose places share a block: docs/35 F2)', async () => {
      /**
       * The wall of `names` across `yaw` at the block looked at: each guard within 0.2 of its own exact place
       * (lineSlots through the block's top centre, as the order computes it; RCON Pos for the ground truth), on the
       * line, no two closer than 0.6 (a body's width), facing the yaw with its shield up.
       */
      const exactWall = async (names: string[], yaw: number, look: { x: number; z: number }, what: string): Promise<string> => {
        const point = new Vec3(look.x + 0.5, A.y + 1, look.z + 0.5);
        const places = lineSlots(point, yaw, names.length, { spacing: 1 });
        const onPlaces = (ps: Vec3[]): boolean => places.every((s) => ps.filter((p) => hdist(p, s) <= 0.2).length === 1);
        const evidence = async (): Promise<string> => {
          const parts: string[] = [];
          for (const g of names) {
            const p = await rconPos(g);
            parts.push(`${g} ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} (${Math.min(...places.map((s) => hdist(p, s))).toFixed(2)} off a place) yaw ${(await rconYaw(g)).toFixed(1)} flags ${handFlags(g)}`);
          }
          return `${parts.join('; ')}; places ${places.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`).join(' ')}`;
        };
        try {
          await until(() => onPlaces(names.map((g) => pos(g)!)) && names.every(shieldUp), 40_000, `the guards on their exact places, shields up (${what})`);
          await until(async () => {
            for (const g of names) if (yawDiff(await rconYaw(g), yaw) > 10) return false;
            return true;
          }, 10_000, `the guards facing yaw ${yaw} (${what})`);
          const ps: Vec3[] = [];
          for (const g of names) ps.push(await rconPos(g));
          if (!onPlaces(ps)) throw new Error('the server does not have each guard within 0.2 of its place');
          const fwd = lookDir(yaw);
          const offLine = Math.max(...ps.map((p) => Math.abs((p.x - point.x) * fwd.x + (p.z - point.z) * fwd.z)));
          if (offLine > 0.2) throw new Error(`a guard ${offLine.toFixed(2)} off the line`);
          let closest = Infinity;
          for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) closest = Math.min(closest, hdist(ps[i]!, ps[j]!));
          if (closest < 0.6) throw new Error(`two guards ${closest.toFixed(2)} apart`);
          return `${what}: ${await evidence()}; at most ${offLine.toFixed(2)} off the line, the closest two ${closest.toFixed(2)} apart`;
        } catch (e) {
          throw new Error(`${(e as Error).message}: ${await evidence()}`);
        }
      };
      // Three at 45° (looking south-west at a block about 6 ahead): the two outer places lie 0.4 off their blocks' centres.
      const first = await trigger('mur-de-boucliers', shieldClick(45, block(A.x - 5, A.z + 4)));
      if (!first.ok || first.started !== true) throw new Error(`first click: ${first.text}`);
      const three = await exactWall(GUARDS, 45, { x: A.x - 5, z: A.z + 4 }, 'three at 45°');
      // Two at 87° (@bot filters: the wall restarts with them): their places, half a block either side of the point's
      // block centre, share that block, where both stood before (10 guards at 87° in 9 blocks, docs/35 F2).
      const pair = GUARDS.slice(0, 2);
      const second = await api('/api/orders/trigger', { by: CAPTAIN, command: 'mur-de-boucliers', tokens: [], filters: pair, snap: shieldClick(87, block(A.x - 6, A.z)) });
      if (!second.ok) throw new Error(`second click: ${second.text}`);
      const two = await exactWall(pair, 87, { x: A.x - 6, z: A.z }, 'two at 87°');
      return `${three} | ${two}`;
    });

    await clean('items: mur-de-boucliers through the mod: bind, click, click again, sneak-click, unbind', async () => {
      if (!viaMod) return `skipped (the runtime is on port ${rt.port}: LIVE_RUNTIME_PORT=${MOD_RUNTIME_PORT} with dev/squad.properties pointing at it)`;
      await rcon.command(`clear ${CAPTAIN.name}`);
      await rcon.command(`item replace entity ${CAPTAIN.name} weapon.mainhand with minecraft:shield`);
      await placeCaptain(90);
      const bound = await command('/bots orders bind mur-de-boucliers', /Ordre « mur-de-boucliers » lié/);
      const item = await rcon.command(`data get entity ${CAPTAIN.name} SelectedItem`);
      if (!/custom_data/.test(item) || !/squad/.test(item) || !/mur-de-boucliers/.test(item)) throw new Error(`no binding on the shield: ${item.trim()}`);
      // What the player sees: one lore line naming the order, and the glint (a plain shield has none of its own).
      if (!/minecraft:lore/.test(item) || !/Ordre : mur-de-boucliers/.test(item) || !/enchantment_glint_override/.test(item)) {
        throw new Error(`no lore line or glint on the bound shield: ${item.trim()}`);
      }

      // Look at the floor 6 blocks west and right-click: the order starts.
      await look({ x: A.x - 5.5, y: A.y + 0.9, z: A.z + 0.5 });
      await rightClick();
      await until(() => !!mine('mur-de-boucliers'), 5_000, 'a running mur-de-boucliers commanded by LiveCaptain');
      const order = mine('mur-de-boucliers')!;
      const start = triggers(order)[0];
      if (start?.outcome !== 'started' || start.trigger !== 'use' || start.item !== 'shield') throw new Error(`first trigger event: ${JSON.stringify(start)}`);
      const s0 = order.report.snap;
      if (s0.lookBlock?.x !== A.x - 6 || s0.lookBlock?.z !== A.z || yawDiff(s0.yaw, 90) > 3) {
        throw new Error(`the click's snapshot: yaw ${s0.yaw}, lookBlock ${JSON.stringify(s0.lookBlock)}`);
      }
      const west = await checkWall('z', A.x - 5.5, A.z + 0.5, 90, 'mod, yaw 90');

      // Turn south, right-click again: delivered to the same order, which re-forms.
      await look({ x: A.x + 0.5, y: A.y + 0.9, z: A.z + 6.5 });
      await rightClick();
      await until(() => triggers(order).some((e) => e.outcome === 'delivered'), 5_000, 'the second click delivered');
      if (mine('mur-de-boucliers') !== order) throw new Error('the second click started another order');
      const south = await checkWall('x', A.z + 6.5, A.x + 0.5, 0, 'mod, yaw 0');

      // Sneak + right-click: the order stops.
      const from = chat.length;
      cap().setControlState('sneak', true);
      await sleep(400);
      await rightClick();
      await sleep(200);
      cap().setControlState('sneak', false);
      await until(() => order.ended, 5_000, 'the order stopped by sneak + right-click');
      await until(() => said(/« mur-de-boucliers » arrêté/, from), 5_000, 'the stop line in chat');
      if (order.report.status !== 'stopped') throw new Error(`status ${order.report.status}`);

      const unbound = await command('/bots orders unbind', /délié de ton objet/);
      const after = await rcon.command(`data get entity ${CAPTAIN.name} SelectedItem`);
      if (/squad|Ordre :|enchantment_glint_override/.test(after)) throw new Error(`the binding, its lore line or its glint is still there: ${after.trim()}`);
      return `"${bound}" | #${order.id} ${describeTriggers(order)} | west: ${west} | south: ${south} | "${unbound}"`;
    });

    /** The captain draws the bound bow at a point for 1.2 s and lets go: the tir order that arrow starts, once ended. */
    const shootBound = async (at: { x: number; y: number; z: number }): Promise<Order> => {
      await look(at);
      let order: Order | undefined;
      const watch = setInterval(() => (order ??= mine('tir')), 50);
      try {
        cap().activateItem();
        await sleep(1200);
        cap().deactivateItem();
        await until(() => !!order, 5_000, 'a tir order started by the arrow');
        await until(() => order!.ended, 40_000, 'the tir order to end');
      } finally {
        clearInterval(watch);
      }
      await sleep(1500); // the last arrow count update
      return order!;
    };
    const captainArrows = (): number => cap().inventory.items().find((i) => i.name === 'arrow')?.count ?? 0;
    const shots = (before: number[], after: number[]): string => ARCHERS.map((a, i) => `${a} ${after[i]! - before[i]!}`).join(', ');
    const arrowsNear = async (p: { x: number; y: number; z: number }, r: number): Promise<number> => {
      const t = await rcon.command(`execute positioned ${p.x} ${p.y} ${p.z} if entity @e[type=minecraft:arrow,distance=..${r}]`);
      return Number(/count: (\d+)/.exec(t)?.[1] ?? 0);
    };

    await clean('items: tir through the mod: the captain shoots the ground, arrow-release then arrow-hit (onBlockHit), a volley of 3 each', async () => {
      if (!viaMod) return `skipped (the runtime is on port ${rt.port}: LIVE_RUNTIME_PORT=${MOD_RUNTIME_PORT} with dev/squad.properties pointing at it)`;
      await rcon.command(`clear ${CAPTAIN.name}`);
      await rcon.command(`item replace entity ${CAPTAIN.name} weapon.mainhand with minecraft:bow`);
      await rcon.command(`give ${CAPTAIN.name} arrow 16`);
      for (const a of ARCHERS) {
        await rcon.command(`clear ${a} arrow`);
        await rcon.command(`give ${a} arrow 32`);
      }
      await rcon.command(`kill @e[type=minecraft:arrow,x=${A.x - 30},y=${A.y - 10},z=${A.z - 30},dx=60,dy=40,dz=60]`);
      await placeCaptain(90);
      const bound = await command('/bots orders bind tir', /Ordre « tir » lié/);
      const listed = await command('/bots orders bound', /: tir$/);
      await sleep(1000);
      const before = ARCHERS.map(arrowsShot);
      const captainBefore = captainArrows();

      // The floor 15 blocks west.
      const order = await shootBound({ x: A.x - 14.5, y: A.y + 0.9, z: A.z + 0.5 });
      const after = ARCHERS.map(arrowsShot);
      const ev = triggers(order);
      const release = ev.find((e) => e.trigger === 'arrow-release');
      const hit = ev.find((e) => e.trigger === 'arrow-hit');
      const landed = hit?.pos ? await arrowsNear({ x: hit.pos[0] + 0.5, y: hit.pos[1], z: hit.pos[2] + 0.5 }, 6) : 0;
      const evidence =
        `#${order.id} ${describeTriggers(order)}; result "${order.report.result}"; archers' shots ${shots(before, after)}; ` +
        `captain ${captainBefore}→${captainArrows()}; arrows within 6 of the hit: ${landed}`;
      if (release?.outcome !== 'started' || release.item !== 'bow') throw new Error(`no arrow-release start: ${evidence}`);
      // The release's snapshot is taken as the arrow enters the world in front of the eyes: that arrow is not what the
      // captain looks at (it was, and the archers shot at it first: docs/29 §16).
      const looked = order.report.snap.lookEntity;
      if (looked) throw new Error(`the release's snapshot looks at ${looked.name} #${looked.id ?? '?'} (nothing expected): ${evidence}`);
      if (hit?.outcome !== 'delivered' || !hit.pos) throw new Error(`no arrow-hit delivered: ${evidence}`);
      if (hdist({ x: hit.pos[0], z: hit.pos[2] }, { x: A.x - 14.5, z: A.z + 0.5 }) > 6) {
        throw new Error(`the hit is far from where the captain looked: ${evidence}`);
      }
      // volley 3 (the default) from each archer, nothing more.
      const fired = before.map((b, i) => after[i]! - b);
      if (order.report.result !== 'Volée tirée : 6 flèches.' || fired.some((n) => n !== 3)) {
        throw new Error(`a volley of exactly 3 arrows each was expected: ${evidence}`);
      }
      // The volley lands around the hit (spread 3): the captain's arrow and most of the archers' six.
      if (landed < 5) throw new Error(`the volley did not land around the hit: ${evidence}`);
      return `"${bound}" | "${listed}" | ${evidence}`;
    });

    await clean('items: tir through the mod: the captain shoots a husk, arrow-hit names it (onEntityHit), the archers kill it', async () => {
      if (!viaMod) return `skipped (the runtime is on port ${rt.port}: LIVE_RUNTIME_PORT=${MOD_RUNTIME_PORT} with dev/squad.properties pointing at it)`;
      await placeCaptain(90);
      await rcon.command(`summon husk ${A.x - 9.5} ${A.y + 1} ${A.z + 0.5} {PersistenceRequired:1b,NoAI:1b,Tags:["${TAG}"]}`);
      await until(() => Object.values(cap().entities).some((e) => e.name === 'husk'), 5_000, 'the captain seeing the husk');
      const husk = Object.values(cap().entities).find((e) => e.name === 'husk')!;
      const before = ARCHERS.map(arrowsShot);
      // At its chest: at 10 blocks a full-draw arrow flies nearly straight.
      const order = await shootBound({ x: husk.position.x, y: husk.position.y + 1.2, z: husk.position.z });
      const after = ARCHERS.map(arrowsShot);
      const ev = triggers(order);
      const release = ev.find((e) => e.trigger === 'arrow-release');
      const hit = ev.find((e) => e.trigger === 'arrow-hit');
      const alive = /passed/i.test(await rcon.command(`execute if entity @e[type=minecraft:husk,tag=${TAG}]`));
      const evidence =
        `#${order.id} ${describeTriggers(order)} (release looks at ${release?.entity ?? 'nothing'}, hit ${hit?.entity ?? 'no entity'}); ` +
        `result "${order.report.result}"; archers' shots ${shots(before, after)}; husk ${alive ? 'alive' : 'dead'}`;
      if (release?.outcome !== 'started' || release.entity !== 'husk') throw new Error(`the release did not start tir at the husk: ${evidence}`);
      if (hit?.outcome !== 'delivered' || hit.entity !== 'husk') throw new Error(`no arrow-hit naming the husk: ${evidence}`);
      if (alive || !/^Cible abattue \(husk\)/.test(String(order.report.result))) throw new Error(`the husk was not killed: ${evidence}`);
      if (before.every((b, i) => b === after[i])) throw new Error(`no archer shot: ${evidence}`);
      await command('/bots orders unbind', /délié de ton objet/);
      return evidence;
    });

    // -- any item carries any order (pointedTarget): a click says where, the command decides -----------------------

    const skipped = (): string => `skipped (the runtime is on port ${rt.port}: LIVE_RUNTIME_PORT=${MOD_RUNTIME_PORT} with dev/squad.properties pointing at it)`;
    /** Hold `item` alone (the inventory emptied first) and bind `line` to it. */
    const bindHeld = async (item: string, line: string): Promise<string> => {
      await rcon.command(`clear ${CAPTAIN.name}`);
      await rcon.command(`item replace entity ${CAPTAIN.name} weapon.mainhand with minecraft:${item}`);
      await sleep(500);
      const order = line.split(' ')[0]!;
      return command(`/bots orders bind ${line}`, new RegExp(`Ordre « ${order} » lié`));
    };
    const killArrows = (): Promise<string> => rcon.command(`kill @e[type=minecraft:arrow,x=${A.x - 30},y=${A.y - 10},z=${A.z - 30},dx=60,dy=40,dz=60]`);
    /** Right-click with the held (non-launcher) item; the order of `command` it starts or reaches, watched every 50 ms. */
    const clickFor = async (command: string): Promise<Order> => {
      let order: Order | undefined;
      const watch = setInterval(() => (order ??= mine(command)), 50);
      try {
        await rightClick();
        await until(() => !!order, 5_000, `a ${command} order from the click`);
      } finally {
        clearInterval(watch);
      }
      return order!;
    };
    const summonHusk = async (x: number, z: number) => {
      await rcon.command(`summon husk ${x} ${A.y + 1} ${z} {PersistenceRequired:1b,NoAI:1b,Tags:["${TAG}"]}`);
      await until(() => Object.values(cap().entities).some((e) => e.name === 'husk' && e.isValid !== false), 5_000, 'the captain seeing the husk');
      return Object.values(cap().entities).find((e) => e.name === 'husk' && e.isValid !== false)!;
    };
    const huskAlive = async (): Promise<boolean> => /passed/i.test(await rcon.command(`execute if entity @e[type=minecraft:husk,tag=${TAG}]`));
    /** Living things (and items, arrows…) within `r` of a point, as the captain sees them: the bots and the captain excepted. */
    const othersNear = (p: { x: number; z: number }, r: number): string[] =>
      Object.values(cap().entities)
        .filter((e) => e !== cap().entity && !(e.username && (ALL.includes(e.username) || e.username === CAPTAIN.name)) && hdist(e.position, p) <= r)
        .map((e) => e.name ?? '?');

    await clean('items: tir bound to a stick (mod): the ground 3 blocks from a husk → the archers kill it; empty ground → a volley there', async () => {
      if (!viaMod) return skipped();
      await placeCaptain(90);
      await killArrows();
      for (const a of ARCHERS) {
        await rcon.command(`clear ${a} arrow`);
        await rcon.command(`give ${a} arrow 32`);
      }
      const bound = await bindHeld('stick', 'tir');
      // The husk 10 blocks west; the captain looks at the floor 3 blocks short of it, between them: the crosshair
      // meets the floor first, so the click's snapshot names no entity, and pointedTarget finds the husk within 4.
      const husk = await summonHusk(A.x - 9.5, A.z + 0.5);
      await look({ x: A.x - 6.5, y: A.y + 1, z: A.z + 0.5 });
      const before1 = ARCHERS.map(arrowsShot);
      const first = await clickFor('tir');
      await until(() => first.ended, 40_000, 'the tir at the husk to end');
      await sleep(1500);
      const after1 = ARCHERS.map(arrowsShot);
      const s1 = first.report.snap;
      const top1 = s1.lookBlock ? { x: s1.lookBlock.x + 0.5, z: s1.lookBlock.z + 0.5 } : null;
      const alive = await huskAlive();
      const ev1 =
        `#${first.id} ${describeTriggers(first)}; lookEntity ${s1.lookEntity?.name ?? 'none'}, lookBlock ${JSON.stringify(s1.lookBlock)} ` +
        `(${top1 ? hdist(top1, husk.position).toFixed(1) : '?'} from the husk); result "${first.report.result}"; ` +
        `archers' shots ${shots(before1, after1)}; husk ${alive ? 'alive' : 'dead'}`;
      if (triggers(first)[0]?.trigger !== 'use' || triggers(first)[0]?.item !== 'stick') throw new Error(`not a stick's use trigger: ${ev1}`);
      if (s1.lookEntity) throw new Error(`the click looked at an entity (the point must be beside the husk): ${ev1}`);
      if (!top1 || hdist(top1, husk.position) < 2 || hdist(top1, husk.position) > 4) throw new Error(`the point is not 2–4 blocks from the husk: ${ev1}`);
      if (alive || !/^Cible abattue \(husk\)/.test(String(first.report.result))) throw new Error(`the husk beside the point was not killed: ${ev1}`);

      // Empty ground north-west: nothing within 4 blocks of the point, so a volley of 3 per archer there.
      await killArrows();
      const point = { x: A.x - 5.5, y: A.y + 1, z: A.z - 9.5 };
      const around = othersNear(point, 4);
      if (around.length) throw new Error(`the empty ground is not empty: ${around.join(', ')}`);
      await look({ x: point.x, y: A.y + 1, z: point.z });
      const before2 = ARCHERS.map(arrowsShot);
      const second = await clickFor('tir');
      await until(() => second.ended, 40_000, 'the volley to end');
      await sleep(1500);
      const after2 = ARCHERS.map(arrowsShot);
      // Counted around where the click really pointed (its block's top centre).
      const aimed = topOf(second.report.snap) ?? point;
      const landed = await arrowsNear(aimed, 6);
      // Where each arrow lies, as the captain sees them: distance from the point.
      const lying = Object.values(cap().entities).filter((e) => e.name === 'arrow').map((e) => `${fmt(e.position)} (${hdist(e.position, aimed).toFixed(1)})`);
      const s2 = second.report.snap;
      const ev2 =
        `#${second.id} ${describeTriggers(second)}; lookEntity ${s2.lookEntity?.name ?? 'none'}; result "${second.report.result}"; ` +
        `archers' shots ${shots(before2, after2)}; arrows within 6 of the point: ${landed}; arrows seen: ${lying.join(', ')}`;
      const fired = before2.map((b, i) => after2[i]! - b);
      if (second.report.result !== 'Volée tirée : 6 flèches.' || fired.some((n) => n !== 3)) throw new Error(`a volley of 3 each was expected: ${ev2}`);
      if (landed < 4) throw new Error(`the volley did not land around the point: ${ev2}`);
      const unbound = await command('/bots orders unbind', /délié de ton objet/);
      return `"${bound}" | husk: ${ev1} | ground: ${ev2} | "${unbound}"`;
    });

    await clean('items: a bow bound to mur-de-boucliers (mod): the wall forms where the arrow lands, not at the release; sneak-draw stops', async () => {
      if (!viaMod) return skipped();
      // From 10 east of the middle, looking west 2° down: the crosshair meets nothing within `distance` (24), so the
      // release alone would put the wall 5 blocks ahead; the full-draw arrow lands about 20 blocks ahead.
      const from = { x: A.x + 10.5, y: A.y + 1, z: A.z + 0.5 };
      await rcon.command(`tp ${CAPTAIN.name} ${from.x} ${from.y} ${from.z} 90 0`);
      for (const [i, g] of GUARDS.entries()) await rcon.command(`tp ${g} ${from.x + i} ${from.y} ${from.z + 4}`);
      await killArrows();
      const bound = await bindHeld('bow', 'mur-de-boucliers');
      await rcon.command(`give ${CAPTAIN.name} arrow 16`);
      await sleep(1000);
      await look({ x: from.x - 50, y: from.y + 1.62 - 50 * Math.tan((2 * Math.PI) / 180), z: from.z });
      let order: Order | undefined;
      const watch = setInterval(() => (order ??= mine('mur-de-boucliers')), 50);
      try {
        cap().activateItem();
        await sleep(1200);
        cap().deactivateItem();
        await until(() => !!order, 5_000, 'a mur-de-boucliers started by the arrow');
        await until(() => triggers(order!).some((e) => e.trigger === 'arrow-hit'), 5_000, "the arrow's hit delivered");
      } finally {
        clearInterval(watch);
      }
      const o = order!;
      const release = o.report.snap;
      const hit = o.snap.trigger?.kind === 'arrow-hit' ? o.snap.trigger.hit?.position : undefined;
      if (!hit) throw new Error(`no hit position in the order's latest snapshot: ${describeTriggers(o)}`);
      const lineX = Math.floor(hit.x) + 0.5;
      const releaseX = from.x - 5; // where the release alone puts the wall
      const where =
        `#${o.id} ${describeTriggers(o)}; release lookBlock ${JSON.stringify(release.lookBlock)}; ` +
        `hit ${fmt({ x: hit.x, y: hit.y, z: hit.z })} (${(from.x - hit.x).toFixed(1)} blocks ahead)`;
      if (triggers(o)[0]?.trigger !== 'arrow-release' || triggers(o)[0]?.outcome !== 'started') throw new Error(`not started by the release: ${where}`);
      if (Math.abs(lineX - releaseX) < 6) throw new Error(`the hit is too close to the release's point to tell them apart: ${where}`);
      const wall = await checkWall('z', lineX, Math.floor(hit.z) + 0.5, 90, 'at the hit');
      const off = GUARDS.map((g) => Math.abs(pos(g)!.x - hit.x));
      const offs = off.map((d) => d.toFixed(2)).join(', ');
      if (off.some((d) => d > 1.5)) throw new Error(`a guard is more than 1.5 from the line through the hit (${offs}): ${wall}`);

      // Sneak + draw the bound bow: the stop gesture. The arrow shot while sneaking starts nothing.
      const said0 = chat.length;
      cap().setControlState('sneak', true);
      await sleep(400);
      await rightClick();
      await sleep(300);
      cap().setControlState('sneak', false);
      await until(() => o.ended, 5_000, 'the wall stopped by sneak + drawing the bow');
      await until(() => said(/« mur-de-boucliers » arrêté/, said0), 5_000, 'the stop line in chat');
      await sleep(1500);
      if (mine('mur-de-boucliers')) throw new Error('the arrow shot while sneaking started another wall');
      const unbound = await command('/bots orders unbind', /délié de ton objet/);
      return `"${bound}" | ${where} | wall: ${wall} | off the line through the hit: ${offs} | sneak-draw stopped it | "${unbound}"`;
    });

    await clean('items: epee bound to a stick (mod): beside a husk → the bots kill it; empty ground → they hold it', async () => {
      if (!viaMod) return skipped();
      await placeCaptain(90);
      await killArrows();
      const bound = await bindHeld('stick', 'epee');
      const husk = await summonHusk(A.x - 9.5, A.z + 0.5);
      const hp = husk.position.clone();
      await look({ x: A.x - 6.5, y: A.y + 1, z: A.z + 0.5 });
      const before = ARCHERS.map(arrowsShot);
      const n0 = notices.length;
      const o = await clickFor('epee');
      let most = 0;
      const end = Date.now() + 45_000;
      while (await huskAlive()) {
        if (Date.now() > end) throw new Error(`the husk still stands after 45 s (${describeTriggers(o)}; log ${o.report.logs.slice(-5).join(' | ')})`);
        most = Math.max(most, GUARDS.filter((g) => (pos(g)?.distanceTo(hp) ?? 99) <= 3).length);
        await sleep(250);
      }
      await until(() => notices.slice(n0).some((n) => /Cible abattue \(husk\)/.test(n.text)), 5_000, 'the « Cible abattue (husk). » line');
      const s0 = o.report.snap;
      if (s0.lookEntity) throw new Error(`the click looked at ${s0.lookEntity.name} (the point must be beside the husk)`);
      if (most > 2 || most < 1) throw new Error(`${most} guards on the husk at once (1–2 expected)`);
      const shot = ARCHERS.map((a, i) => arrowsShot(a) - before[i]!);

      // Empty ground: delivered to the same order, the bots hold around it (the point: the block the click hit).
      const aim = { x: A.x - 7.5, z: A.z + 8.5 };
      const busy = othersNear(aim, 4);
      if (busy.length) throw new Error(`the empty ground is not empty: ${busy.join(', ')}`);
      await look({ x: aim.x, y: A.y + 1, z: aim.z });
      await rightClick();
      await until(() => triggers(o).some((e) => e.outcome === 'delivered'), 5_000, 'the second click delivered');
      if (mine('epee') !== o) throw new Error('the second click started another order');
      const point = topOf(o.snap);
      if (!point || o.snap.lookEntity) {
        throw new Error(`the second click: lookBlock ${JSON.stringify(o.snap.lookBlock)}, lookEntity ${o.snap.lookEntity?.name ?? 'none'}`);
      }
      try {
        await until(() => holding(point), 40_000, 'the bots on their rings around the point');
      } catch (e) {
        throw new Error(`${(e as Error).message}: ${ringReport(point)}`);
      }
      const around = ALL.map((b) => `${b} ${hdist(pos(b)!, point).toFixed(1)} (slot ${hdist(pos(b)!, ringSlot(b, point)).toFixed(1)})`).join(', ');
      await api('/api/orders/stop', { by: CAPTAIN, target: `#${o.id}` });
      const unbound = await command('/bots orders unbind', /délié de ton objet/);
      return (
        `"${bound}" | #${o.id} ${describeTriggers(o)}; husk dead, at most ${most} guards within 3 of it, ` +
        `archers' shots ${shot.join('+')}; ground ${fmt(point)} held, each bot within ${RING_SLACK} of its ring slot: ${around} | "${unbound}"`
      );
    });

    await clean('items: epee (runtime): a husk looked at dies (archers + at most 2 guards); then the ground is held', async () => {
      // Arrows on the floor would be picked up by bots walking over them, and blur the archers' counts.
      await rcon.command(`kill @e[type=minecraft:arrow,x=${A.x - 30},y=${A.y - 10},z=${A.z - 30},dx=60,dy=40,dz=60]`);
      await placeCaptain(90);
      await rcon.command(`summon husk ${A.x - 9.5} ${A.y + 1} ${A.z + 0.5} {PersistenceRequired:1b,NoAI:1b,Tags:["${TAG}"]}`);
      await until(() => Object.values(cap().entities).some((e) => e.name === 'husk'), 5_000, 'the captain seeing the husk');
      const husk = Object.values(cap().entities).find((e) => e.name === 'husk')!;
      const hp = { x: husk.position.x, y: husk.position.y, z: husk.position.z };
      const before = ARCHERS.map(arrowsShot);
      const first = await trigger(
        'epee',
        snap(90, {
          heldItem: 'iron_sword',
          lookBlock: block(A.x - 10, A.z),
          lookEntity: { id: husk.id, name: 'husk', type: 'mob', position: hp },
          trigger: use('iron_sword'),
        }),
      );
      if (!first.ok || first.started !== true) throw new Error(`click: ${first.text}`);
      const id = String(first.orderId);
      const order = runner.get(id)!;
      // While it lives: how many guards stand within 3 blocks of it at once.
      let most = 0;
      const alive = async (): Promise<boolean> => /passed/i.test(await rcon.command(`execute if entity @e[type=minecraft:husk,tag=${TAG}]`));
      const end = Date.now() + 45_000;
      while (await alive()) {
        if (Date.now() > end) {
          throw new Error(`the husk still stands after 45 s (guards near it at most ${most}; log ${order.report.logs.slice(-5).join(' | ')})`);
        }
        most = Math.max(most, GUARDS.filter((g) => (pos(g)?.distanceTo(new Vec3(hp.x, hp.y, hp.z)) ?? 99) <= 3).length);
        await sleep(250);
      }
      await until(() => notices.some((n) => /Cible abattue \(husk\)/.test(n.text)), 5_000, 'the « Cible abattue (husk). » line');
      const shot = ARCHERS.map((a, i) => arrowsShot(a) - before[i]!);
      if (most > 2) throw new Error(`${most} guards were on the husk at once (2 at most)`);
      if (most < 1) throw new Error('no guard fought the husk');

      // The ground 8 west, 8 south: the bots hold around it (guards on a ring of 3, archers of 6).
      const point = { x: A.x - 7.5, z: A.z + 8.5 };
      const ground = await trigger('epee', snap(135, { heldItem: 'iron_sword', lookBlock: block(A.x - 8, A.z + 8), trigger: use('iron_sword') }));
      if (!ground.ok || ground.delivered !== true || String(ground.orderId) !== id) throw new Error(`ground click not delivered: ${JSON.stringify(ground)}`);
      try {
        await until(() => holding(point), 40_000, 'the bots on their rings around the point');
      } catch (e) {
        throw new Error(`${(e as Error).message}: ${ringReport(point)}`);
      }
      const around = ALL.map((b) => `${b} ${hdist(pos(b)!, point).toFixed(1)} (slot ${hdist(pos(b)!, ringSlot(b, point)).toFixed(1)})`).join(', ');
      await api('/api/orders/stop', { by: CAPTAIN, target: `#${id}` });
      return (
        `#${id}: husk dead, at most ${most} guards within 3 blocks of it at once, archers' shots ${shot.join('+')}; ` +
        `ground held, distances to the point: ${around}`
      );
    });

    await clean('items: ligne-archers (runtime): the archers line up across yaw 0, back 4 from the point', async () => {
      // From north of the captain, so they have to walk to the line (about 13 blocks).
      for (const [i, a] of ARCHERS.entries()) await rcon.command(`tp ${a} ${C.x - 2 * i} ${C.y} ${C.z - 4}`);
      await sleep(1000);
      // Looking south at the block 12 south: centre 4 short of the point, z = A.z + 8.5; archers along x, 2 apart.
      const r = await trigger('ligne-archers', snap(0, { heldItem: 'arrow', lookBlock: block(A.x, A.z + 12), trigger: use('arrow') }));
      if (!r.ok || r.started !== true) throw new Error(`click: ${r.text}`);
      const evidence = async (): Promise<string> => {
        const parts: string[] = [];
        for (const a of ARCHERS) parts.push(`${a} ${fmt(await rconPos(a))} yaw ${(await rconYaw(a)).toFixed(1)}`);
        return parts.join('; ');
      };
      try {
        await until(() => onLine(ARCHERS, 'x', A.z + 8.5, A.x + 0.5), 40_000, 'the archers on the line');
        await until(async () => {
          for (const a of ARCHERS) if (yawDiff(await rconYaw(a), 0) > 10) return false;
          return true;
        }, 10_000, 'the archers facing yaw 0');
      } catch (e) {
        throw new Error(`${(e as Error).message}: ${await evidence()}`);
      }
      const xs = ARCHERS.map((a) => pos(a)!.x).sort((a, b) => a - b);
      if (Math.abs(xs[1]! - xs[0]! - 2) > 0.8) throw new Error(`spacing ${(xs[1]! - xs[0]!).toFixed(2)} (2 expected): ${await evidence()}`);
      const line = await evidence();
      await api('/api/orders/stop', { by: CAPTAIN, target: `#${r.orderId}` });
      return `#${r.orderId}: ${line}`;
    });

    await clean('items: ligne-archers (runtime) at yaws not axis-aligned: each archer on its exact place, a straight line (two at 45°; two at 87° 1 apart, whose places share a block: docs/35 F4, as the wall)', async () => {
      /**
       * The line the archers form for a click on the block `look` across `yaw`, with `tokens` (`back`, `spacing`): each
       * archer within 0.2 of its own exact place (lineSlots through the centre `back` short of the block's top centre,
       * as the order computes it; RCON Pos for the ground truth), on the line, no two closer than 0.6 (a body's width),
       * facing the yaw. A click whose args differ from the running line's restarts it with them (docs/35 F5).
       */
      const exactLine = async (yaw: number, look: { x: number; z: number }, back: number, spacing: number, what: string): Promise<string> => {
        const fwd = lookDir(yaw);
        const centre = new Vec3(look.x + 0.5 - fwd.x * back, A.y + 1, look.z + 0.5 - fwd.z * back);
        const places = lineSlots(centre, yaw, ARCHERS.length, { spacing });
        const onPlaces = (ps: Vec3[]): boolean => places.every((s) => ps.filter((p) => hdist(p, s) <= 0.2).length === 1);
        const evidence = async (): Promise<string> => {
          const parts: string[] = [];
          for (const a of ARCHERS) {
            const p = await rconPos(a);
            parts.push(`${a} ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} (${Math.min(...places.map((s) => hdist(p, s))).toFixed(2)} off a place) yaw ${(await rconYaw(a)).toFixed(1)}`);
          }
          return `${parts.join('; ')}; places ${places.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`).join(' ')}`;
        };
        const r = await api('/api/orders/trigger', {
          by: CAPTAIN,
          command: 'ligne-archers',
          tokens: [`back=${back}`, `spacing=${spacing}`],
          filters: [],
          snap: snap(yaw, { heldItem: 'arrow', lookBlock: block(look.x, look.z), trigger: use('arrow') }),
        });
        if (!r.ok) throw new Error(`${what}: click: ${r.text}`);
        try {
          await until(() => onPlaces(ARCHERS.map((a) => pos(a)!)), 40_000, `the archers on their exact places (${what})`);
          await until(async () => {
            for (const a of ARCHERS) if (yawDiff(await rconYaw(a), yaw) > 10) return false;
            return true;
          }, 10_000, `the archers facing yaw ${yaw} (${what})`);
          const ps: Vec3[] = [];
          for (const a of ARCHERS) ps.push(await rconPos(a));
          if (!onPlaces(ps)) throw new Error('the server does not have each archer within 0.2 of its place');
          const offLine = Math.max(...ps.map((p) => Math.abs((p.x - centre.x) * fwd.x + (p.z - centre.z) * fwd.z)));
          if (offLine > 0.2) throw new Error(`an archer ${offLine.toFixed(2)} off the line`);
          let closest = Infinity;
          for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) closest = Math.min(closest, hdist(ps[i]!, ps[j]!));
          if (closest < 0.6) throw new Error(`two archers ${closest.toFixed(2)} apart`);
          return `${what} (#${r.orderId}): ${await evidence()}; at most ${offLine.toFixed(2)} off the line, the two ${closest.toFixed(2)} apart`;
        } catch (e) {
          throw new Error(`${(e as Error).message}: ${await evidence()}`);
        }
      };
      // Two at 45° (looking south-west at a block about 8 ahead), back 4 and spacing 2 (the defaults): their places lie
      // off their blocks' centres.
      const diagonal = await exactLine(45, { x: A.x - 6, z: A.z + 6 }, 4, 2, 'two at 45°');
      // Two at 87°, 1 apart with back 0: their places, half a block either side of the point's block centre, share that
      // block, where both stood before (docs/35 F2 for the wall).
      const pair = await exactLine(87, { x: A.x - 8, z: A.z }, 0, 1, 'two at 87°, spacing 1, back 0');
      return `${diagonal} | ${pair}`;
    });

    await clean('items: ligne-archers behind a mur-de-boucliers: the archers, 2 blocks behind the guards, shoot over them and kill a husk 6 blocks beyond the wall', async () => {
      // The wall along x at z = A.z + 6.5 facing south, the archers' line 2 blocks behind it (back=2): each archer has
      // a guard right in front of it. Before, the flat arc went into the guards' backs (hawkEye checks blocks only).
      const wall = await trigger('mur-de-boucliers', shieldClick(0, block(A.x, A.z + 6)));
      if (!wall.ok || wall.started !== true) throw new Error(`wall: ${wall.text}`);
      await checkWall('x', A.z + 6.5, A.x + 0.5, 0, 'the wall');
      const r = await api('/api/orders/trigger', { by: CAPTAIN, command: 'ligne-archers', tokens: ['back=2'], filters: [], snap: snap(0, { heldItem: 'arrow', lookBlock: block(A.x, A.z + 6), trigger: use('arrow') }) });
      if (!r.ok || r.started !== true) throw new Error(`line: ${r.text}`);
      await until(() => onLine(ARCHERS, 'x', A.z + 4.5, A.x + 0.5), 40_000, 'the archers 2 blocks behind the wall');
      const slots = ARCHERS.map((a) => pos(a)!.clone());
      const before = ARCHERS.map(arrowsShot);
      const line = runner.get(String(r.orderId))!;
      // Each arrow's launch speed (blocks per tick) from its spawn packet, as the captain sees it: the draw the server
      // counted (BowItem: pull × 3), against the one shoot asked for.
      const speeds: number[] = [];
      const onSpawn = (e: { name?: string; position: Vec3; velocity: Vec3 }): void => {
        if (e.name === 'arrow' && slots.some((s) => hdist(e.position, s) < 2)) speeds.push(Math.round(e.velocity.norm() * 100) / 100);
      };
      cap().on('entitySpawn', onSpawn as never);
      await rcon.command(`summon husk ${A.x + 0.5} ${A.y + 1} ${A.z + 12.5} {PersistenceRequired:1b,NoAI:1b,Tags:["${TAG}"]}`);
      const huskGone = async (): Promise<boolean> => !/passed/i.test(await rcon.command(`execute if entity @e[type=minecraft:husk,tag=${TAG}]`));
      const histogram = (): string => {
        const n = new Map<number, number>();
        for (const s of speeds) n.set(s, (n.get(s) ?? 0) + 1);
        return [...n].sort((a, b) => a[0] - b[0]).map(([s, c]) => `${s}×${c}`).join(' ');
      };
      try {
        await until(huskGone, 60_000, 'the archers killing the husk over the wall');
      } catch (e) {
        throw new Error(`${(e as Error).message}: arrows used ${ARCHERS.map((a, i) => arrowsShot(a) - before[i]!).join(', ')}; speeds ${histogram()}; ${line.report.logs.slice(-6).join(' | ')}`);
      } finally {
        cap().off('entitySpawn', onSpawn as never);
      }
      const used = ARCHERS.map((a, i) => arrowsShot(a) - before[i]!);
      const moved = ARCHERS.map((a, i) => hdist(pos(a)!, slots[i]!));
      if (moved.some((d) => d > 1)) throw new Error(`an archer left its slot to shoot (${moved.map((d) => d.toFixed(1)).join(', ')}): ${line.report.logs.slice(-6).join(' | ')}`);
      if (!GUARDS.every(shieldUp)) throw new Error(`a guard lowered its shield: ${await wallEvidence()}`);
      const sidesteps = line.report.logs.filter((l) => /no clear line of fire/.test(l)).length;
      return `husk 6 beyond the wall killed; arrows ${used.join(', ')}; launch speeds ${histogram()}; archers on their slots (${moved.map((d) => d.toFixed(1)).join(', ')}); "no clear line of fire" ${sidesteps}; ${await wallEvidence()}`;
    });

    await clean('items: a reclaimed guard comes back and works: defend → wall reclaims the guards → stop → they follow again', async () => {
      await placeCaptain(90);
      const d = await api('/api/orders/start', { by: CAPTAIN, command: 'defend', tokens: ['radius=16'], snap: snap(90) });
      if (!d.ok) throw new Error(`defend: ${d.text}`);
      const defend = runner.get(String(d.orderId))!;
      if (defend.memberNames().sort().join() !== [...ALL].sort().join()) throw new Error(`defend got ${defend.memberNames().join()}`);
      await until(() => GUARDS.every((g) => hdist(pos(g)!, C) <= 5), 30_000, 'the guards around the captain (defend)');

      // A wall 10 west reclaims the three guards; the archers stay in defend.
      const w = await trigger('mur-de-boucliers', snap(90, { lookBlock: block(A.x - 10, A.z), heldItem: 'shield', trigger: use('shield') }));
      if (!w.ok || w.started !== true) throw new Error(`wall: ${w.text}`);
      const wall = runner.get(String(w.orderId))!;
      if (wall.memberNames().sort().join() !== [...GUARDS].sort().join()) throw new Error(`the wall got ${wall.memberNames().join()}`);
      if (defend.memberNames().sort().join() !== [...ARCHERS].sort().join()) throw new Error(`defend kept ${defend.memberNames().join()}`);
      await until(() => onLine(GUARDS, 'z', A.x - 9.5, A.z + 0.5, 1.5), 40_000, 'the guards on the wall');
      const onWall = GUARDS.map((g) => pos(g)!.clone());

      // Stop the wall: the guards go back to defend, and follow the captain to a new spot.
      const s = await trigger('mur-de-boucliers', snap(90, { trigger: use('shield') }), true);
      if (!s.ok || s.stopped !== true) throw new Error(`stop: ${s.text}`);
      await until(() => GUARDS.every((g) => defend.memberNames().includes(g)), 10_000, 'the guards back in defend');
      const to = { x: C.x + 6, y: C.y, z: C.z - 8 };
      await rcon.command(`tp ${CAPTAIN.name} ${to.x} ${to.y} ${to.z}`);
      try {
        await until(() => GUARDS.every((g) => hdist(pos(g)!, to) <= 5), 40_000, 'the returned guards following the captain to the new spot');
      } catch (e) {
        const where = GUARDS.map((g) => `${g} ${fmt(pos(g))} (${hdist(pos(g)!, to).toFixed(1)})`).join(', ');
        throw new Error(`${(e as Error).message}: ${where}; defend log: ${defend.report.logs.slice(-5).join(' | ')}`);
      }
      const near = GUARDS.map((g, i) => `${g} ${hdist(pos(g)!, to).toFixed(1)} (walked ${hdist(pos(g)!, onWall[i]!).toFixed(1)} from the wall)`).join(', ');
      await api('/api/orders/stop', { by: CAPTAIN, target: 'all' });
      return `defend #${defend.id}: guards reclaimed by wall #${wall.id} and back after the stop; then within ${near} of the captain's new spot`;
    });

    // -- a bot that dies (docs/35 F6, F7): it drops nothing, stays off, and /bots squad respawn brings it back --------

    /** `data get entity NAME Inventory`, as `id×count` (enchantments appended), sorted. */
    const inventoryOf = async (name: string): Promise<string[]> => {
      const r = await rcon.command(`data get entity ${name} Inventory`);
      // The list's top-level compounds, by brace depth (an enchanted stack nests four deep), quotes skipped.
      const stacks: string[] = [];
      let depth = 0;
      let from = -1;
      let quoted = false;
      const list = r.slice(r.indexOf('['));
      for (let i = 0; i < list.length; i++) {
        const ch = list[i];
        if (ch === '"' && list[i - 1] !== '\\') quoted = !quoted;
        if (quoted) continue;
        if (ch === '{' && depth++ === 0) from = i;
        else if (ch === '}' && --depth === 0) stacks.push(list.slice(from + 1, i));
      }
      const out: string[] = [];
      for (const s of stacks) {
        const id = /id: "minecraft:([a-z_]+)"/.exec(s)?.[1];
        if (!id) continue;
        const count = Number(/count: (\d+)/.exec(s)?.[1] ?? 1);
        const levels = [...s.matchAll(/"minecraft:([a-z_]+)": (\d+)/g)].map((e) => `${e[1]} ${e[2]}`).sort();
        out.push(`${id}×${count}${levels.length ? ` (${levels.join(', ')})` : ''}`);
      }
      return out.sort();
    };
    const itemsNear = async (p: { x: number; y: number; z: number }, r: number): Promise<number> => {
      const t = await rcon.command(`execute positioned ${p.x} ${p.y} ${p.z} if entity @e[type=minecraft:item,distance=..${r}]`);
      return Number(/count: (\d+)/.exec(t)?.[1] ?? 0);
    };

    await clean('items: a bot that dies drops nothing and stays off; /bots squad respawn archers 1 brings the archer back by the captain with exactly its kit (mod)', async () => {
      if (!viaMod) return skipped();
      const archer = ARCHERS[1]!;
      const guard = GUARDS[2]!;
      await placeCaptain(90);
      await api('/api/bots/tag', { by: k.admin, admin: true, name: archer, changes: ['+archer'] });
      await api('/api/bots/tag', { by: k.admin, admin: true, name: guard, changes: ['+guard'] });
      await rcon.command(`kill @e[type=minecraft:item,x=${A.x - 30},y=${A.y - 10},z=${A.z - 30},dx=60,dy=40,dz=60]`);
      await sleep(1000); // the mod's cache of the roster (its tags) refreshes on the state event
      const spots = { [archer]: await rconPos(archer), [guard]: await rconPos(guard) };
      await rcon.command(`kill ${archer}`);
      await rcon.command(`kill ${guard}`);
      await until(() => [archer, guard].every((n) => pool.status(n) === 'offline' && rt.service.deps.roster.get(n)?.dead === true), 20_000, 'both dead and off');
      await sleep(500);
      const dropped: string[] = [];
      for (const n of [archer, guard]) dropped.push(`${n} ${await itemsNear(spots[n]!, 4)}`);
      if (dropped.some((d) => !d.endsWith(' 0'))) throw new Error(`items lie where they died: ${dropped.join(', ')}`);
      // Past the first reconnect backoffs: still off.
      await sleep(3_000);
      if ([archer, guard].some((n) => pool.status(n) !== 'offline')) throw new Error(`a dead bot came back on its own: ${[archer, guard].map((n) => `${n} ${pool.status(n)}`).join(', ')}`);
      const list = await api('/api/bots/list', { by: CAPTAIN });

      // The captain's datapack-style call: @s is the captain, the archers' kit, one bot.
      await rcon.command(`execute as ${CAPTAIN.name} at @s run bots squad respawn archers 1`);
      await until(() => pool.status(archer) === 'online', 30_000, 'the archer back online');
      const want = ['arrow×64', 'bow×1 (infinity 1, unbreaking 3)', 'chainmail_boots×1', 'chainmail_chestplate×1', 'chainmail_helmet×1', 'chainmail_leggings×1', 'cooked_beef×16', 'stone_sword×1'];
      let have: string[] = [];
      try {
        await until(async () => (have = await inventoryOf(archer)).join() === want.join(), 10_000, 'the archer with exactly its kit');
      } catch (e) {
        throw new Error(`${(e as Error).message}: ${have.join(', ') || 'empty'}`);
      }
      const at = await rconPos(archer);
      const health = floats(await rcon.command(`data get entity ${archer} Health`))[0] ?? 0;
      if (hdist(at, C) > 6) throw new Error(`the archer came back ${hdist(at, C).toFixed(1)} from the captain, at ${fmt(at)}`);
      if (!(health > 0)) throw new Error(`the archer is not alive: Health ${health}`);
      await sleep(2_000);
      if (pool.status(guard) !== 'offline' || rt.service.deps.roster.get(guard)?.dead !== true) throw new Error(`the guard did not stay dead: ${pool.status(guard)}`);
      return (
        `items where they died: ${dropped.join(', ')}; both off for 3 s; list: ${String(list.text).split('\n').filter((l) => /mort/.test(l)).join(' / ')}; ` +
        `${archer} back at ${fmt(at)} (${hdist(at, C).toFixed(1)} from the captain), Health ${health}, inventory ${have.join(', ')}; ${guard} still dead`
      );
    });
  } finally {
    await api('/api/orders/stop', { by: CAPTAIN, target: 'all' }).catch(() => undefined);
    for (const name of ALL) await api('/api/bots/despawn', { by: k.admin, admin: true, name }).catch(() => undefined);
    captain?.quit();
    await rcon.command(`kill @e[type=!minecraft:player,x=${A.x - 30},y=${A.y - 10},z=${A.z - 30},dx=60,dy=40,dz=60]`).catch(() => '');
    await rcon.command(`forceload remove ${A.x - 32} ${A.z - 32} ${A.x + 32} ${A.z + 32}`).catch(() => '');
  }
}
