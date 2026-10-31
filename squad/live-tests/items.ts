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
//     mod sends the triggers. Those need the dev mod talking to this runtime: run/squad.properties with
//     url=http://127.0.0.1:8779 and token=live-test-token, and LIVE_RUNTIME_PORT=8779. Otherwise they are skipped.

import { createHash } from 'node:crypto';

import mineflayer, { type Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

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

/** The port run/squad.properties points the dev mod at. */
export const MOD_RUNTIME_PORT = 8779;

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
  const arrows = (name: string): number =>
    pool
      .bot(name)!
      .inventory.items()
      .filter((i) => i.name === 'arrow')
      .reduce((s, i) => s + i.count, 0);

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
        await rcon.command(`give ${a} bow`);
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

    await scenario('items: mur-de-boucliers (runtime): a wall across yaw 90, re-formed across yaw 0 by a second click, a husk fought at the line', async () => {
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
      // A husk 2 blocks in front of the wall (within `reach` 4 of the slots), more than STUCK_MS (10 s) after the
      // guards reached their slots: fought at the slot, then each guard is back on its slot exactly. (Its stuck timer
      // used to run from the first walk, so it came back to a loose goal and stood up to 2.5 blocks off: docs/29 §16.)
      await sleep(11_000);
      await rcon.command(`summon husk ${A.x + 0.5} ${A.y + 1} ${A.z + 8.5} {PersistenceRequired:1b,NoAI:1b,Tags:["${TAG}"]}`);
      const huskGone = async (): Promise<boolean> => !/passed/i.test(await rcon.command(`execute if entity @e[type=minecraft:husk,tag=${TAG}]`));
      await until(huskGone, 30_000, 'the guards killing the husk in front of the wall');
      const after = await checkWall('x', A.z + 6.5, A.x + 0.5, 0, 'after the fight');
      const slotsSouth = [-0.5, 0.5, 1.5].map((dx) => ({ x: A.x + dx, z: A.z + 6.5 }));
      const off = GUARDS.map((g) => Math.min(...slotsSouth.map((s) => hdist(pos(g)!, s))));
      if (off.some((d) => d > 0.8)) throw new Error(`after the fight a guard holds off its slot (${off.map((d) => d.toFixed(2)).join(', ')} blocks): ${after}`);
      const order = runner.get(id)!;
      const stop = await trigger('mur-de-boucliers', snap(0, { trigger: use('shield') }), true);
      if (!stop.ok || stop.stopped !== true) throw new Error(`stop: ${stop.text}`);
      // Leaving the order lowers the shield (the abort sequence's deactivateItem).
      await until(() => GUARDS.every((g) => !shieldUp(g)), 5_000, 'the shields lowered after the stop');
      return (
        `#${id} (${describeTriggers(order)}); ${POCKET}'s shield equipped from the inventory into the off-hand; ` +
        `west: ${west} | south: ${south} | husk 2 blocks in front killed, back in line: ${after} | stopped: "${stop.text}", shields down`
      );
    });

    await scenario('items: mur-de-boucliers through the mod: bind, click, click again, sneak-click, unbind', async () => {
      if (!viaMod) return `skipped (the runtime is on port ${rt.port}: LIVE_RUNTIME_PORT=${MOD_RUNTIME_PORT} with run/squad.properties pointing at it)`;
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
    const shots = (before: number[], after: number[]): string => ARCHERS.map((a, i) => `${a} ${before[i]}→${after[i]}`).join(', ');
    const arrowsNear = async (p: { x: number; y: number; z: number }, r: number): Promise<number> => {
      const t = await rcon.command(`execute positioned ${p.x} ${p.y} ${p.z} if entity @e[type=minecraft:arrow,distance=..${r}]`);
      return Number(/count: (\d+)/.exec(t)?.[1] ?? 0);
    };

    await scenario('items: tir through the mod: the captain shoots the ground, arrow-release then arrow-hit (onBlockHit), a volley of 3 each', async () => {
      if (!viaMod) return `skipped (the runtime is on port ${rt.port}: LIVE_RUNTIME_PORT=${MOD_RUNTIME_PORT} with run/squad.properties pointing at it)`;
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
      const before = ARCHERS.map(arrows);
      const captainBefore = captainArrows();

      // The floor 15 blocks west.
      const order = await shootBound({ x: A.x - 14.5, y: A.y + 0.9, z: A.z + 0.5 });
      const after = ARCHERS.map(arrows);
      const ev = triggers(order);
      const release = ev.find((e) => e.trigger === 'arrow-release');
      const hit = ev.find((e) => e.trigger === 'arrow-hit');
      const landed = hit?.pos ? await arrowsNear({ x: hit.pos[0] + 0.5, y: hit.pos[1], z: hit.pos[2] + 0.5 }, 6) : 0;
      const evidence =
        `#${order.id} ${describeTriggers(order)}; result "${order.report.result}"; archers' arrows ${shots(before, after)}; ` +
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
      const fired = before.map((b, i) => b - after[i]!);
      if (order.report.result !== 'Volée tirée : 6 flèches.' || fired.some((n) => n !== 3)) {
        throw new Error(`a volley of exactly 3 arrows each was expected: ${evidence}`);
      }
      // The volley lands around the hit (spread 3): the captain's arrow and most of the archers' six.
      if (landed < 5) throw new Error(`the volley did not land around the hit: ${evidence}`);
      return `"${bound}" | "${listed}" | ${evidence}`;
    });

    await scenario('items: tir through the mod: the captain shoots a husk, arrow-hit names it (onEntityHit), the archers kill it', async () => {
      if (!viaMod) return `skipped (the runtime is on port ${rt.port}: LIVE_RUNTIME_PORT=${MOD_RUNTIME_PORT} with run/squad.properties pointing at it)`;
      await placeCaptain(90);
      await rcon.command(`summon husk ${A.x - 9.5} ${A.y + 1} ${A.z + 0.5} {PersistenceRequired:1b,NoAI:1b,Tags:["${TAG}"]}`);
      await until(() => Object.values(cap().entities).some((e) => e.name === 'husk'), 5_000, 'the captain seeing the husk');
      const husk = Object.values(cap().entities).find((e) => e.name === 'husk')!;
      const before = ARCHERS.map(arrows);
      // At its chest: at 10 blocks a full-draw arrow flies nearly straight.
      const order = await shootBound({ x: husk.position.x, y: husk.position.y + 1.2, z: husk.position.z });
      const after = ARCHERS.map(arrows);
      const ev = triggers(order);
      const release = ev.find((e) => e.trigger === 'arrow-release');
      const hit = ev.find((e) => e.trigger === 'arrow-hit');
      const alive = /passed/i.test(await rcon.command(`execute if entity @e[type=minecraft:husk,tag=${TAG}]`));
      const evidence =
        `#${order.id} ${describeTriggers(order)} (release looks at ${release?.entity ?? 'nothing'}, hit ${hit?.entity ?? 'no entity'}); ` +
        `result "${order.report.result}"; archers' arrows ${shots(before, after)}; husk ${alive ? 'alive' : 'dead'}`;
      if (release?.outcome !== 'started' || release.entity !== 'husk') throw new Error(`the release did not start tir at the husk: ${evidence}`);
      if (hit?.outcome !== 'delivered' || hit.entity !== 'husk') throw new Error(`no arrow-hit naming the husk: ${evidence}`);
      if (alive || !/^Cible abattue \(husk\)/.test(String(order.report.result))) throw new Error(`the husk was not killed: ${evidence}`);
      if (before.every((b, i) => b === after[i])) throw new Error(`no archer shot: ${evidence}`);
      await command('/bots orders unbind', /délié de ton objet/);
      return evidence;
    });

    await scenario('items: epee (runtime): a husk looked at dies (archers + at most 2 guards); then the ground is held', async () => {
      // Arrows on the floor would be picked up by bots walking over them, and blur the archers' counts.
      await rcon.command(`kill @e[type=minecraft:arrow,x=${A.x - 30},y=${A.y - 10},z=${A.z - 30},dx=60,dy=40,dz=60]`);
      await placeCaptain(90);
      await rcon.command(`summon husk ${A.x - 9.5} ${A.y + 1} ${A.z + 0.5} {PersistenceRequired:1b,NoAI:1b,Tags:["${TAG}"]}`);
      await until(() => Object.values(cap().entities).some((e) => e.name === 'husk'), 5_000, 'the captain seeing the husk');
      const husk = Object.values(cap().entities).find((e) => e.name === 'husk')!;
      const hp = { x: husk.position.x, y: husk.position.y, z: husk.position.z };
      const before = ARCHERS.map(arrows);
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
      const shot = ARCHERS.map((a, i) => before[i]! - arrows(a));
      if (most > 2) throw new Error(`${most} guards were on the husk at once (2 at most)`);
      if (most < 1) throw new Error('no guard fought the husk');

      // The ground 8 west, 8 south: the bots hold around it (guards on a ring of 3, archers of 6).
      const point = { x: A.x - 7.5, z: A.z + 8.5 };
      const ground = await trigger('epee', snap(135, { heldItem: 'iron_sword', lookBlock: block(A.x - 8, A.z + 8), trigger: use('iron_sword') }));
      if (!ground.ok || ground.delivered !== true || String(ground.orderId) !== id) throw new Error(`ground click not delivered: ${JSON.stringify(ground)}`);
      try {
        const held = (): boolean => GUARDS.every((g) => hdist(pos(g)!, point) <= 4.5) && ARCHERS.every((a) => hdist(pos(a)!, point) <= 7.5);
        await until(held, 40_000, 'the bots around the point');
      } catch (e) {
        throw new Error(`${(e as Error).message}: ${ALL.map((b) => `${b} ${hdist(pos(b)!, point).toFixed(1)}`).join(', ')}`);
      }
      const around = ALL.map((b) => `${b} ${hdist(pos(b)!, point).toFixed(1)}`).join(', ');
      await api('/api/orders/stop', { by: CAPTAIN, target: `#${id}` });
      return (
        `#${id}: husk dead, at most ${most} guards within 3 blocks of it at once, archers' shots ${shot.join('+')}; ` +
        `ground held, distances to the point: ${around}`
      );
    });

    await scenario('items: ligne-archers (runtime): the archers line up across yaw 0, back 4 from the point', async () => {
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

    await scenario('items: a reclaimed guard comes back and works: defend → wall reclaims the guards → stop → they follow again', async () => {
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
  } finally {
    await api('/api/orders/stop', { by: CAPTAIN, target: 'all' }).catch(() => undefined);
    for (const name of ALL) await api('/api/bots/despawn', { by: k.admin, admin: true, name }).catch(() => undefined);
    captain?.quit();
    await rcon.command(`kill @e[type=!minecraft:player,x=${A.x - 30},y=${A.y - 10},z=${A.z - 30},dx=60,dy=40,dz=60]`).catch(() => '');
    await rcon.command(`forceload remove ${A.x - 32} ${A.z - 32} ${A.x + 32} ${A.z + 32}`).catch(() => '');
  }
}
