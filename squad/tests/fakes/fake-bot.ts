// FakeBot — a no-Minecraft stand-in for a mineflayer bot, after Eden's (copied idea, rewritten for Squad's
// surface): an event emitter with a position, an inventory (with the off-hand slot 45), plugin objects whose long
// calls can be held open and are rejected by the abort sequence (as pathfinder's goto is by stop/setGoal(null)), and
// a `calls` recorder. Optional: a block world (`world`, e.g. flatWorld()) and `autoWalk`, which makes a positional
// pathfinder goal arrive (the bot stands on the goal block, the goal is cleared as a reached goal is), and `archer()`:
// physics ticks (fast, in bursts, as mineflayer catches up) and a bow that fires when released after a draw (one
// arrow leaves the inventory, the release is recorded with the look it flew at, and the arrow's spawn_entity packet
// reaches `_client` with this bot as its owner; a bow with Infinity keeps the arrow). `physics()`: physics ticks one
// at a time. Each tick moves the bot as prismarine-physics does on the ground (docs/43 B): a held `forward` adds the
// walking acceleration (0.098 a tick; 0.3 of it sneaking) along its look (mineflayer's yaw) to its velocity, the body
// moves by the velocity, then keeps 0.546 of it (friction): 0.216 blocks a tick at full walk, and a body let go slides
// on (velocity × 2.2). No collisions; `entity.velocity` is mineflayer's (after the tick's friction).

import { EventEmitter } from 'node:events';

import { Vec3 } from 'vec3';

export interface FakeItem {
  name: string;
  count: number;
  /** As prismarine-item's `enchants` before 1.20.5 ({ name, lvl }). */
  enchants?: Array<{ name: string; lvl: number }>;
}

/** minecraft-data's arrow entity (1.21.1): the spawn_entity packet's `type` is its internal id. */
export const ARROW_ENTITY = { id: 4, internalId: 4, name: 'arrow', type: 'projectile' };

export interface FakeBlock {
  name: string;
  boundingBox: string;
}

/** Stone up to `groundY`, air above; `solid` adds blocks ("x,y,z"), `unloaded(x, z)` makes a column unknown. */
export function flatWorld(groundY = 63, solid: Iterable<string> = [], unloaded: (x: number, z: number) => boolean = () => false): (p: Vec3) => FakeBlock | null {
  const extra = new Set(solid);
  return (p: Vec3) => {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    if (unloaded(x, z)) return null;
    return y <= groundY || extra.has(`${x},${y},${z}`) ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  };
}

export class FakeBot extends EventEmitter {
  username: string;
  entity: { position: Vec3; velocity: Vec3; onGround: boolean; type: string; username: string; isValid: boolean; yaw: number; pitch: number };
  readonly _client = new EventEmitter();
  health = 20;
  food = 20;
  heldItem: { name: string; enchants?: FakeItem['enchants'] } | null = null;
  /** Mineflayer's flag: set by activateItem, cleared by deactivateItem. */
  usingHeldItem = false;
  currentWindow: unknown = null;
  /** Blocks for blockAt (null: every block unknown, as an unloaded chunk). */
  world: ((p: Vec3) => FakeBlock | null) | null = null;
  /** When true, a pathfinder goal with a position (GoalBlock, GoalNear, GoalNearXZ) arrives after `walkMs`. */
  autoWalk = false;
  walkMs = 10;
  entities: Record<string, unknown> = {};
  players: Record<string, { entity: unknown; gamemode?: number }> = {};
  readonly calls: string[] = [];
  readonly sentChat: string[] = [];
  readonly registry = { itemsByName: {} as Record<string, { id: number }>, blocksByName: {} as Record<string, { id: number; name: string }>, entitiesByName: { arrow: ARROW_ENTITY } as Record<string, unknown>, foodsByName: {} };
  /** archer(): the network ids of the arrows it spawns. */
  private nextArrowId = 9_000;
  private items: FakeItem[];
  /** Pending long calls (goto, collect, attack): rejected by the abort sequence. */
  private pending = new Set<(e: Error) => void>();
  /** When true, pathfinder.goto/collect hang until aborted (to test reclaim mid-action). */
  hang = false;
  /** The hotbar slot held (mineflayer's quickBarSlot). */
  quickBarSlot = 0;
  /** archer(): physics ticks emitted so far, and the bow drawn since that tick (null: not drawn). */
  ticks = 0;
  drawnAt: number | null = null;
  /** archer(): every release of a drawn bow, with the look it flew at and how many ticks it was drawn. */
  readonly releases: Array<{ yaw: number; pitch: number; drawnTicks: number; fired: boolean }> = [];
  /** Mineflayer's control states: set by setControlState, all released by clearControlStates. */
  controlState: Record<string, boolean> = {};
  /** Blocks a held `forward` moves the bot per physics tick at full walk: a walking player's 4.3 blocks a second. */
  static readonly WALK_PER_TICK = 0.216;
  /** The walking acceleration per tick (prismarine-physics: speed 0.1 × 0.98), and the ground's inertia. */
  static readonly WALK_ACCEL = 0.098;
  static readonly INERTIA = 0.546;
  /** Sneaking: mineflayer's sneakSpeed, 0.3 of walking. */
  static readonly SNEAK_FACTOR = 0.3;
  private bowFires = false;
  private ticker: ReturnType<typeof setInterval> | undefined;

  readonly inventory = {
    items: (): FakeItem[] => [...this.items],
    /** Only the off-hand (45) is kept here: items() are the rest. */
    slots: [] as Array<FakeItem | null>,
  };

  readonly pathfinder = {
    thinkTimeout: 5000,
    tickTimeout: 40,
    searchRadius: -1,
    movements: undefined as unknown,
    goal: null as unknown,
    setMovements: (m: unknown) => {
      this.pathfinder.movements = m;
      this.calls.push('pathfinder.setMovements');
    },
    setGoal: (g: unknown) => {
      this.pathfinder.goal = g;
      this.calls.push(g === null ? 'pathfinder.setGoal(null)' : 'pathfinder.setGoal');
      if (g === null) this.rejectPending('GoalChanged: the goal was changed before it could be completed!');
      else if (this.autoWalk) this.walkTo(g);
    },
    stop: () => {
      this.calls.push('pathfinder.stop');
    },
    isMoving: () => false,
    /** Replace to script pathfinding (e.g. "no path" for some goals). */
    gotoImpl: null as null | ((goal: { constructor: { name: string }; x: number; y?: number; z: number }) => Promise<void>),
    goto: (goal: { constructor: { name: string }; x: number; y?: number; z: number }) => {
      if (this.pathfinder.gotoImpl) {
        this.calls.push(`pathfinder.goto(${goal.constructor.name})`);
        return this.pathfinder.gotoImpl(goal);
      }
      return this.longCall('pathfinder.goto', () => {
        this.entity.position = new Vec3(goal.x, goal.y ?? this.entity.position.y, goal.z);
      });
    },
  };
  readonly pvp = {
    target: null as unknown,
    attack: async (e: unknown) => {
      this.calls.push('pvp.attack');
      this.pvp.target = e;
    },
    stop: async () => {
      this.calls.push('pvp.stop');
      this.pvp.target = null;
    },
  };
  readonly collectBlock = {
    targets: [] as unknown[],
    collect: (_b: unknown) => this.longCall('collectBlock.collect', () => undefined),
    cancelTask: () => {
      this.calls.push('collectBlock.cancelTask');
      this.rejectPending('collect cancelled');
    },
  };

  constructor(username = 'Bot', opts: { position?: Vec3; items?: FakeItem[] } = {}) {
    super();
    this.setMaxListeners(100);
    this.username = username;
    this.entity = { position: opts.position ?? new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: true, type: 'player', username, isValid: true, yaw: 0, pitch: 0 };
    this.items = opts.items ? [...opts.items] : [];
  }

  setItems(items: FakeItem[]): void {
    this.items = [...items];
  }

  /** autoWalk: stand on the goal's block, then clear the goal as the pathfinder does with a reached goal. */
  private walkTo(g: unknown): void {
    const goal = g as { x?: unknown; y?: unknown; z?: unknown; entity?: unknown };
    if (typeof goal.x !== 'number' || typeof goal.z !== 'number' || goal.entity) return;
    const x = goal.x;
    const z = goal.z;
    const y = typeof goal.y === 'number' ? goal.y : this.entity.position.y;
    setTimeout(() => {
      if (this.pathfinder.goal !== g) return;
      this.entity.position = new Vec3(x + 0.5, y, z + 0.5);
      this.pathfinder.goal = null;
      this.emit('goal_reached', g);
    }, this.walkMs);
  }

  private longCall(name: string, onDone: () => void): Promise<void> {
    this.calls.push(name);
    if (!this.hang) {
      onDone();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const rej = (e: Error): void => {
        this.pending.delete(rej);
        reject(e);
      };
      this.pending.add(rej);
      void resolve;
    });
  }

  private rejectPending(msg: string): void {
    for (const r of [...this.pending]) r(new Error(msg));
  }

  chat(msg: string): void {
    this.sentChat.push(msg);
  }
  whisper(to: string, msg: string): void {
    this.sentChat.push(`@${to} ${msg}`);
  }
  quit(): void {
    this.calls.push('quit');
    this.emit('end', 'quit');
  }
  end(reason?: string): void {
    this.calls.push(`end(${reason ?? ''})`);
    this.emit('end', reason ?? 'end');
  }
  stopDigging(): void {
    this.calls.push('stopDigging');
  }
  deactivateItem(): void {
    this.calls.push('deactivateItem');
    this.usingHeldItem = false;
    if (this.bowFires && this.drawnAt !== null && this.heldItem?.name === 'bow') {
      const drawnTicks = this.ticks - this.drawnAt;
      const arrows = this.items.find((i) => i.name === 'arrow');
      const fired = !!arrows && arrows.count > 0;
      // Infinity: a plain arrow is not used up (it still needs one in the inventory).
      const infinity = !!this.heldItem.enchants?.some((e) => e.name === 'infinity' && e.lvl > 0);
      if (fired && !infinity) this.items = this.items.map((i) => (i === arrows ? { ...i, count: i.count - 1 } : i)).filter((i) => i.count > 0);
      this.releases.push({ yaw: this.entity.yaw, pitch: this.entity.pitch, drawnTicks, fired });
      if (fired) {
        // The server spawns the arrow at the eyes with its owner's entity id in the packet's data (0 when unknown).
        const p = this.entity.position;
        const id = (this.entity as { id?: number }).id;
        this._client.emit('spawn_entity', { entityId: this.nextArrowId++, type: ARROW_ENTITY.internalId, objectData: id ?? 0, x: p.x, y: p.y + 1.52, z: p.z });
      }
    }
    this.drawnAt = null;
  }
  activateItem(offHand = false): void {
    this.calls.push(offHand ? 'activateItem(offHand)' : 'activateItem');
    this.usingHeldItem = true;
    if (!offHand && this.bowFires && this.heldItem?.name === 'bow') this.drawnAt = this.ticks;
  }
  /** A hotbar switch: the server drops an item in use (a drawn bow is put down unfired). */
  setQuickBarSlot(slot: number): void {
    this.calls.push(`setQuickBarSlot(${slot})`);
    this.quickBarSlot = slot;
    this.usingHeldItem = false;
    this.drawnAt = null;
  }
  /**
   * Shoot like a real bot: physics ticks every `tickMs` (emitted in bursts per timer callback, as mineflayer catches
   * up, so a 24-tick draw takes ~50 ms at 2 ms; 0: none, the test ticks), and a released bow fires one arrow.
   */
  archer(opts: { tickMs?: number } = {}): this {
    this.bowFires = true;
    const tickMs = opts.tickMs ?? 2;
    // 0: no ticker, the test emits physicsTick itself.
    if (this.ticker || tickMs === 0) return this;
    let last = Date.now();
    this.ticker = setInterval(() => {
      const now = Date.now();
      const n = Math.min(20, Math.max(1, Math.floor((now - last) / tickMs)));
      last = now;
      for (let i = 0; i < n; i++) this.tick();
    }, tickMs);
    this.ticker.unref();
    return this;
  }
  /** Physics ticks one per `tickMs` (no bursts), each moving the bot by its controls: what a walker needs. Restarts the clock. */
  physics(opts: { tickMs?: number } = {}): this {
    this.stopTicks();
    this.ticker = setInterval(() => this.tick(), opts.tickMs ?? 10);
    this.ticker.unref();
    return this;
  }
  /** One physics tick: a held `forward` accelerates the bot along its look, it moves, friction, then `physicsTick`. */
  tick(): void {
    this.ticks++;
    const v = this.entity.velocity;
    if (this.controlState.forward) {
      // A speed attribute (a horse's, mount.ts) gives its own acceleration, as prismarine-physics reads it.
      const speed = (this.entity as { attributes?: Record<string, { value: number }> }).attributes?.['minecraft:movement_speed']?.value;
      const a = (speed !== undefined ? speed * 0.98 : FakeBot.WALK_ACCEL) * (this.controlState.sneak ? FakeBot.SNEAK_FACTOR : 1);
      const yaw = this.entity.yaw; // mineflayer's: 0 looks toward −Z, π/2 toward −X
      v.x += -Math.sin(yaw) * a;
      v.z += -Math.cos(yaw) * a;
    }
    if (v.x !== 0 || v.z !== 0) this.entity.position = this.entity.position.offset(v.x, 0, v.z);
    v.x *= FakeBot.INERTIA;
    v.z *= FakeBot.INERTIA;
    if (Math.abs(v.x) < 1e-6) v.x = 0;
    if (Math.abs(v.z) < 1e-6) v.z = 0;
    this.emit('physicsTick');
  }
  stopTicks(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }
  /** Mineflayer's look: radians, its own convention (faceYaw converts). */
  async look(yaw: number, pitch: number, force?: boolean): Promise<void> {
    this.calls.push(`look(${yaw.toFixed(3)},${pitch.toFixed(3)}${force ? ',force' : ''})`);
    this.entity.yaw = yaw;
    this.entity.pitch = pitch;
  }
  clearControlStates(): void {
    this.calls.push('clearControlStates');
    this.controlState = {};
  }
  setControlState(control: string, state: boolean): void {
    this.calls.push(`setControlState(${control},${state})`);
    this.controlState[control] = state;
  }
  closeWindow(): void {
    this.calls.push('closeWindow');
    this.currentWindow = null;
  }
  async equip(item: unknown, dest: string): Promise<void> {
    const name = String((item as { name?: string }).name ?? item);
    this.calls.push(`equip(${name},${dest})`);
    if (dest === 'off-hand') {
      // Moved out of the inventory's items into slot 45 (what was there goes back to the items).
      const i = this.items.findIndex((it) => it.name === name);
      const moved = i >= 0 ? this.items.splice(i, 1)[0]! : { name, count: 1 };
      const old = this.inventory.slots[45];
      if (old) this.items.push(old);
      this.inventory.slots[45] = moved;
      return;
    }
    // The stack itself: a bow keeps its enchantments in hand.
    this.heldItem = item && typeof item === 'object' && 'name' in item ? { ...(item as FakeItem) } : { name };
  }
  async lookAt(): Promise<void> {
    this.calls.push('lookAt');
  }
  /** Mineflayer's single blow (no pvp plugin): the entities hit, in order. */
  readonly hits: unknown[] = [];
  attack(e: unknown): void {
    this.calls.push('attack');
    this.hits.push(e);
  }
  blockAt(p: Vec3): FakeBlock | null {
    return this.world ? this.world(p) : null;
  }
  findBlocks(): Vec3[] {
    return [];
  }
  findBlock(): null {
    return null;
  }
  loadPlugin(): void {
    this.calls.push('loadPlugin');
  }
}

/** A pool over FakeBots (the runner's PoolView). */
export class FakePool {
  readonly bots = new Map<string, FakeBot>();
  add(name: string, opts: { items?: FakeItem[] } = {}): FakeBot {
    const b = new FakeBot(name, opts);
    this.bots.set(name, b);
    return b;
  }
  bot(name: string): never {
    return this.bots.get(name) as never;
  }
  movements(): unknown {
    return 'default-movements';
  }
}
