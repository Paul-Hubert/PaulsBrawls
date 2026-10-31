// A GoalFollow that aims at a point beside the entity instead of the entity itself: a guard's own slot around the
// commander (the stock `defend`). Twenty bots following the same player with GoalFollow all walk to the same block
// and stand inside each other; with an offset each one keeps its own spot and still moves with the player.
//
// It only changes where the followed point is (the constructor and hasChanged); heuristic and isEnd are
// GoalFollow's, on x/y/z, so the pathfinding workers can mirror it exactly as they mirror a GoalFollow.

import type { Entity } from 'prismarine-entity';
import pathfinderPkg from 'mineflayer-pathfinder';

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
