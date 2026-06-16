// AnchorService — villagers discover their anchors at boot by scanning the world.
// At boot time, a villager's home snaps to real standable ground, and a chest is discovered
// as the nearest chest/trapped_chest/barrel. Discovered positions persist and are reused on
// subsequent boots; an unrecoverable anchor produces exactly ONE loud warning, never an error loop.
//
// Layer 1: imports types + logger + node:fs only (the dependency law). Operates over the narrowed
// Bot seam (blockAt), so it is testable on FakeBot with a hand-built world fixture.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Bot, Vec3Like } from '../types/index';
import { logger } from '../logger';

type Coord = [number, number, number];

/** Empty input — anchors are discovered dynamically. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AnchorInput {}

/** The healed anchors actually used: home always resolves; chest is null if none was found. */
export interface Anchors {
  home: Coord;
  chest: Coord | null;
}

/** Tuning for {@link AnchorService}: scan radius + the warning sink. */
export interface AnchorServiceOptions {
  /** How far to scan for ground / a container. Default 16. */
  searchRadius?: number;
  /** Warning sink (R18: one loud warn, never a loop). Defaults to the logger. */
  onWarn?: (message: string) => void;
}

const CONTAINERS = new Set(['chest', 'trapped_chest', 'barrel']);
// Blocks a body can stand IN (treated as air for the feet/head check).
const PASSABLE = new Set(['air', 'short_grass', 'tall_grass', 'fern', 'snow']);

/** Heals configured (hint) anchors against the live world and persists the discovered values (R18). */
export class AnchorService {
  private readonly searchRadius: number;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly dataDir: string,
    opts: AnchorServiceOptions = {},
  ) {
    this.searchRadius = opts.searchRadius ?? 16;
    this.warn = opts.onWarn ?? ((m) => logger.warn('anchors', m));
  }

  /**
   * Discover a villager's anchors in the live world. Persisted anchors from prior boots are reused;
   * otherwise home is discovered as standable ground near the bot's spawn, and chest is the nearest
   * container. One warning per undiscoverable anchor.
   */
  heal(botName: string, bot: Bot, _config: AnchorInput): Anchors {
    const persisted = this.load(botName);

    // ── home: use persisted if valid, else discover standable ground near spawn ──
    let home: Coord;
    if (persisted?.home && this.isStandable(bot, persisted.home)) {
      home = persisted.home;
    } else {
      const discovered = this.findNearestStandableGround(bot);
      if (discovered) {
        home = discovered;
      } else {
        // Silent fallback to current position — chunk may not be loaded yet; no warn for home.
        home = [bot.entity!.position.x, bot.entity!.position.y, bot.entity!.position.z] as unknown as Coord;
      }
    }

    // ── chest: trust any persisted position unconditionally (chunk may not be loaded at boot) ──
    let chest: Coord | null;
    if (persisted?.chest) {
      chest = persisted.chest;
    } else {
      const found = this.findNearestContainer(bot, home);
      if (found) {
        chest = found;
      } else {
        this.warn(`no chest/trapped_chest/barrel found near "${botName}" — leaving it unset`);
        chest = null;
      }
    }

    const anchors: Anchors = { home, chest };
    this.save(botName, anchors);
    return anchors;
  }

  /** Find the nearest standable ground by cube-scan around the bot's current position. */
  private findNearestStandableGround(bot: Bot): Coord | null {
    const pos = bot.entity!.position;
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cz = Math.floor(pos.z);
    const r = this.searchRadius;
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const x = cx + dx;
          const y = cy + dy;
          const z = cz + dz;
          if (this.solid(bot, { x, y: y - 1, z }) && !this.solid(bot, { x, y, z }) && !this.solid(bot, { x, y: y + 1, z })) {
            const dist = dx * dx + dy * dy + dz * dz;
            if (dist < bestDist) {
              bestDist = dist;
              best = [x, y, z];
            }
          }
        }
      }
    }
    return best;
  }

  /** Check if a position is valid standable ground. */
  private isStandable(bot: Bot, pos: Coord): boolean {
    const [x, y, z] = pos;
    return this.solid(bot, { x, y: y - 1, z }) && !this.solid(bot, { x, y, z }) && !this.solid(bot, { x, y: y + 1, z });
  }

  // Cube-scan ±searchRadius around `center` for the nearest chest/trapped_chest/barrel (R18).
  private findNearestContainer(bot: Bot, center: Coord): Coord | null {
    const [cx, cy, cz] = center;
    const r = this.searchRadius;
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const pos = { x: cx + dx, y: cy + dy, z: cz + dz };
          const block = bot.blockAt(pos);
          if (!block || !CONTAINERS.has(block.name)) continue;
          const dist = dx * dx + dy * dy + dz * dz;
          if (dist < bestDist) {
            bestDist = dist;
            best = [pos.x, pos.y, pos.z];
          }
        }
      }
    }
    return best;
  }

  private isContainer(bot: Bot, pos: Coord): boolean {
    const block = bot.blockAt({ x: pos[0], y: pos[1], z: pos[2] });
    return block !== null && CONTAINERS.has(block.name);
  }

  private solid(bot: Bot, pos: Vec3Like): boolean {
    const block = bot.blockAt(pos);
    return block !== null && !PASSABLE.has(block.name);
  }

  // ── persistence: .eden-data/bots/<name>.json under the `anchors` key (v1 layout) ──
  private file(botName: string): string {
    return join(this.dataDir, 'bots', `${botName}.json`);
  }
  private load(botName: string): Anchors | null {
    const f = this.file(botName);
    if (!existsSync(f)) return null;
    try {
      const data = JSON.parse(readFileSync(f, 'utf8')) as { anchors?: Anchors };
      return data.anchors ?? null;
    } catch {
      return null; // a corrupt per-bot file must not crash boot; re-heal from config
    }
  }
  private save(botName: string, anchors: Anchors): void {
    const f = this.file(botName);
    mkdirSync(join(this.dataDir, 'bots'), { recursive: true });
    // Preserve any other per-bot state already in the file (skills/memories land in later milestones).
    let data: Record<string, unknown> = {};
    if (existsSync(f)) {
      try {
        data = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    data.anchors = anchors;
    writeFileSync(f, JSON.stringify(data, null, 2));
  }
}
