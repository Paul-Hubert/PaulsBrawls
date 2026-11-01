// Types of arrow.mjs: Minecraft 1.21.1's arrow (launch, drag, gravity), shared by the aim solver in any thread.

export declare const DRAG: number;
export declare const WATER_DRAG: number;
export declare const GRAVITY: number;
export declare const BOW_SPEED: number;
export declare const CROSSBOW_SPEED: number;
export declare const ENTITY_MARGIN: number;
export declare const EYE_DROP: number;
export declare const MAX_TICKS: number;

/** Where the arrow is after `d` blocks horizontally (closed form, the game's per-tick segments); null: never. */
export declare function heightAt(vh: number, vy: number, d: number): { y: number; ticks: number } | null;

/** The launch at elevation `e` whose horizontal motion (with the shooter's movement added) runs along (dx, dz). */
export declare function launch(
  e: number,
  speed: number,
  ux: number,
  uy: number,
  uz: number,
  dx: number,
  dz: number,
): { wx: number; wz: number; vh: number; vy: number } | null;

/** Tick-by-tick flight in air: the position after each tick. */
export declare function stepFlight(
  p: { x: number; y: number; z: number },
  v: { x: number; y: number; z: number },
  ticks: number,
): Array<{ x: number; y: number; z: number }>;
