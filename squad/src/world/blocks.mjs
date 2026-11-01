// prismarine Blocks over the shared world (docs/37 §2.3), for the code that wants a Block and not a state id:
// mineflayer-pathfinder's Movements and goals in a reader worker (P4), the bots' own blockAt in P5.
//
// bot.blockAt builds a whole Block per call (Block.fromStateId: a Biome, the state's properties, the hash), the
// hottest function of docs/36. Here every state id gets ONE template, built by fromStateId on first use and kept, and
// a lookup specialises it by position: Object.create(template) and an own `position`. Whatever the caller then writes
// on the block (Movements' safe, physical, height…; a raycast's face) lands on that small object, never on the
// template. Measured on one thread: 35–56 ns a lookup over 20–200 distinct states, against 140–240 ns for
// fromStateId; a search touches a few dozen to a few hundred states.
//
// What the store does not hold is not there: the biome is the template's (id 0), the light 0, no block entity (a
// sign's text, a chest's contents). Nothing the pathfinder reads needs them.
//
// Plain JS so a worker imports it with no loader; types in blocks.d.mts.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const { RaycastIterator } = require('prismarine-world').iterators;

export class BlockTemplates {
  /** @param registry a prismarine-registry of the bots' version */
  constructor(registry) {
    this.registry = registry;
    this.Block = require('prismarine-block')(registry);
    this.templates = [];
    this.built = 0;
  }

  /** The state's template: shared, never write into it. */
  template(stateId) {
    let t = this.templates[stateId];
    if (t === undefined) {
      t = this.Block.fromStateId(stateId, 0);
      this.templates[stateId] = t;
      this.built++;
    }
    return t;
  }

  /** A Block of this state at `position` (a Vec3, kept as the block's own: pass a fresh one). */
  at(stateId, position) {
    const b = Object.create(this.template(stateId));
    b.position = position;
    return b;
  }
}

/**
 * One dimension of the store, with prismarine-world's sync read API (getBlock, getBlockStateId, raycast), for goals
 * and Movements. Reads must happen inside the reader's enter()/leave() bracket (a job's batch is one). A block of a
 * column the store does not hold live is null, as in a world that never loaded it.
 */
export class StoreWorld {
  constructor(reader, templates, dim) {
    this.reader = reader;
    this.templates = templates;
    this.dim = dim;
    this.d = reader.dimIndex(dim);
  }

  /** The state id at a position, or -1 (no live column). */
  stateIdAt(x, y, z) {
    if (this.d < 0) {
      this.d = this.reader.dimIndex(this.dim);
      if (this.d < 0) return -1;
    }
    return this.reader.stateIdIn(this.d, x, y, z);
  }

  getBlockStateId(pos) {
    const s = this.stateIdAt(pos.x, pos.y, pos.z);
    return s < 0 ? undefined : s;
  }

  getBlock(pos) {
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const z = Math.floor(pos.z);
    const s = this.stateIdAt(x, y, z);
    return s < 0 ? null : this.templates.at(s, new Vec3(x, y, z));
  }

  /**
   * getBlock for a caller that hands over a fresh Vec3 it will not use again (Movements.getBlock builds one per
   * lookup): at integer coordinates it becomes the block's position, so a lookup allocates one Vec3, not two.
   */
  blockAtOwned(pos) {
    const x = pos.x;
    const y = pos.y;
    const z = pos.z;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return this.getBlock(pos);
    const s = this.stateIdAt(x, y, z);
    return s < 0 ? null : this.templates.at(s, pos);
  }

  /** prismarine-world's raycast (worldsync.js), line for line, over this store: the same blocks, faces and points. */
  raycast(from, direction, range, matcher = null) {
    const iter = new RaycastIterator(from, direction, range);
    let pos = from;
    while (pos) {
      const position = new Vec3(pos.x, pos.y, pos.z);
      const block = this.getBlock(position);
      if (block) {
        if (matcher) {
          if (matcher(block, iter)) return block;
        } else {
          const intersect = iter.intersect(block.shapes, position);
          if (intersect) {
            block.face = intersect.face;
            block.intersect = intersect.pos;
            return block;
          }
        }
      }
      pos = iter.next();
    }
    return null;
  }
}
