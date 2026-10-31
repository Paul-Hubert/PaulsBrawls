// A GoalFollow that aims at a point beside the entity instead of the entity itself: a guard's own slot around the
// commander (the stock `defend`). Twenty bots following the same player with GoalFollow all walk to the same block
// and stand inside each other; with an offset each one keeps its own spot and still moves with the player.
//
// It only changes where the followed point is (the constructor and hasChanged); heuristic and isEnd are
// GoalFollow's, on x/y/z, so the pathfinding workers can mirror it exactly as they mirror a GoalFollow.

import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

const { goals } = pathfinderPkg;

/** A horizontal offset from the followed entity, in blocks. */
export interface FollowOffset {
  x: number;
  z: number;
}

export class GoalFollowOffset extends goals.GoalFollow {
  readonly offset: FollowOffset;

  constructor(entity: Entity, range: number, offset: FollowOffset) {
    super(entity, range);
    this.offset = { x: Number(offset.x) || 0, z: Number(offset.z) || 0 };
    this.x = Math.floor(entity.position.x + this.offset.x);
    this.z = Math.floor(entity.position.z + this.offset.z);
  }

  override hasChanged(): boolean {
    const p = this.entity.position;
    const x = Math.floor(p.x + this.offset.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z + this.offset.z);
    const dx = this.x - x;
    const dy = this.y - y;
    const dz = this.z - z;
    if (dx * dx + dy * dy + dz * dz > this.rangeSq) {
      this.x = x;
      this.y = y;
      this.z = z;
      return true;
    }
    return false;
  }
}

/** The one thing `slotStandable` reads from a bot. */
export interface BlockReader {
  blockAt(pos: Vec3, extraInfos?: boolean): { name: string; boundingBox: string } | null;
}

/** Blocks a body can be inside of while climbing: the pathfinder's `climbables` (ladders) and vines. */
const CLIMBABLE = new Set(['ladder', 'vine']);

/**
 * Whether anyone could stand at the slot `offset` from the entity: at the entity's height, or one block above or
 * below (a slope). A slot is the entity's position plus a fixed offset, so while the commander climbs a ladder, or
 * stands at the edge of a tower, it is in mid-air: no path ends there, every search for it runs to its time limit,
 * and the bot walked to wherever the search happened to stop (found live, docs/29 §16). A block the bot does not
 * know (an unloaded chunk) does not count against the slot.
 */
export function slotStandable(bot: BlockReader, entity: { position: { x: number; y: number; z: number } }, offset: FollowOffset): boolean {
  const x = Math.floor(entity.position.x + offset.x);
  const y = Math.floor(entity.position.y);
  const z = Math.floor(entity.position.z + offset.z);
  const at = (dy: number) => bot.blockAt(new Vec3(x, y + dy, z), false);
  const blocks = [-2, -1, 0, 1, 2].map(at);
  if (blocks.some((b) => b === null)) return true;
  const open = (b: { name: string; boundingBox: string }) => b.boundingBox === 'empty' || CLIMBABLE.has(b.name);
  // Feet at y + d: the feet and head blocks open, and either a solid block under the feet or a ladder to hold on to.
  return [-1, 0, 1].some((d) => {
    const below = blocks[d + 1]!;
    const feet = blocks[d + 2]!;
    const head = blocks[d + 3]!;
    return open(feet) && open(head) && (below.boundingBox === 'block' || CLIMBABLE.has(feet.name));
  });
}
