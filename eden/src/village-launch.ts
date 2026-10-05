// VillageLauncher — the in-game `/villagers start|stop|restart` control (POST /scenario/* → here).
//
// Option-C launch model: the scenario is loaded at BOOT (main.ts applies it before wireGod), so God +
// reactivity are already bound to the roster and there is exactly ONE pool — the boot pool. This launcher
// does NOT create a pool and does NOT load scenario files; it START/STOPs the already-wired boot pool and
// fires each villager's positioning + loadout commands once per (re)start. Deferring the spawn to this
// trigger is what keeps the avatar from auto-logging-in at boot and colliding with itself (R12/R53).
//
// Lives at the src/ root: a pure CONSUMER (dependency law — nothing in the layer graph imports it except
// main.ts, the composition root). No journaling here — the admin route journals scenario.start BEFORE
// calling these methods (05/S2).
//
// Dependency: config types (layer 1), journal (layer 1), logger, stdlib. Never imports a layer-3 actor.

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import type { VillagerConfig } from './config';
import type { JournalAppender } from './journal/journal';
import { logger } from './logger';

// ── Public surface ─────────────────────────────────────────────────────────────

/** Duck-typed subset of BotPool the launcher drives — keeps this module pool-agnostic + test-injectable. */
export interface PoolLike {
  start(): Promise<void>;
  stop(): void;
}

/** Duck-typed bot — only `chat` is needed to issue the setup commands (tests pass a recorder). */
export interface ChatBot {
  chat(message: string): void;
}

export interface VillageResult {
  ok: boolean;
  message: string;
  /** Villager bot names in the booted roster (populated on start/restart). */
  botNames?: string[];
}

export interface VillageLauncherDeps {
  /** The boot pool (villagers + avatar), created-but-not-started by main.ts. Undefined on a bare boot. */
  pool: PoolLike | undefined;
  /** The booted roster (config.villagers, already scenario-merged) — carries each villager's items. */
  villagers: ReadonlyArray<VillagerConfig>;
  /** The avatar username (config.god.name) — gets NO setup commands. */
  avatarName: string;
  /** The booted scenario name (config.scenario), or undefined for a direct villagers config. */
  scenarioName: string | undefined;
  dataDir: string;
  journal: JournalAppender;
  /** Bug #16 — forget a villager's live state on restart (main.ts: memory reset + self-authored subscriptions).
   *  Deleting `bots/<name>.json` alone was undone by the live memory re-writing it. */
  resetVillager?: (name: string) => void;
  /**
   * Delay (ms) before firing setup commands after a bot spawns. Default 1500 ms — gives the Java
   * op-on-join handler time to op the bot before it runs /spreadplayers and /give. Tests set 0.
   */
  spawnDelayMs?: number;
}

// ── Implementation ───────────────────────────────────────────────────────────────

export class VillageLauncher {
  private running = false;
  /** Active spawn-setup for the current (re)start — armed by start/restart, read by onSpawn. */
  private setup?: { cx: number; cz: number; clear: boolean };
  /** Villagers already set up this (re)start — so a reconnect re-attaches reactivity but never re-gives items. */
  private readonly didSetup = new Set<string>();

  constructor(private readonly deps: VillageLauncherDeps) {}

  /**
   * Connect the booted roster around (cx, cz). The pool is the SAME one God is wired to — no second pool,
   * no duplicate avatar. Idempotent: a second start while running is a no-op (reports already-running).
   */
  async start(name: string, cx: number, cz: number): Promise<VillageResult> {
    const guard = this.guard(name);
    if (guard) return guard;
    if (this.running) return { ok: true, message: 'village already running', botNames: this.botNames() };
    this.arm(cx, cz, false);
    this.running = true;
    void this.deps.pool!.start();
    return { ok: true, message: `village started (${this.deps.villagers.length} villager(s))`, botNames: this.botNames() };
  }

  /** Disconnect the roster. Bot state (memory, anchors, subscriptions) is preserved on disk. */
  async stop(): Promise<VillageResult> {
    if (!this.deps.pool || !this.running) return { ok: true, message: 'no village running' };
    this.deps.pool.stop();
    this.running = false;
    this.setup = undefined;
    this.didSetup.clear();
    return { ok: true, message: 'village stopped' };
  }

  /** Stop, wipe each villager's persisted state file (`bots/<name>.json`), then reconnect with /clear + /give. */
  async restart(name: string, cx: number, cz: number): Promise<VillageResult> {
    const guard = this.guard(name);
    if (guard) return guard;
    if (this.running) this.deps.pool!.stop();
    for (const v of this.deps.villagers) {
      rmSync(join(this.deps.dataDir, 'bots', `${v.name}.json`), { force: true });
      this.deps.resetVillager?.(v.name);
    }
    this.arm(cx, cz, true);
    this.running = true;
    void this.deps.pool!.start();
    return { ok: true, message: `village restarted (${this.deps.villagers.length} villager(s))`, botNames: this.botNames() };
  }

  /**
   * Called from the pool's onBotSpawn (alongside reactivity attach). Fires positioning + loadout once per
   * villager per (re)start: /spreadplayers, optional /clear (restart), then /give per item stack. The avatar
   * and unknown names are skipped; a reconnect (didSetup already has the name) re-attaches reactivity upstream
   * but does NOT re-issue these commands (no item duplication).
   */
  onSpawn(name: string, bot: ChatBot): void {
    const setup = this.setup;
    if (!setup) return;
    if (name === this.deps.avatarName) return; // the avatar gets no positioning/loadout
    const villager = this.deps.villagers.find((v) => v.name === name);
    if (!villager) return;
    if (this.didSetup.has(name)) return; // once per (re)start, not per reconnect
    this.didSetup.add(name);
    const items = villager.items ?? [];
    setTimeout(() => {
      try {
        bot.chat(`/spreadplayers ${setup.cx} ${setup.cz} 2 10 false ${name}`);
        if (setup.clear) bot.chat(`/clear ${name}`);
        for (const item of items) bot.chat(`/give ${name} ${item.id} ${item.count}`);
      } catch (e) {
        logger.warn(`village:${name}`, `setup commands failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, this.deps.spawnDelayMs ?? 1500);
  }

  /** True once a start/restart has connected the roster (until stop). */
  isRunning(): boolean {
    return this.running;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /** Why `start`/`restart` of `name` would be refused, or undefined if it would proceed. The admin asks this
   *  BEFORE journaling, so a refused request leaves no `scenario.start` row (bug #17). */
  refusal(name: string): string | undefined {
    return this.guard(name)?.message;
  }

  /** Reject when there's no village to launch or the requested name doesn't match the booted scenario. */
  private guard(name: string): VillageResult | undefined {
    if (!this.deps.pool) {
      return { ok: false, message: 'no village configured — set "scenario" (or villagers) in eden.json and reboot' };
    }
    if (this.deps.scenarioName && name !== this.deps.scenarioName) {
      return {
        ok: false,
        message: `booted scenario is "${this.deps.scenarioName}", not "${name}" — runtime scenario switching needs a reboot`,
      };
    }
    return undefined;
  }

  private arm(cx: number, cz: number, clear: boolean): void {
    this.setup = { cx, cz, clear };
    this.didSetup.clear();
  }

  private botNames(): string[] {
    return this.deps.villagers.map((v) => v.name);
  }
}
