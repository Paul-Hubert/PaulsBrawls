// The General's geometry (docs/38): compass directions, positions relative to the spawn point, the axis of attack.
// Minecraft's yaw: 0 looks south (+Z), 90 west (-X), 180 north (-Z), 270 east (+X). The General speaks in compass
// terms: E = +X, N = -Z, so "E12 N3" is 12 blocks east and 3 north of the spawn point.

import type { Vec3Like } from '../types';

export const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;

const norm360 = (a: number): number => ((a % 360) + 360) % 360;

/** The compass bearing (0 = north, 90 = east) of a Minecraft yaw. */
export const bearingOf = (yaw: number): number => norm360(yaw - 180);
/** The Minecraft yaw of a compass bearing. */
export const yawOf = (bearing: number): number => norm360(bearing + 180);

/** A yaw rounded to one of the 16 compass directions (the ticket's axis). */
export function roundYaw16(yaw: number): number {
  return yawOf(Math.round(bearingOf(yaw) / 22.5) * 22.5);
}

/** The nearest of the 16 compass names. */
export function dirName(yaw: number): string {
  return COMPASS16[Math.round(bearingOf(yaw) / 22.5) % 16] as string;
}

/** The horizontal unit vector a yaw looks along. */
export function dirOf(yaw: number): { x: number; z: number } {
  const r = (yaw * Math.PI) / 180;
  return { x: -Math.sin(r), z: Math.cos(r) };
}

/** The yaw looking from `a` to `b`. */
export function yawToward(a: Vec3Like, b: Vec3Like): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return norm360((Math.atan2(-dx, dz) * 180) / Math.PI);
}

/** A direction: a compass name ("E", "nne") or degrees of yaw ("yaw=90"), or a bearing in degrees ("90" = east). */
export function parseDirection(text: string): number {
  const t = text.trim().toUpperCase();
  const i = (COMPASS16 as readonly string[]).indexOf(t);
  if (i >= 0) return yawOf(i * 22.5);
  const yaw = /^YAW\s*=?\s*(-?\d+(?:\.\d+)?)$/.exec(t);
  if (yaw) return norm360(Number(yaw[1]));
  const deg = /^(-?\d+(?:\.\d+)?)$/.exec(t);
  if (deg) return yawOf(Number(deg[1]));
  throw new Error(`unknown direction "${text}" (a compass point like E or NNW, a bearing in degrees like 90, or yaw=90)`);
}

/** `pos` relative to `origin`, as the General reads it: "E12 N3" (whole blocks; "0" for the origin itself). */
export function rel(origin: Vec3Like, pos: Vec3Like): string {
  const dx = Math.round(pos.x - origin.x);
  const dz = Math.round(pos.z - origin.z);
  const parts: string[] = [];
  if (dx) parts.push(`${dx > 0 ? 'E' : 'W'}${Math.abs(dx)}`);
  if (dz) parts.push(`${dz < 0 ? 'N' : 'S'}${Math.abs(dz)}`);
  return parts.length ? parts.join(' ') : '0';
}

/** Distance along the axis from `origin` (negative: behind the spawn point). */
export function along(origin: Vec3Like, yaw: number, pos: Vec3Like): number {
  const d = dirOf(yaw);
  return (pos.x - origin.x) * d.x + (pos.z - origin.z) * d.z;
}

/** Distance to the right of the axis, as someone facing along it sees it. */
export function lateral(origin: Vec3Like, yaw: number, pos: Vec3Like): number {
  const r = dirOf(yaw + 90);
  return (pos.x - origin.x) * r.x + (pos.z - origin.z) * r.z;
}

/** The point `forward` blocks along the axis and `right` to its right, from `origin`. */
export function onAxis(origin: Vec3Like, yaw: number, forward: number, right = 0): Vec3Like {
  const d = dirOf(yaw);
  const r = dirOf(yaw + 90);
  return { x: origin.x + d.x * forward + r.x * right, y: origin.y, z: origin.z + d.z * forward + r.z * right };
}

export interface PositionContext {
  spawn: Vec3Like;
  axis: number;
  /** How far along the axis the army's foremost bot stands. */
  front: number;
}

/**
 * A position as the General writes it:
 * - relative to the spawn point: "E12 N3", "N3 E12", "W4", "spawn";
 * - along the axis past the army's front: "axis+48" ("axis-10": behind it);
 * - absolute: "120 64 -340" or "120 -340".
 * The y of a relative position is the spawn point's (the orders find the ground themselves).
 */
export function parsePosition(text: string, c: PositionContext): Vec3Like {
  const t = text.trim();
  if (/^spawn$/i.test(t)) return { ...c.spawn };
  const ax = /^axis\s*([+-]\s*\d+(?:\.\d+)?)$/i.exec(t);
  if (ax) return onAxis(c.spawn, c.axis, Math.max(0, c.front) + Number(ax[1]!.replace(/\s+/g, '')));
  const abs = /^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)(?:[\s,]+(-?\d+(?:\.\d+)?))?$/.exec(t);
  if (abs) {
    return abs[3] !== undefined
      ? { x: Number(abs[1]), y: Number(abs[2]), z: Number(abs[3]) }
      : { x: Number(abs[1]), y: c.spawn.y, z: Number(abs[2]) };
  }
  const parts = t.toUpperCase().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) throw new Error(positionError(text));
  let dx = 0;
  let dz = 0;
  const seen = new Set<string>();
  for (const p of parts) {
    const m = /^([NESW])(\d+(?:\.\d+)?)$/.exec(p);
    if (!m) throw new Error(positionError(text));
    const axis = m[1] === 'E' || m[1] === 'W' ? 'x' : 'z';
    if (seen.has(axis)) throw new Error(positionError(text));
    seen.add(axis);
    const n = Number(m[2]);
    if (m[1] === 'E') dx = n;
    else if (m[1] === 'W') dx = -n;
    else if (m[1] === 'S') dz = n;
    else dz = -n;
  }
  return { x: c.spawn.x + dx, y: c.spawn.y, z: c.spawn.z + dz };
}

function positionError(text: string): string {
  return `unknown position "${text}" (relative to the spawn point like "E12 N3", along the axis like "axis+48", "spawn", or absolute "x y z")`;
}

export const horizontal = (a: Vec3Like, b: Vec3Like): number => Math.hypot(a.x - b.x, a.z - b.z);
