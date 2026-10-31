// What crosses the thread boundary of the pathfinding workers (docs/32 D): goals, Movements settings and paths. Only
// data crosses (structured clone), never functions, so anything that carries code (a goal class we do not know, an
// exclusion area, a subclassed Movements) is refused here and the search stays on the main thread.

import { createRequire } from 'node:module';

import { GoalFollowOffset } from '../follow-goal';

const require = createRequire(import.meta.url);

interface Vec {
  x: number;
  y: number;
  z: number;
}
type VecCtor = new (x: number, y: number, z: number) => Vec;

const { Vec3 } = require('vec3') as { Vec3: VecCtor };
const Move = require('mineflayer-pathfinder/lib/move') as new (
  x: number,
  y: number,
  z: number,
  remainingBlocks: number,
  cost: number,
  toBreak?: Vec[],
  toPlace?: unknown[],
  parkour?: boolean,
) => Vec;
const Movements = require('mineflayer-pathfinder/lib/movements') as { prototype: object };
const goals = require('mineflayer-pathfinder/lib/goals') as Record<string, new (...a: never[]) => object>;

/** A goal as the worker rebuilds it (worker.mjs, buildGoal). */
export type WireGoal =
  | { t: 'GoalBlock' | 'GoalNear' | 'GoalXZ' | 'GoalNearXZ' | 'GoalY' | 'GoalGetToBlock'; f: Record<string, number> }
  | { t: 'GoalCompositeAny' | 'GoalCompositeAll'; goals: WireGoal[] }
  | { t: 'GoalInvert'; goal: WireGoal }
  | { t: 'GoalLookAtBlock'; pos: Vec; reach: number; entityHeight: number }
  | { t: 'GoalPlaceBlock'; pos: Vec; options: Record<string, unknown>; facesPos: Array<[Vec, Vec, Vec]> };

const SIMPLE = ['GoalBlock', 'GoalNear', 'GoalXZ', 'GoalNearXZ', 'GoalY', 'GoalGetToBlock'] as const;

function plainVec(v: unknown): Vec | null {
  const p = v as Partial<Vec> | null;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return null;
  return { x: p.x, y: p.y, z: p.z };
}

/** The own numeric fields of a simple goal; null if it carries anything else (a subclass's extra state). */
function numericFields(goal: object): Record<string, number> | null {
  const f: Record<string, number> = {};
  for (const [k, v] of Object.entries(goal)) {
    if (typeof v !== 'number') return null;
    f[k] = v;
  }
  return f;
}

/**
 * A goal the worker can rebuild, or null (the search stays on the main thread). Classes are matched exactly, not by
 * instanceof: a subclass may override heuristic or isEnd. `world` is the bot's own world: a goal that raycasts a
 * different world cannot be mirrored.
 */
export function serializeGoal(goal: unknown, world: unknown): WireGoal | null {
  if (!goal || typeof goal !== 'object') return null;
  const ctor = (goal as { constructor?: unknown }).constructor;
  const g = goal as Record<string, unknown>;
  for (const name of SIMPLE) {
    if (ctor === goals[name]) {
      const f = numericFields(goal);
      return f ? { t: name, f } : null;
    }
  }
  if (ctor === goals.GoalFollow || ctor === GoalFollowOffset) {
    // A snapshot of where the entity is now (or of the slot beside it). The main thread keeps the real goal: its
    // hasChanged() re-plans when the entity moves, as it does today.
    const f = { x: g.x, y: g.y, z: g.z, rangeSq: g.rangeSq };
    if (!Object.values(f).every((v) => typeof v === 'number')) return null;
    return { t: 'GoalNear', f: f as Record<string, number> };
  }
  if (ctor === goals.GoalCompositeAny || ctor === goals.GoalCompositeAll) {
    if (!Array.isArray(g.goals)) return null;
    const parts: WireGoal[] = [];
    for (const c of g.goals) {
      const s = serializeGoal(c, world);
      if (!s) return null;
      parts.push(s);
    }
    return { t: ctor === goals.GoalCompositeAny ? 'GoalCompositeAny' : 'GoalCompositeAll', goals: parts };
  }
  if (ctor === goals.GoalInvert) {
    const inner = serializeGoal(g.goal, world);
    return inner ? { t: 'GoalInvert', goal: inner } : null;
  }
  if (ctor === goals.GoalLookAtBlock) {
    const pos = plainVec(g.pos);
    if (!pos || g.world !== world || typeof g.reach !== 'number' || typeof g.entityHeight !== 'number') return null;
    return { t: 'GoalLookAtBlock', pos, reach: g.reach, entityHeight: g.entityHeight };
  }
  if (ctor === goals.GoalPlaceBlock) {
    const pos = plainVec(g.pos);
    const o = g.options as Record<string, unknown> | undefined;
    if (!pos || g.world !== world || !o || !Array.isArray(o.faces) || !Array.isArray(g.facesPos)) return null;
    const faces = o.faces.map(plainVec);
    if (faces.some((f) => f === null)) return null;
    const facesPos: Array<[Vec, Vec, Vec]> = [];
    for (const entry of g.facesPos as unknown[][]) {
      const t = entry.map(plainVec);
      if (t.length !== 3 || t.some((v) => v === null)) return null;
      facesPos.push(t as [Vec, Vec, Vec]);
    }
    const options = { range: o.range, LOS: o.LOS, facing: o.facing, facing3D: o.facing3D, half: o.half, faces };
    return { t: 'GoalPlaceBlock', pos, options, facesPos };
  }
  return null;
}

/** Fields of a Movements that are not settings: the bot, its caches, the collision index (sent on its own). */
const NOT_SETTINGS = new Set(['bot', 'blocks', 'blocksClock', 'entityIntersections']);
const EXCLUSIONS = ['exclusionAreasStep', 'exclusionAreasBreak', 'exclusionAreasPlace'];

function isPlain(v: unknown): boolean {
  return v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string';
}

/**
 * The settings of a Movements, as data the worker copies onto its own (canDig, allowParkour, the sets of blocks to
 * avoid or not break, scaffolding, maxDropDown…), or null when they cannot cross: a subclass (its methods would not
 * run in the worker), exclusion areas (functions), or any other field holding code or objects.
 */
export function movementSettings(movements: unknown): Record<string, unknown> | null {
  if (!movements || typeof movements !== 'object' || Object.getPrototypeOf(movements) !== Movements.prototype) return null;
  const m = movements as Record<string, unknown>;
  for (const k of EXCLUSIONS) if (!Array.isArray(m[k]) || (m[k] as unknown[]).length > 0) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (NOT_SETTINGS.has(k) || EXCLUSIONS.includes(k)) continue;
    if (isPlain(v)) out[k] = v;
    else if (v instanceof Set) {
      for (const e of v) if (!isPlain(e)) return null;
      out[k] = v;
    } else if (Array.isArray(v)) {
      if (!v.every(isPlain)) return null;
      out[k] = v;
    } else return null;
  }
  return out;
}

/** A path node as it comes back from the worker: a structured clone of a Move (its prototype is lost). */
export interface WireNode {
  x: number;
  y: number;
  z: number;
  remainingBlocks: number;
  cost: number;
  parkour: boolean;
  toBreak: Vec[];
  toPlace: Array<Record<string, unknown>>;
}

/**
 * The worker's path as the Move objects the plugin's executor expects (Vec3 methods, toBreak as Vec3, a toPlace's
 * returnPos as Vec3). Fresh objects on every call: the plugin edits its path in place (postProcessPath, splice).
 */
export function rebuildPath(nodes: readonly WireNode[]): Vec[] {
  return nodes.map(
    (n) =>
      new Move(
        n.x,
        n.y,
        n.z,
        n.remainingBlocks,
        n.cost,
        n.toBreak.map((b) => new Vec3(b.x, b.y, b.z)),
        n.toPlace.map((p) => {
          const r = p.returnPos as Vec | undefined;
          return r ? { ...p, returnPos: new Vec3(r.x, r.y, r.z) } : { ...p };
        }),
        n.parkour,
      ),
  );
}

/** The inventory as Movements reads it in a search: what a tool is and its enchantments (bestHarvestTool). */
export function itemSnapshot(items: ReadonlyArray<{ type: number; count: number; nbt?: unknown }>): Array<{ type: number; count: number; nbt: unknown }> {
  return items.map((i) => ({ type: i.type, count: i.count, nbt: i.nbt ?? null }));
}
