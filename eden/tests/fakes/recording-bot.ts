// RecordingBot — the SLIM half of the FakeBot split (docs/26 B2 / Q1). It carries everything the
// logic tier needs so FakeBot's world-model half can die in B7 without any assert lapsing:
//   (a) the recorder arrays — `calls[]` / `sentChat[]` / `clicks[]` / `crafted[]` / `loadedPlugins[]`;
//   (b) the fault-injection seams — `setDigMode('never')` (stall, D-10), `startPathUpdates` (D-10),
//       `setActivateDelayMs` (the R55 DELAY SEAM — the knob survives; the farm flip model does not),
//       `setUnknownItems` (D1), `dropLoadBearingPlugin` (R16/FIX-4), the packet seams
//       `packetSetSlot`/`packetWindowItems` (R2);
//   (c) event sourcing — native `emit()`, the `entities` map, `setVitals`/`setTime` — the
//       signals/events/reactivity tests live on these;
//   (d) LIVE-MUTABLE state stubs (P-8 — not uniformly inert): the inventory array (`give`/`countItem`/
//       `inventory.items()` are REAL state — the gate/loop convergence tests depend on give → snapshot
//       → check-veto in BOTH directions) and the seeded block map (`setBlock`/`blockAt` — the
//       skills-engine stall test digs a SEEDED block);
//   (e) INERT stubs — `findBlocks`/`findBlock` return empty/null (NEVER simulate the R76 palette),
//       `openContainer` refuses with a named error, `activateBlock` records and resolves without
//       flipping any block, no `plantTree`. World-behavior semantics belong to the skill tier on a
//       real server (docs/26 B4/B5), not to a fake.
//
// PINNED (P-31): the kept reactivity tests (villagers-host-reactivity etc.) assert ROUTING — that a
// `skill.run` was journaled — which survives these inert stubs only because the reflex skills no-op
// cleanly on an empty world (`findBlock` → null must not throw; `pathfinder.goto` must resolve). They
// must never be tightened to world-delta asserts without moving tiers.

import { EventEmitter } from 'node:events';

import type { Bot } from '../../src/types/bot';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface FakeItem {
  name: string;
  count: number;
  slot?: number;
}
export interface FakeBlock {
  name: string;
  position: Vec3;
}
/** A loaded entity as the recorder models it — mirrors the real mineflayer shape the village reads. */
export interface FakeEntity {
  name?: string;
  username?: string;
  type?: string;
  position?: Vec3;
  id?: number;
  height?: number;
  isValid?: boolean;
}
export interface FakeWindow {
  id: number;
  type?: string;
  title?: string;
}
export interface ClickRecord {
  slot: number;
  mouseButton: number;
  mode: number;
  /** Which window the click was actually routed to (R1: the OPEN window hijacks clicks). */
  routedTo: number | null;
}

export interface RecordingBotOptions {
  username?: string;
  position?: Vec3;
  inventory?: FakeItem[];
}

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

export class RecordingBot extends EventEmitter {
  readonly username: string;
  readonly entity: { position: Vec3 };
  readonly game = { dimension: 'overworld' };
  /** The low-level protocol client — packet seam for craft quiescence + death (R1–R3, R27). */
  readonly _client = new EventEmitter();
  readonly inventory: { items: () => FakeItem[] };

  // ── vitals (read by the per-bot snapshot, M1-5) ──
  health = 20;
  food = 20;
  heldItem: { name: string } | null = null;
  /** World-time seam — drive with setTime(...) then emit('time') in tests (M5). */
  readonly time = { timeOfDay: 1000 };
  /** Entities seam — the signal adapter + combat skills + snapshot read it; seed with setEntities(). */
  entities: Record<string, FakeEntity | undefined> = {};

  currentWindow: FakeWindow | null = null;
  readonly clicks: ClickRecord[] = [];

  /** Ordered recorder of side-effecting calls — the abort SEQUENCE ORDER assertion reads it (R4). */
  readonly calls: string[] = [];
  /** Messages passed to {@link chat} (the interceptor drops `/`-prefixed ones before they land — R25). */
  readonly sentChat: string[] = [];
  /** Plugins handed to {@link loadPlugin}. */
  readonly loadedPlugins: unknown[] = [];

  /** Plugin hooks the hardening corpus pauses during a craft (R1–R3). */
  readonly autoEat = {
    enabled: true,
    isEating: false,
    lastOpts: undefined as unknown,
    enableAuto: () => {
      this.autoEat.enabled = true;
      this.calls.push('autoEat.enableAuto');
    },
    disableAuto: () => {
      this.autoEat.enabled = false;
      this.calls.push('autoEat.disableAuto');
    },
    setOpts: (opts: unknown) => {
      this.autoEat.lastOpts = opts;
      this.calls.push('autoEat.setOpts');
    },
  };
  readonly armorManager = {
    paused: false,
    equipAll: async (): Promise<void> => {},
    pause: () => {
      this.armorManager.paused = true;
      this.calls.push('armorManager.pause');
    },
    resume: () => {
      this.armorManager.paused = false;
      this.calls.push('armorManager.resume');
    },
  };

  /** Pathfinder seam — bounds (R6) are plain fields; goto MOVES the bot so hops converge (R7). */
  readonly pathfinder = {
    thinkTimeout: 5000, // upstream default — boundPathfinder must lower it (R6)
    tickTimeout: 40,
    searchRadius: -1, // upstream default is UNBOUNDED (R6)
    movements: undefined as unknown,
    /** Goals passed to {@link goto}, in order — the hop-leg test reads their coords (R7). */
    gotoGoals: [] as Array<{ x: number; y: number; z: number }>,
    setMovements: (m: unknown) => {
      this.pathfinder.movements = m;
      this.calls.push('pathfinder.setMovements');
    },
    setGoal: (goal: unknown) => {
      this.calls.push(goal === null ? 'pathfinder.setGoal(null)' : 'pathfinder.setGoal');
    },
    stop: () => void this.calls.push('pathfinder.stop'),
    goto: async (goal: { x: number; y: number; z: number }): Promise<void> => {
      this.calls.push('pathfinder.goto');
      this.pathfinder.gotoGoals.push({ x: goal.x, y: goal.y, z: goal.z });
      // Arriving moves the body, so the next leg computes from the new position (R7).
      if (this.entity) this.entity.position = { x: goal.x, y: goal.y, z: goal.z };
    },
  };
  /** pvp seam — `stop` is in the abort sequence (R4); `attack` flips isValid so a kill loop terminates. */
  readonly pvp = {
    stop: () => void this.calls.push('pvp.stop'),
    attack: (target: FakeEntity): Promise<void> => {
      this.calls.push('pvp.attack');
      if (target) target.isValid = false;
      return Promise.resolve();
    },
  };
  /** collectblock seam — abort clears `targets` and calls `cancelTask` first (R4/R10). */
  readonly collectBlock = {
    targets: [] as unknown[],
    cancelTask: (cb?: (err?: Error) => void) => {
      this.calls.push('collectBlock.cancelTask');
      if (cb) cb();
    },
  };

  private items: FakeItem[];
  private readonly blocks = new Map<string, string>();
  private digMode: 'never' | 'resolve' | 'reject' = 'resolve';
  private pathTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: RecordingBotOptions = {}) {
    super();
    this.username = opts.username ?? 'RecordingBot';
    this.entity = { position: opts.position ?? { x: 0, y: 64, z: 0 } };
    this.items = opts.inventory ? [...opts.inventory] : [];
    this.inventory = { items: () => [...this.items] };
  }

  // ── narrowed Bot seam methods ──────────────────────────────────────────
  /** Public chat — the interceptor wraps this; here we just record what actually landed (R25). */
  chat(message: string): void {
    this.sentChat.push(message);
  }
  /** Records the plugin (never throws) — the fallible-load path is exercised by overriding this (R16). */
  loadPlugin(plugin: unknown): void {
    this.loadedPlugins.push(plugin);
    this.calls.push('loadPlugin');
  }
  /** Model a load-bearing plugin that FAILED to attach — the journal-the-absence path (FIX-4/R16). */
  dropLoadBearingPlugin(name: 'pvp' | 'armorManager' | 'collectBlock'): void {
    Reflect.deleteProperty(this, name);
  }
  /** Disconnect — real mineflayer emits `end` on quit, so the pool's onEnd path is reachable. */
  quit(_reason?: string): void {
    this.calls.push('quit');
    this.emit('end', _reason ?? 'quit');
  }
  /** Set the vitals fields in one go (test convenience). */
  setVitals(v: { health?: number; food?: number; held?: string | null }): void {
    if (v.health !== undefined) this.health = v.health;
    if (v.food !== undefined) this.food = v.food;
    if (v.held !== undefined) this.heldItem = v.held === null ? null : { name: v.held };
  }
  /** Set the world time (drive the night-falls/new-day emitter; pair with emit('time')). */
  setTime(timeOfDay: number): void {
    this.time.timeOfDay = timeOfDay;
  }
  /** Seed the entities table. Each entity defaults `isValid:true` so a kill loop terminates only
   *  after pvp.attack flips it false. */
  setEntities(map: Record<string, FakeEntity>): void {
    const seeded: Record<string, FakeEntity> = {};
    for (const [k, e] of Object.entries(map)) seeded[k] = { isValid: true, ...e };
    this.entities = seeded;
  }

  // ── registry (stable name↔id; D1 unknown-item seam) ──────────────────
  private nextId = 1;
  private readonly nameToId = new Map<string, number>();
  private readonly idToName = new Map<number, string>();
  private idFor(name: string): number {
    let id = this.nameToId.get(name);
    if (id === undefined) {
      id = this.nextId++;
      this.nameToId.set(name, id);
      this.idToName.set(id, name);
    }
    return id;
  }
  private readonly unknownItems = new Set<string>();
  /** Mark item names absent from the registry so a lookup resolves `undefined` (D1 guard test). */
  setUnknownItems(names: string[]): void {
    for (const n of names) this.unknownItems.add(n);
  }
  readonly registry = {
    itemsByName: new Proxy({} as Record<string, { id: number } | undefined>, {
      get: (_t, name): { id: number } | undefined =>
        typeof name === 'string' && !this.unknownItems.has(name) ? { id: this.idFor(name) } : undefined,
    }),
    blocksByName: new Proxy({} as Record<string, { id: number } | undefined>, {
      get: (_t, name): { id: number } | undefined =>
        typeof name === 'string' && !this.unknownItems.has(name) ? { id: this.idFor(name) } : undefined,
    }),
  };

  // ── live-mutable inventory (REAL state — gate/loop convergence reads it both ways, P-8) ──
  setInventory(items: FakeItem[]): void {
    this.items = [...items];
  }
  give(name: string, count: number): void {
    const existing = this.items.find((i) => i.name === name);
    if (existing) existing.count += count;
    else this.items.push({ name, count });
  }
  countItem(name: string): number {
    return this.items.filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
  }

  // ── D-10: pathfinder liveness fault seam ─────────────────────────────
  /** Emit `path_update` every `intervalMs` WITHOUT moving — the "long legit goTo" case. */
  startPathUpdates(intervalMs = 1000): () => void {
    this.stopPathUpdates();
    this.pathTimer = setInterval(() => {
      this.emit('path_update', { status: 'partial', path: [] });
    }, intervalMs);
    this.pathTimer.unref();
    return () => this.stopPathUpdates();
  }
  stopPathUpdates(): void {
    if (this.pathTimer) {
      clearInterval(this.pathTimer);
      this.pathTimer = undefined;
    }
  }

  // ── D-10: dig with controllable resolution (the stall test digs a SEEDED block forever) ──
  setDigMode(mode: 'never' | 'resolve' | 'reject'): void {
    this.digMode = mode;
  }
  /** Emits exactly one start pulse, then behaves per `digMode`. */
  dig(block: FakeBlock): Promise<void> {
    this.emit('diggingStarted', block);
    if (this.digMode === 'never') return new Promise<void>(() => {});
    if (this.digMode === 'reject') return Promise.reject(new Error(`dig FAILED at ${key(block.position)}`));
    this.blocks.delete(key(block.position));
    this.emit('diggingCompleted', block);
    return Promise.resolve();
  }

  // ── craft recorder (routing + pause-state capture; confirmed via the packet seam, R1–R3) ──
  readonly crafted: Array<{ recipe: string; count: number; routedWindow: number | null; autoEatEnabledAtCraft: boolean; armorPausedAtCraft: boolean }> = [];
  /** Stand-in for mineflayer's bot.recipesFor — one trivial recipe per item name. */
  recipesFor(itemName: string): Array<{ name: string; result: { id: number; count: number } }> {
    return [{ name: itemName, result: { id: this.idFor(itemName), count: 1 } }];
  }
  /** Stand-in for bot.craft: records routing + pause state (R1), confirms via a set_slot packet (R2). */
  async craft(recipe: { name: string }, count: number, _table?: unknown): Promise<void> {
    this.crafted.push({
      recipe: recipe.name,
      count,
      routedWindow: this.currentWindow?.id ?? null,
      autoEatEnabledAtCraft: this.autoEat.enabled,
      armorPausedAtCraft: this.armorManager.paused,
    });
    this.give(recipe.name, count);
    this.packetSetSlot(0, 0, { name: recipe.name, count });
  }

  // ── R1–R3: window + click routing + packet seams ─────────────────────
  openWindow(win: FakeWindow): void {
    this.currentWindow = win;
    this.emit('windowOpen', win);
  }
  closeWindow(win?: FakeWindow): void {
    const w = win ?? this.currentWindow;
    if (w && this.currentWindow?.id === w.id) this.currentWindow = null;
    this.calls.push('closeWindow');
    this.emit('windowClose', w);
  }
  /** mineflayer routes every click to the OPEN window regardless of intent (R1). */
  clickWindow(slot: number, mouseButton: number, mode: number): Promise<void> {
    this.clicks.push({ slot, mouseButton, mode, routedTo: this.currentWindow?.id ?? null });
    return Promise.resolve();
  }
  /** Simulate the server confirming a slot change (R3 quiescence signal). */
  packetSetSlot(windowId: number, slot: number, item: FakeItem | null): void {
    this._client.emit('set_slot', { windowId, slot, item });
  }
  packetWindowItems(windowId: number, items: Array<FakeItem | null>): void {
    this._client.emit('window_items', { windowId, items });
  }

  // ── live-mutable block map (SEEDED state the snapshot/stall tests read; no simulation) ──
  setBlock(pos: Vec3, name: string): void {
    this.blocks.set(key(pos), name);
  }
  blockAt(pos: Vec3): FakeBlock | null {
    const name = this.blocks.get(key(pos));
    return name ? { name, position: pos } : null;
  }

  // ── INERT stubs — never simulate the world (that is the skill tier's job, docs/26 B4/B5) ──
  /** Always empty — NEVER simulates mineflayer's palette pre-check (R76 lives in the skill tier now). */
  findBlocks(_opts: { matching: ((b: FakeBlock) => boolean) | number | number[]; maxDistance?: number; count?: number; point?: Vec3 }): Vec3[] {
    return [];
  }
  /** Always null — reflex skills must no-op cleanly on an empty world (P-31), never throw. */
  findBlock(_opts: { matching: ((b: FakeBlock) => boolean) | number | number[]; maxDistance?: number; count?: number; point?: Vec3 }): FakeBlock | null {
    return null;
  }
  /** Containers are a skill-tier concern — a logic-tier test reaching for one gets a NAMED refusal (S10). */
  openContainer(block: FakeBlock): Promise<never> {
    return Promise.reject(
      new Error(`RecordingBot.openContainer(${key(block.position)}): containers are INERT on the recorder — container semantics are proven on the real server (skill tier)`),
    );
  }

  // ── R55: the DELAY FAULT SEAM survives (the knob); the farm flip model does not. ──
  private activateDelayMs = 30;
  /** Tune the (modelled) server-confirmation delay — kept so R55-style timing faults stay injectable. */
  setActivateDelayMs(ms: number): void {
    this.activateDelayMs = ms;
  }
  /** Read the current delay knob (fault-seam assertions). */
  activateDelay(): number {
    return this.activateDelayMs;
  }
  /** Set the held item (mineflayer's bot.equip; accepts an inventory item object or a numeric id). */
  equip(item: { name: string } | number, _destination?: string): Promise<void> {
    const name = typeof item === 'number' ? (this.idToName.get(item) ?? String(item)) : item.name;
    this.heldItem = { name };
    this.calls.push('equip:' + name);
    return Promise.resolve();
  }
  /** Records the activation and resolves — NO block flips (the R55 flip behavior is skill-tier). */
  activateBlock(_block: FakeBlock): Promise<void> {
    this.calls.push('activateBlock');
    return Promise.resolve();
  }
}

// Compile-time proof that RecordingBot structurally satisfies the narrowed Bot seam (types/bot.ts) —
// moved here from FakeBot (docs/26 B2 keep-list f). If bots/ widens the seam, this fails to compile
// until the recorder grows.
const _assertRecordingBotIsBot: Bot = new RecordingBot();
void _assertRecordingBotIsBot;
