// Types of solve.mjs: the aim solver (docs/37 §3), the `aim` job's input and answer.

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** What to shoot at: an entity (id ≥ 0, led along its velocity, its hitbox tested) or a point (no id). */
export interface AimTarget extends XYZ {
  /** The server's entity id; absent or -1 for a point. */
  id?: number;
  /** Blocks per tick (smoothed by the caller). */
  vx?: number;
  vy?: number;
  vz?: number;
  width?: number;
  height?: number;
}

export interface AimInput {
  /** The shared world's dimension (SharedWorld.dimensionOf); null with a world of one dimension (the inline reader). */
  dim: string | null;
  /** Blocks per tick at the release: 3 (a full bow), 3.15 (a crossbow). */
  speed: number;
  /** Where the arrow leaves (the eyes − 0.1), at the release. */
  from: XYZ;
  /** The shooter's movement the launch adds (a bow: the last tick's move, y 0 on the ground; a crossbow: 0). */
  vel: XYZ;
  /** The shooter's entity id (never hit). */
  shooter: number;
  /** The shooter's team (the snapshot's team column); 0: read from the snapshot row of `shooter`. */
  team?: number;
  /** Entity ids that are friends whatever their team (the order's isFriend players). */
  friends?: number[];
  target: AimTarget;
  /** Ticks from when the target was at `target` to the release. */
  lead: number;
  /** The previous answer of this draw: the search starts there. */
  warm?: { pitch: number; arc: 'low' | 'high'; ticks: number } | null;
  /** Try the high arc over a friend in the line too, as over a wall (aim.overFriends, on by default, docs/37 D6). Absent here: a friend blocks. */
  overFriends?: boolean;
  /** 'neutral': a mob in the line blocks the shot instead of counting as a hit (default 'enemy'). */
  mobs?: 'enemy' | 'neutral';
}

export type AimHit = 'target' | 'enemy' | 'friend' | 'block' | 'entity' | 'none';

export interface AimSolution {
  /** Mineflayer's radians, for bot.look(yaw, pitch). */
  yaw: number;
  pitch: number;
  arc: 'low' | 'high';
  /** Flight ticks to what it hits first (or past the aim point). */
  ticks: number;
  /** What the checked flight meets first; 'none': nothing up to the aim point (an entity missed, out of range). */
  hit: AimHit;
  /** hit is the target, another enemy, or nothing in the way. */
  clear: boolean;
  /** Where it hits (null: nothing within the flight followed). */
  at: XYZ | null;
  /** The entity hit, else -1. */
  entity: number;
  /** The block state hit, else -1. */
  block: number;
  /** The led aim point. */
  aim: XYZ;
  /** Unknown voxels the flight crossed (counted as air). */
  unknown: number;
  /** Flights flown for this answer (closed-form ones of the pitch search, plus the checked ones). */
  flights: number;
  /** No elevation reaches the aim point: the one that carries highest, falling short. */
  outOfRange: boolean;
  /** When both arcs were flown: what the one not chosen met. */
  other?: { arc: 'low' | 'high'; hit: AimHit; at: XYZ | null };
}

/** The world as the solver reads it (P1's WorldReader, or aim/inline.ts over a bot's own world). */
export interface AimWorld {
  dimIndex(dim: string): number;
  stateIdIn(dimIndex: number, x: number, y: number, z: number): number;
  states: {
    boxStart(stateId: number): number;
    boxCount(stateId: number): number;
    readonly boxData: Float32Array;
    flags(stateId: number): number;
  };
}

/** The entity rows (jobs/entities.mjs layout): an EntityReader, or aim/inline.ts over a bot's entities. */
export interface AimEntities {
  readonly data: Float64Array | null;
  readonly count: number;
}

/** A point is reached when the arrow comes down within this many blocks of it. */
export declare const POINT_REACH: number;

export declare function solveAim(input: AimInput, world: AimWorld | null, entities: AimEntities | null): AimSolution;
