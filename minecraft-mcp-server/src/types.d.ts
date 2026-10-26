declare module 'mineflayer-pathfinder' {
  import type { Bot } from 'mineflayer';

  export class Movements {
    constructor(_bot: Bot, _mcData?: unknown);
    blocksToAvoid: Set<number>;
    replaceables: Set<number>;
    liquids: Set<number>;
    liquidCost: number;
    canDig: boolean;
    allowParkour: boolean;
    allowSprinting: boolean;
    maxDropDown: number;
  }
}