// Ambient declarations for the two mineflayer plugins that ship NO type declarations
// (mineflayer-pathfinder, mineflayer-armor-manager). Narrowed to exactly what bots/ uses —
// not a full port of the plugins. The TS-compiled trio (pvp/collectblock/tool) and auto-eat
// ship their own types and need nothing here (R15). No local imports — pure ambient module decls.

declare module 'mineflayer-pathfinder' {
  /** The A* cost model. We only touch the land-bot tuning knobs (ported from v1). */
  export class Movements {
    constructor(bot: unknown, mcData?: unknown);
    blocksToAvoid: Set<number>;
    replaceables: Set<number>;
    allowParkour: boolean;
    allowSprinting: boolean;
    maxDropDown: number;
    liquidCost: number;
  }

  /** Opaque goal marker. */
  export interface Goal {
    isEnd(node: unknown): boolean;
  }

  export namespace goals {
    /** Reach within `range` blocks of (x,y,z). Coords are floored at construction. */
    class GoalNear implements Goal {
      constructor(x: number, y: number, z: number, range: number);
      x: number;
      y: number;
      z: number;
      rangeSq: number;
      isEnd(node: unknown): boolean;
    }
    class GoalBlock implements Goal {
      constructor(x: number, y: number, z: number);
      x: number;
      y: number;
      z: number;
      isEnd(node: unknown): boolean;
    }
  }

  /** The pre-spawn plugin (passed in createBot `plugins`). */
  export const pathfinder: (bot: unknown) => void;

  const _default: {
    pathfinder: typeof pathfinder;
    Movements: typeof Movements;
    goals: typeof goals;
  };
  export default _default;
}

declare module 'mineflayer-armor-manager' {
  /** Auto-equips best armor on playerCollect. Loaded via `bot.loadPlugin`. */
  const plugin: (bot: unknown) => void;
  export default plugin;
}
