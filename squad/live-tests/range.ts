// A measurement, not a pass/fail test (docs/35 F4, LIVE_ONLY=range; dev world only, through the mod): how often the
// archer line's arrows hit bots that move, by distance, now that `ligne-archers` shoots out to 120 blocks.
//
// A captain (LiveCaptain) and four archers of theirs (Infinity bows) stand at the east end of a stone strip laid at
// y 100 from x 1270 to 1408 (z 990–1010, 200 blocks from the items arena). The archers form a `ligne-archers` facing
// west; then `/bots raid 110 0 4` (run as the captain over RCON) sets four enemy guards (iron armour, no shield up)
// 110 blocks west, and they march on the captain. Every arrow an archer shoots is its own spawn packet (owner = the
// archer); its distance is the archer's to its target when `shoot` was called; a hit is a damage_event whose direct
// source is that arrow (an arrow into hurt immunity or a shield does no damage and is not one). Hits per arrow, by
// distance, go to the console and result.json. Runs until the raiders are dead or 120 s.

import { HELPERS } from '../src/api/helpers';
import { unwrap } from '../src/orders/guard';
import { MOD_RUNTIME_PORT, offlineUuid, type LiveKit } from './items';

import mineflayer, { type Bot } from 'mineflayer';

import { RECIPES_AS_BYTES } from '../src/bots/protocol';

const CAPTAIN = { uuid: offlineUuid('LiveCaptain'), name: 'LiveCaptain' };
const ARCHERS = ['LiveRange1', 'LiveRange2', 'LiveRange3', 'LiveRange4'];
/** The east end of the strip: the captain's block. */
const E = { x: 1400, y: 100, z: 1000 };
const WEST = 132; // the strip runs this far west of E, past the raid's point (110)
const BOW = 'bow[enchantments={levels:{"minecraft:infinity":1,"minecraft:unbreaking":3}}]';
/** Distance buckets (blocks) for the report. */
const BUCKETS = [0, 30, 60, 90, 121];

type Shoot = typeof HELPERS.shoot;

export async function rangeScenario(k: LiveKit): Promise<void> {
  const { rcon, rt, api, scenario, until, sleep } = k;
  const { pool, runner } = rt.service.deps;
  if (!k.setupWorld || rt.port !== MOD_RUNTIME_PORT) {
    await scenario('range: the archer line against a moving raid, hits per arrow by distance', async () => 'skipped (dev world, through the mod: LIVE_RUNTIME_PORT=8779)');
    return;
  }
  let captain: Bot | undefined;
  const helpers = HELPERS as { shoot: Shoot };
  const realShoot = helpers.shoot;
  try {
    await scenario('range: the archer line against a moving raid, hits per arrow by distance', async () => {
      await rcon.command(`forceload add ${E.x - WEST - 16} ${E.z - 16} ${E.x + 16} ${E.z + 16}`);
      // In slices: /fill takes at most 32768 blocks.
      for (let x = E.x - WEST; x <= E.x + 8; x += 30) {
        const x2 = Math.min(E.x + 8, x + 29);
        await rcon.command(`fill ${x} ${E.y} ${E.z - 10} ${x2} ${E.y} ${E.z + 10} stone`);
        await rcon.command(`fill ${x} ${E.y + 1} ${E.z - 10} ${x2} ${E.y + 20} ${E.z + 10} air`);
      }
      // Every mob in reach of the line: 120 blocks reach the drowned of the ocean below the strip.
      await rcon.command(`execute positioned ${E.x - WEST / 2} ${E.y} ${E.z} run kill @e[type=!minecraft:player,distance=..200]`);

      captain = mineflayer.createBot({ host: '127.0.0.1', port: k.mcPort, username: CAPTAIN.name, auth: 'offline', version: k.mcVersion, customPackets: RECIPES_AS_BYTES } as Parameters<typeof mineflayer.createBot>[0]);
      await until(() => !!captain?.entity, 30_000, 'the captain in game');
      await rcon.command(`tp ${CAPTAIN.name} ${E.x + 0.5} ${E.y + 1} ${E.z + 0.5} 90 0`);
      await rcon.command(`effect give ${CAPTAIN.name} minecraft:resistance infinite 4 true`);
      await rcon.command(`gamemode creative ${CAPTAIN.name}`); // the raid hunts them: out of the fight

      for (const name of ARCHERS) {
        if (pool.status(name) !== 'online') {
          const r = await api('/api/bots/spawn', { by: k.admin, admin: true, name, owners: [CAPTAIN] });
          if (!r.ok) throw new Error(r.text);
        }
      }
      await until(() => ARCHERS.every((b) => pool.status(b) === 'online'), 90_000, 'the archers online');
      await sleep(1500);
      for (const [i, a] of ARCHERS.entries()) {
        await rcon.command(`tp ${a} ${E.x - 2} ${E.y + 1} ${E.z - 6 + 4 * i}`);
        await rcon.command(`clear ${a}`);
        await rcon.command(`give ${a} ${BOW}`);
        await rcon.command(`give ${a} arrow 64`);
        await rcon.command(`item replace entity ${a} armor.chest with minecraft:netherite_chestplate`);
        await rcon.command(`effect give ${a} minecraft:resistance infinite 2 true`);
        await rcon.command(`effect give ${a} minecraft:saturation infinite 1 true`);
      }
      await sleep(1500);

      // Every shoot call: the archer, its target, the distance.
      const lastAim = new Map<string, { dist: number; target: string; raider: boolean }>();
      helpers.shoot = ((bot, target, opts) => {
        const real = unwrap(bot) as Bot;
        const t = target as { position?: { x: number; y: number; z: number }; username?: string; name?: string } | null;
        if (t?.position && real.entity) {
          lastAim.set(real.username, { dist: real.entity.position.distanceTo(t.position as never), target: t.username ?? t.name ?? '?', raider: /^Enn/.test(t.username ?? '') });
        }
        return realShoot(bot, target, opts);
      }) as Shoot;

      // The arrows each archer shoots (its own spawn packets), and the hits (any archer's damage_event).
      const arrows = new Map<number, { archer: string; dist: number; raider: boolean; hit: boolean }>();
      const hits: Array<{ arrow: number; victim: number }> = [];
      for (const name of ARCHERS) {
        const b = pool.bot(name)!;
        const arrowType = (b.registry.entitiesByName.arrow as { internalId?: number; id: number }).internalId ?? b.registry.entitiesByName.arrow!.id;
        b._client.on('spawn_entity', (p: { entityId: number; type: number; objectData?: number }) => {
          if (p.type !== arrowType || p.objectData !== b.entity?.id) return;
          const aim = lastAim.get(name);
          arrows.set(p.entityId, { archer: name, dist: aim?.dist ?? -1, raider: aim?.raider ?? false, hit: false });
        });
        b._client.on('damage_event', (p: { entityId: number; sourceDirectId: number }) => {
          const a = arrows.get(p.sourceDirectId - 1);
          if (!a || a.hit) return;
          a.hit = true;
          hits.push({ arrow: p.sourceDirectId - 1, victim: p.entityId });
        });
      }

      const line = await api('/api/orders/trigger', {
        by: CAPTAIN,
        command: 'ligne-archers',
        tokens: ['back=0'],
        filters: [],
        snap: { position: { x: E.x + 0.5, y: E.y + 1, z: E.z + 0.5 }, yaw: 90, pitch: 10, dimension: 'overworld', heldItem: 'arrow', lookBlock: { x: E.x - 6, y: E.y, z: E.z, name: 'stone' }, lookEntity: null, trigger: { kind: 'use', item: 'arrow' } },
      });
      if (!line.ok) throw new Error(`line: ${line.text}`);
      const order = runner.get(String(line.orderId))!;
      await sleep(8_000); // on the line

      await rcon.command(`tp ${CAPTAIN.name} ${E.x + 0.5} ${E.y + 1} ${E.z + 0.5} 90 0`);
      await sleep(500);
      await rcon.command(`execute as ${CAPTAIN.name} at @s run bots raid 110 0 4`);
      const enemies = (): string[] => rt.service.deps.roster.all().filter((b) => b.owners.some((o) => o.name === 'Envahisseur')).map((b) => b.name);
      await until(() => enemies().length >= 4, 60_000, 'the raiders spawned');
      const raiders = enemies();
      const t0 = Date.now();
      // The raiders dead (a dead bot quits and is marked dead, docs/35 F7), or 120 s.
      while (Date.now() - t0 < 120_000) {
        await sleep(2_000);
        if (raiders.every((r) => rt.service.deps.roster.get(r)?.dead === true)) break;
      }
      const secs = Math.round((Date.now() - t0) / 1000);

      const rows: string[] = [];
      for (let i = 0; i < BUCKETS.length - 1; i++) {
        const lo = BUCKETS[i]!;
        const hi = BUCKETS[i + 1]!;
        const inB = [...arrows.values()].filter((a) => a.raider && a.dist >= lo && a.dist < hi);
        const h = inB.filter((a) => a.hit).length;
        rows.push(`${lo}–${hi - 1} blocks: ${h}/${inB.length} hits${inB.length ? ` (${Math.round((100 * h) / inB.length)} %)` : ''}`);
      }
      const holds = order.report.logs.filter((l) => /holds fire|no clear line/.test(l)).slice(-6);
      const dead = raiders.filter((r) => rt.service.deps.roster.get(r)?.dead === true).length;
      const others = [...arrows.values()].filter((a) => !a.raider).length;
      await rcon.command('bots raid clear');
      await api('/api/orders/stop', { by: CAPTAIN, target: 'all' });
      return `${arrows.size} arrows (${others} at something else), ${hits.length} hits in ${secs} s; raiders dead ${dead}/${raiders.length}; at raiders: ${rows.join('; ')}; last logs: ${holds.join(' | ')}`;
    });
  } finally {
    helpers.shoot = realShoot;
    await rcon.command('bots raid clear').catch(() => '');
    await api('/api/orders/stop', { by: CAPTAIN, target: 'all' }).catch(() => undefined);
    for (const name of ARCHERS) await api('/api/bots/despawn', { by: k.admin, admin: true, name }).catch(() => undefined);
    captain?.quit();
    await rcon.command(`forceload remove ${E.x - WEST - 16} ${E.z - 16} ${E.x + 16} ${E.z + 16}`).catch(() => '');
  }
}
