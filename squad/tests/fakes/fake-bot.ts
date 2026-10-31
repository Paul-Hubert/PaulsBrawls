// FakeBot — a no-Minecraft stand-in for a mineflayer bot, after Eden's (copied idea, rewritten for Squad's
// surface): an event emitter with a position, an inventory (with the off-hand slot 45), plugin objects whose long
// calls can be held open and are rejected by the abort sequence (as pathfinder's goto is by stop/setGoal(null)), and
// a `calls` recorder. Optional: a block world (`world`, e.g. flatWorld()) and `autoWalk`, which makes a positional
// pathfinder goal arrive (the bot stands on the goal block, the goal is cleared as a reached goal is).

import { EventEmitter } from 'node:events';

import { Vec3 } from 'vec3';

export interface FakeItem {
  name: string;
  count: number;
}

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
  entity: { position: Vec3; type: string; username: string; isValid: boolean; yaw: number; pitch: number };
  readonly _client = new EventEmitter();
  health = 20;
  food = 20;
  heldItem: { name: string } | null = null;
  /** Mineflayer's flag: set by activateItem, cleared by deactivateItem. */
  usingHeldItem = false;
  currentWindow: unknown = null;
  /** Blocks for blockAt (null: every block unknown, as an unloaded chunk). */
  world: ((p: Vec3) => FakeBlock | null) | null = null;
  /** When true, a pathfinder goal with a position (GoalBlock, GoalNear, GoalNearXZ) arrives after `walkMs`. */
  autoWalk = false;
  walkMs = 10;
  entities: Record<string, unknown> = {};
  players: Record<string, { entity: unknown }> = {};
  readonly calls: string[] = [];
  readonly sentChat: string[] = [];
  readonly registry = { itemsByName: {} as Record<string, { id: number }>, blocksByName: {} as Record<string, { id: number; name: string }>, entitiesByName: {} as Record<string, unknown>, foodsByName: {} };
  private items: FakeItem[];
  /** Pending long calls (goto, collect, attack): rejected by the abort sequence. */
  private pending = new Set<(e: Error) => void>();
  /** When true, pathfinder.goto/collect hang until aborted (to test reclaim mid-action). */
  hang = false;

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
  readonly hawkEye = {
    oneShot: () => void this.calls.push('hawkEye.oneShot'),
    stop: () => void this.calls.push('hawkEye.stop'),
  };

  constructor(username = 'Bot', opts: { position?: Vec3; items?: FakeItem[] } = {}) {
    super();
    this.setMaxListeners(100);
    this.username = username;
    this.entity = { position: opts.position ?? new Vec3(0, 64, 0), type: 'player', username, isValid: true, yaw: 0, pitch: 0 };
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
  }
  activateItem(offHand = false): void {
    this.calls.push(offHand ? 'activateItem(offHand)' : 'activateItem');
    this.usingHeldItem = true;
  }
  /** Mineflayer's look: radians, its own convention (faceYaw converts). */
  async look(yaw: number, pitch: number, force?: boolean): Promise<void> {
    this.calls.push(`look(${yaw.toFixed(3)},${pitch.toFixed(3)}${force ? ',force' : ''})`);
    this.entity.yaw = yaw;
    this.entity.pitch = pitch;
  }
  clearControlStates(): void {
    this.calls.push('clearControlStates');
  }
  setControlState(control: string, state: boolean): void {
    this.calls.push(`setControlState(${control},${state})`);
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
    this.heldItem = { name };
  }
  async lookAt(): Promise<void> {
    this.calls.push('lookAt');
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
