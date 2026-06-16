// FakeBot — a no-Minecraft stand-in for a mineflayer bot. Its SEAMS are fixed in M0 so
// the M1 (hardening) and M2 (engine) tests can drive it without a rewrite:
//   • M0 baseline: position, inventory, an event emitter.
//   • D-10: timer-driven `path_update` with position held constant; a `dig` promise that
//     never resolves but emits one start pulse.
//   • R1–R3: `currentWindow`, `clickWindow` routing (mineflayer routes clicks to the open
//     window regardless of intent), `_client` `set_slot`/`window_items` packet seams, and
//     auto-eat / armor-manager plugin hooks.
//   • R10: a block field that can hold floating-leaf logs separate from a grounded trunk.
//   • M1: the narrowed `Bot` seam (types/bot.ts) — pathfinder/pvp/collectBlock plugin objects,
//     an ordered `calls` recorder so the abort SEQUENCE ORDER is assertable (R4), a `chat`
//     recorder for the interceptor (R25), `loadPlugin` for fallible plugin loads (R16), and
//     vitals fields (health/food/heldItem) for the snapshot cadence (M1-5).

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

export interface FakeBotOptions {
  username?: string;
  position?: Vec3;
  inventory?: FakeItem[];
}

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

export class FakeBot extends EventEmitter {
  readonly username: string;
  // Non-null in the fake (a FakeBot is always "alive"); the Bot seam allows null for a real,
  // disconnected/dead body, and a non-null is assignable to it.
  readonly entity: { position: Vec3 };
  readonly game = { dimension: 'overworld' };
  /** The low-level protocol client — packet seam for craft quiescence + death (R1–R3, R27). */
  readonly _client = new EventEmitter();
  readonly inventory: { items: () => FakeItem[] };

  // ── M1 vitals fields (read by the per-bot snapshot, M1-5). ──
  health = 20;
  food = 20;
  heldItem: { name: string } | null = null;
  // ── M5 world-time seam — mineflayer's `bot.time.timeOfDay` (0..24000); the night-falls/new-day
  //    emitter edges on it. Drive with setTime(...) then emit('time') in tests. ──
  readonly time = { timeOfDay: 1000 };
  // ── M5 entities seam — mineflayer's `bot.entities` (id→entity). The reactivity signal adapter
  //    (bots/signals.ts) derives a hurt's attacker from the nearest hostile here; combat skills scan it.
  //    NOT on the narrowed Bot seam (read via cast); defaults empty, seed with setEntities() in tests. ──
  entities: Record<string, { name?: string; position?: Vec3 } | undefined> = {};

  currentWindow: FakeWindow | null = null;
  readonly clicks: ClickRecord[] = [];

  /**
   * Ordered recorder of side-effecting calls — the abort sequence-order assertion (R4) reads it,
   * and the plugin-load / chat tests append their own markers.
   */
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
  /** pvp seam — only `stop` is in the abort sequence (R4); records its order. */
  readonly pvp = {
    stop: () => void this.calls.push('pvp.stop'),
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

  constructor(opts: FakeBotOptions = {}) {
    super();
    this.username = opts.username ?? 'FakeBot';
    this.entity = { position: opts.position ?? { x: 0, y: 64, z: 0 } };
    this.items = opts.inventory ? [...opts.inventory] : [];
    this.inventory = { items: () => [...this.items] };
  }

  // ── M1: narrowed Bot seam methods ────────────────────────────────────
  /** Public chat — the interceptor wraps this; here we just record what actually landed (R25). */
  chat(message: string): void {
    this.sentChat.push(message);
  }
  /** Records the plugin (never throws here) — the fallible-load path is exercised by overriding this in tests (R16). */
  loadPlugin(plugin: unknown): void {
    this.loadedPlugins.push(plugin);
    this.calls.push('loadPlugin');
  }
  /** Disconnect — real mineflayer emits `end` on quit, so the pool's onEnd path is reachable from the fake. */
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
  /** Set the world time (drive the night-falls/new-day emitter; pair with emit('time')) — M5. */
  setTime(timeOfDay: number): void {
    this.time.timeOfDay = timeOfDay;
  }
  /** Seed the entities table (the signal adapter's attacker derivation + combat skills read it) — M5. */
  setEntities(map: Record<string, { name?: string; position?: Vec3 }>): void {
    this.entities = { ...map };
  }

  // ── M1: chest seam (deposit/withdraw helpers) ────────────────────────
  /** Stable name↔id registry (real mineflayer exposes `bot.registry.itemsByName`). */
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
  // D1: names a test marks "unknown" — `bot.registry.itemsByName[name]` returns `undefined` for them,
  // faithfully modelling a real mineflayer miss (which the always-resolve Proxy below otherwise can't).
  private readonly unknownItems = new Set<string>();
  /** Mark item names absent from the registry so a lookup of them resolves `undefined` (D1 guard test). */
  setUnknownItems(names: string[]): void {
    for (const n of names) this.unknownItems.add(n);
  }
  readonly registry = {
    itemsByName: new Proxy({} as Record<string, { id: number } | undefined>, {
      get: (_t, name): { id: number } | undefined =>
        typeof name === 'string' && !this.unknownItems.has(name) ? { id: this.idFor(name) } : undefined,
    }),
    // D1: real mineflayer's `bot.registry` also exposes `blocksByName` (find-block's numeric matcher,
    // and the ctx.mcData surface). Mirror the itemsByName Proxy so a skill reading either resolves.
    blocksByName: new Proxy({} as Record<string, { id: number } | undefined>, {
      get: (_t, name): { id: number } | undefined =>
        typeof name === 'string' && !this.unknownItems.has(name) ? { id: this.idFor(name) } : undefined,
    }),
  };

  private readonly chests = new Map<string, FakeItem[]>();
  /** Seed a chest's contents at a position (test fixture). */
  setChestContents(pos: Vec3, items: FakeItem[]): void {
    this.chests.set(key(pos), items.map((i) => ({ ...i })));
  }
  /** Read a chest's current contents (assertions). */
  chestContents(pos: Vec3): FakeItem[] {
    return [...(this.chests.get(key(pos)) ?? [])];
  }
  private removeItem(name: string, count: number): void {
    const ex = this.items.find((i) => i.name === name);
    if (!ex) return;
    ex.count -= count;
    if (ex.count <= 0) this.items = this.items.filter((i) => i !== ex);
  }
  /** Models bot.openContainer: opens a window AND returns a deposit/withdraw handle backed by a per-position store. */
  openContainer(block: FakeBlock): Promise<{
    deposit: (type: number, metadata: number | null, count: number) => Promise<void>;
    withdraw: (type: number, metadata: number | null, count: number) => Promise<void>;
    containerItems: () => FakeItem[];
    close: () => void;
  }> {
    const k = key(block.position);
    if (!this.chests.has(k)) this.chests.set(k, []);
    const store = this.chests.get(k) as FakeItem[];
    this.openWindow({ id: 100, type: 'minecraft:chest' });
    return Promise.resolve({
      deposit: async (type: number, _metadata: number | null, count: number): Promise<void> => {
        const name = this.idToName.get(type);
        if (!name) throw new Error(`deposit: unknown item id ${type}`);
        const have = this.countItem(name);
        if (have < count) throw new Error(`deposit: only ${have} ${name} in inventory (need ${count})`);
        this.removeItem(name, count);
        const ex = store.find((i) => i.name === name);
        if (ex) ex.count += count;
        else store.push({ name, count });
      },
      withdraw: async (type: number, _metadata: number | null, count: number): Promise<void> => {
        const name = this.idToName.get(type);
        if (!name) throw new Error(`withdraw: unknown item id ${type}`);
        const ex = store.find((i) => i.name === name);
        if (!ex || ex.count < count) throw new Error(`withdraw: only ${ex?.count ?? 0} ${name} in chest (need ${count})`);
        ex.count -= count;
        if (ex.count <= 0) store.splice(store.indexOf(ex), 1);
        this.give(name, count);
      },
      containerItems: (): FakeItem[] => [...store],
      close: (): void => this.closeWindow(),
    });
  }

  // ── inventory control ────────────────────────────────────────────────
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

  // ── D-10: pathfinder liveness ────────────────────────────────────────
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

  // ── D-10: dig with controllable resolution ───────────────────────────
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

  // ── M2: craft seam (the craft-item exemplar exercises R1–R3 over the existing window/packet
  //        seams). A real craft routes through bot.currentWindow (R1) and is confirmed by server
  //        packets, not the promise (R2); record both so the exemplar's hardening is assertable. ──
  readonly crafted: Array<{ recipe: string; count: number; routedWindow: number | null; autoEatEnabledAtCraft: boolean; armorPausedAtCraft: boolean }> = [];
  /** Stand-in for mineflayer's bot.recipesFor — one trivial recipe per item name. */
  recipesFor(itemName: string): Array<{ name: string; result: { id: number; count: number } }> {
    return [{ name: itemName, result: { id: this.idFor(itemName), count: 1 } }];
  }
  /** Stand-in for bot.craft: routes through the open window (R1), confirms via a set_slot packet (R2). */
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

  // ── R10: block field (trunk vs floating leaves) ──────────────────────
  setBlock(pos: Vec3, name: string): void {
    this.blocks.set(key(pos), name);
  }
  blockAt(pos: Vec3): FakeBlock | null {
    const name = this.blocks.get(key(pos));
    return name ? { name, position: pos } : null;
  }
  /** Nearest block matching `opts.matching` (a name predicate, or an id / id[] resolved via the registry)
   *  within `maxDistance` of the bot — mirrors mineflayer's bot.findBlock so the `find-block` stock skill
   *  is exercisable in CI. */
  findBlock(opts: {
    matching: ((b: FakeBlock) => boolean) | number | number[];
    maxDistance?: number;
    point?: Vec3;
  }): FakeBlock | null {
    const origin = opts.point ?? this.entity.position;
    const max = opts.maxDistance ?? 16;
    const matches = (b: FakeBlock): boolean => {
      if (typeof opts.matching === 'function') return opts.matching(b);
      const ids = Array.isArray(opts.matching) ? opts.matching : [opts.matching];
      return ids.includes(this.idFor(b.name));
    };
    let best: FakeBlock | null = null;
    let bestDist = Infinity;
    for (const [k, name] of this.blocks) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      const block: FakeBlock = { name, position: { x, y, z } };
      if (!matches(block)) continue;
      const dist = Math.hypot(x - origin.x, y - origin.y, z - origin.z);
      if (dist <= max && dist < bestDist) {
        best = block;
        bestDist = dist;
      }
    }
    return best;
  }
  /** Build a grounded trunk plus optional disconnected floating logs (the R10 trap). */
  plantTree(base: Vec3, trunkHeight: number, floating: Vec3[] = []): void {
    for (let dy = 0; dy < trunkHeight; dy++) {
      this.setBlock({ x: base.x, y: base.y + dy, z: base.z }, 'oak_log');
    }
    for (const f of floating) this.setBlock(f, 'oak_log');
  }

  // ── R55: farming actions (till / sow) are SERVER-confirmed. bot.activateBlock resolves when the
  //    use-item packet is SENT, but the block flip (dirt→farmland, farmland→crop) only lands a few
  //    ticks later when the server's block-update returns. We model that round-trip DELAY so a skill
  //    that reads bot.blockAt synchronously sees the STALE block (the read-after-write race that
  //    false-reported "le labour n'a pas fonctionné" live), while one that polls/waits sees it flip. ──
  private activateDelayMs = 30;
  /** Tune the server-confirmation delay (a long delay still resolves before the till/sow 2 s poll). */
  setActivateDelayMs(ms: number): void {
    this.activateDelayMs = ms;
  }
  private static readonly CROP_OF: Record<string, string> = {
    wheat_seeds: 'wheat',
    carrot: 'carrots',
    potato: 'potatoes',
    beetroot_seeds: 'beetroots',
    pumpkin_seeds: 'pumpkin_stem',
    melon_seeds: 'melon_stem',
  };
  /** Set the held item (mineflayer's bot.equip; accepts an inventory item object or a numeric id). */
  equip(item: { name: string } | number, _destination?: string): Promise<void> {
    const name = typeof item === 'number' ? (this.idToName.get(item) ?? String(item)) : item.name;
    this.heldItem = { name };
    this.calls.push('equip:' + name);
    return Promise.resolve();
  }
  /** Right-click a block with the held item. Models the hoe (till) and seed (sow) rules, flipping the
   *  block only AFTER {@link activateDelayMs} (R55) — the synchronous return never mutates the world. */
  activateBlock(block: FakeBlock): Promise<void> {
    this.calls.push('activateBlock');
    const held = this.heldItem?.name ?? '';
    const pos = block.position;
    const current = this.blockAt(pos);
    const aboveName = this.blockAt({ x: pos.x, y: pos.y + 1, z: pos.z })?.name;
    const aboveOpen = aboveName === undefined || aboveName === 'air';
    let change: { pos: Vec3; name: string } | null = null;
    if (/_hoe$/.test(held) && current && ['dirt', 'grass_block', 'dirt_path'].includes(current.name) && aboveOpen) {
      change = { pos, name: 'farmland' };
    } else if (current?.name === 'farmland' && FakeBot.CROP_OF[held] && aboveOpen) {
      change = { pos: { x: pos.x, y: pos.y + 1, z: pos.z }, name: FakeBot.CROP_OF[held] };
    }
    if (change) {
      const c = change;
      const timer = setTimeout(() => {
        this.setBlock(c.pos, c.name);
        this.emit('blockUpdate', current, { name: c.name, position: c.pos });
      }, this.activateDelayMs);
      timer.unref();
    }
    return Promise.resolve();
  }
}

// Compile-time proof that FakeBot structurally satisfies the narrowed Bot seam (types/bot.ts).
// If a future change to bots/ widens the seam, this line fails to compile until FakeBot grows.
const _assertFakeBotIsBot: Bot = new FakeBot();
void _assertFakeBotIsBot;
