// The arrow as Minecraft 1.21.1 flies it (docs/37 §3), read from the 1.21.1 server itself (javap of Loom's
// yarn-mapped jar, minecraft-common-1.21.1+build.3), not from memory or a plugin:
//   • The start: the shooter's eyes minus 0.1 (PersistentProjectileEntity's constructor: owner.getEyeY() - 0.1F).
//   • A bow: BowItem.shoot → ProjectileEntity.setVelocity(shooter, pitch, yaw, 0, pull × 3.0F, 1.0F): the unit view
//     vector times 3 at full draw, then PLUS the shooter's movement, `shooter.getMovement()`, with its y dropped when
//     the shooter is on the ground. For a player that is ServerPlayerEntity.movement: the position delta of its last
//     move packet (ServerPlayNetworkHandler.onPlayerMove), so 0 for a bot that stands and only turns.
//     26.1.2 (javap of its unobfuscated jar, docs/47 §1): the same add (Projectile.shootFromRotation +
//     Entity.getKnownMovement); a rider that steers its horse gives its lastKnownClientMovement, which
//     handleMoveVehicle sets to the horse's move (the delta of its vehicle_move packet). Mineflayer sends no
//     client_tick_end, so it is never reset to 0 between packets. The rider itself is seated on the horse only in the
//     server's tick (rideTick → positionRider): the arrow starts where the last tick seated it (draw.ts).
//   • A crossbow: CrossbowItem.shoot → setVelocity(x, y, z, 3.15F, 1.0F) along the view vector: no shooter movement.
//   • Both add a random spread (triangle(0, 0.0172275) per component before the speed, about ±0.5°) that nothing
//     can aim for.
//   • Each tick (PersistentProjectileEntity.tick): the segment p → p + v is checked, blocks first (World.raycast
//     against collision shapes), then entities up to the block hit (ProjectileUtil.getEntityCollision: every hitbox
//     grown by 0.3F, the nearest wins); then p += v; v × 0.99F (0.6F when touching water, getDragInWater);
//     v.y − 0.05 (getGravity).
//
// Plain JS (no loader): the reader workers and the main thread import the same file. arrow.d.mts types it.

/** v × DRAG every tick in air: (double) 0.99F. */
export const DRAG = Math.fround(0.99);
/** In water: (double) 0.6F. */
export const WATER_DRAG = Math.fround(0.6);
export const GRAVITY = 0.05;
/** A full-draw bow (pull 1 × 3.0F). */
export const BOW_SPEED = 3;
/** CrossbowItem.getSpeed for arrows, 3.15F. */
export const CROSSBOW_SPEED = Math.fround(3.15);
/** ProjectileUtil.getEntityCollision grows every hitbox by 0.3F (the arrow is 0.5 wide). */
export const ENTITY_MARGIN = Math.fround(0.3);
/** The arrow leaves at the eyes minus this. */
export const EYE_DROP = 0.1;
/** A flight longer than this (15 s) is not followed. */
export const MAX_TICKS = 300;

const LN_DRAG = Math.log(DRAG);
/** The vertical speed the arrow settles at in air: v.y = v.y × DRAG − GRAVITY. */
const VY_INF = -GRAVITY / (1 - DRAG);

/**
 * Where an arrow flying in air is when it has gone `d` blocks horizontally, from (0, 0) at horizontal speed `vh` and
 * vertical speed `vy` (blocks per tick): `{ y, ticks }`, ticks fractional along the tick's straight segment, exactly
 * as the game moves it (positions after whole ticks in closed form, then linear within the tick). Null when it never
 * gets that far (or not within MAX_TICKS).
 */
export function heightAt(vh, vy, d) {
  if (!(d > 0)) return { y: 0, ticks: 0 };
  if (!(vh > 0)) return null;
  const q = 1 - (d * (1 - DRAG)) / vh;
  if (!(q > 0)) return null;
  let k = Math.max(0, Math.floor(Math.log(q) / LN_DRAG));
  if (k >= MAX_TICKS) return null;
  let rk = DRAG ** k;
  let hk = (vh * (1 - rk)) / (1 - DRAG);
  // Float dust around a whole tick: settle k so that h(k) ≤ d < h(k + 1).
  while (k > 0 && hk > d) {
    k--;
    rk = DRAG ** k;
    hk = (vh * (1 - rk)) / (1 - DRAG);
  }
  while (hk + vh * rk <= d) {
    hk += vh * rk;
    rk *= DRAG;
    k++;
    if (k >= MAX_TICKS) return null;
  }
  const f = (d - hk) / (vh * rk);
  const a = vy - VY_INF;
  const yk = (a * (1 - rk)) / (1 - DRAG) + k * VY_INF;
  const vyk = a * rk + VY_INF;
  return { y: yk + f * vyk, ticks: k + f };
}

/**
 * The launch at elevation `e` (radians, + up) whose horizontal motion, once the shooter's own movement (ux, uz) is
 * added, runs along the unit direction (dx, dz): the aim direction (wx, wz) (unit, horizontal), the speed along
 * (dx, dz) and the vertical speed. Null when the shooter drifts sideways faster than the arrow can make up.
 */
export function launch(e, speed, ux, uy, uz, dx, dz) {
  const sc = speed * Math.cos(e);
  if (!(sc > 1e-9)) return null;
  const along = ux * dx + uz * dz;
  const ax = ux - along * dx;
  const az = uz - along * dz;
  const a2 = ax * ax + az * az;
  if (a2 >= sc * sc) return null;
  const k = Math.sqrt(sc * sc - a2);
  return { wx: (k * dx - ax) / sc, wz: (k * dz - az) / sc, vh: k + along, vy: speed * Math.sin(e) + uy };
}

/**
 * Fly in air, tick by tick, as the game does: the position after each tick, `ticks` of them. For tests and for
 * checking the closed form; the solver's checked flight steps the same way with the world.
 */
export function stepFlight(p, v, ticks) {
  const out = [];
  let x = p.x;
  let y = p.y;
  let z = p.z;
  let vx = v.x;
  let vy = v.y;
  let vz = v.z;
  for (let t = 0; t < ticks; t++) {
    x += vx;
    y += vy;
    z += vz;
    vx *= DRAG;
    vy = vy * DRAG - GRAVITY;
    vz *= DRAG;
    out.push({ x, y, z });
  }
  return out;
}
