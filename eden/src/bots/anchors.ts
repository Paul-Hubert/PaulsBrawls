// AnchorService (R18) — configured coordinates are HINTS, not contracts. At boot (and at call time)
// a villager's home snaps to real standable ground and a missing chest is replaced by the nearest
// chest/trapped_chest/barrel. Discovered positions persist as overrides that WIN over config from
// then on; an unrecoverable anchor produces exactly ONE loud warning, never an error loop.
//
// Layer 1: imports types + logger + node:fs only (the dependency law). Operates over the narrowed
// Bot seam (blockAt), so it is testable on FakeBot with a hand-built world fixture.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Bot, Vec3Like } from '../types/index';
import { logger } from '../logger';

type Coord = [number, number, number];

/** The configured (hint) anchors for a villager. */
export interface AnchorInput {
  home: Coord;
  chest: Coord;
}

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
   * Heal a villager's anchors against the live world. Persisted overrides (from a prior boot) win
   * over `config`; the result is re-validated and re-persisted. One warning per unrecoverable anchor.
   */
  heal(botName: string, bot: Bot, config: AnchorInput): Anchors {
    const persisted = this.load(botName);
    const candidate: { home: Coord; chest: Coord | null } = {
      home: persisted?.home ?? config.home,
      chest: persisted?.chest ?? config.chest,
    };

    // ── home: snap to standable ground near the candidate column ──
    const ground = this.snapToGround(bot, candidate.home);
    let home: Coord;
    if (ground) {
      home = ground;
    } else {
      this.warn(`home for "${botName}" near (${candidate.home.join(', ')}) has no standable ground — keeping the hint (R18)`);
      home = candidate.home;
    }

    // ── chest: keep if it's a container, else re-discover the nearest one ──
    let chest: Coord | null;
    if (candidate.chest && this.isContainer(bot, candidate.chest)) {
      chest = candidate.chest;
    } else {
      const found = this.findNearestContainer(bot, candidate.chest ?? candidate.home);
      if (found) {
        chest = found;
      } else {
        this.warn(`no chest/trapped_chest/barrel found near (${(candidate.chest ?? candidate.home).join(', ')}) for "${botName}" — leaving it unset (R18)`);
        chest = null;
      }
    }

    const anchors: Anchors = { home, chest };
    this.save(botName, anchors);
    return anchors;
  }

  /** Find the feet position standing on the nearest solid ground in the candidate column. */
  private snapToGround(bot: Bot, home: Coord): Coord | null {
    const [x, y, z] = home;
    // Search outward from the configured y (down first — usually a too-high hint), within radius.
    for (let d = 0; d <= this.searchRadius; d++) {
      for (const fy of d === 0 ? [y] : [y - d, y + d]) {
        if (this.solid(bot, { x, y: fy - 1, z }) && !this.solid(bot, { x, y: fy, z }) && !this.solid(bot, { x, y: fy + 1, z })) {
          return [x, fy, z];
        }
      }
    }
    return null;
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
