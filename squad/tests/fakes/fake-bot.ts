// FakeBot — a no-Minecraft stand-in for a mineflayer bot, after Eden's (copied idea, rewritten for Squad's
// surface): an event emitter with a position, an inventory, plugin objects whose long calls can be held open and
// are rejected by the abort sequence (as pathfinder's goto is by stop/setGoal(null)), and a `calls` recorder.

import { EventEmitter } from 'node:events';

import { Vec3 } from 'vec3';

export interface FakeItem {
  name: string;
  count: number;
}

export class FakeBot extends EventEmitter {
  username: string;
  entity: { position: Vec3; type: string; username: string; isValid: boolean };
  readonly _client = new EventEmitter();
  health = 20;
  food = 20;
  heldItem: { name: string } | null = null;
  currentWindow: unknown = null;
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
    slots: [] as Array<{ name: string } | null>,
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
    this.entity = { position: opts.position ?? new Vec3(0, 64, 0), type: 'player', username, isValid: true };
    this.items = opts.items ? [...opts.items] : [];
  }

  setItems(items: FakeItem[]): void {
    this.items = [...items];
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
  }
  activateItem(): void {
    this.calls.push('activateItem');
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
    this.calls.push(`equip(${(item as { name?: string }).name ?? item},${dest})`);
    this.heldItem = { name: String((item as { name?: string }).name ?? item) };
  }
  async lookAt(): Promise<void> {
    this.calls.push('lookAt');
  }
  blockAt(): null {
    return null;
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
