// Shared shapes of the control API and the order machinery (docs/29 §7, §10).

import type { Player } from './roster';

export type { Player } from './roster';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** An entity the commander looked at or an arrow hit. `id` is the network entity id, mineflayer's `bot.entities` key. */
export interface EntityRef {
  id?: number;
  name: string;
  type: string;
  username?: string;
  position: Vec3Like;
}

export const TRIGGER_KINDS = ['use', 'arrow-release', 'arrow-hit'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** What a bound item did (docs/29 §5.4): a right-click, an arrow leaving the bow, or that arrow's first hit. */
export interface Trigger {
  kind: TriggerKind;
  item: string;
  hit?: { position: Vec3Like; entity?: EntityRef };
}

/** The commander as the mod saw them when they typed the command or used a bound item (main thread, exact). */
export interface Snapshot {
  position: Vec3Like;
  yaw: number;
  pitch: number;
  dimension: string;
  heldItem: string | null;
  lookBlock: (Vec3Like & { name: string }) | null;
  lookEntity: EntityRef | null;
  /** Present when a bound item gave the order (absent for `/bots order`). */
  trigger?: Trigger;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  position: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  dimension: 'overworld',
  heldItem: null,
  lookBlock: null,
  lookEntity: null,
};

export type OrderStatus = 'running' | 'done' | 'failed' | 'stopped' | 'timeout' | 'interrupted';

/** A stored command version, as an order runs it. */
export interface CommandRef {
  author: Player;
  name: string;
  version: number;
}

export interface Vitals {
  health: number;
  food: number;
  position: [number, number, number] | null;
  held: string | null;
  inventory: Record<string, number>;
}

export interface ReportEvent {
  at: number;
  kind: 'granted' | 'left' | 'joined' | 'acquired' | 'released' | 'trigger';
  /** The bot, for the membership kinds (every kind but 'trigger'). */
  bot?: string;
  role?: string;
  reason?: string;
  by?: string;
  /** kind 'trigger' (§5.4): which trigger, with which item, what it did to the order, and where it aimed. */
  trigger?: TriggerKind;
  item?: string;
  outcome?: TriggerOutcome;
  pos?: [number, number, number];
  entity?: string;
}

/** What a bound item's trigger did: started the order, restarted it (it did not listen), reached it, or stopped it. */
export type TriggerOutcome = 'started' | 'restarted' | 'delivered' | 'stopped';

/** Everything §7.4 asks of a report: what `/bots fix` hands the author agent. */
export interface OrderReport {
  id: string;
  command: CommandRef;
  commander: Player;
  trial: boolean;
  args: Record<string, unknown>;
  snap: Snapshot;
  status: OrderStatus;
  result?: string;
  error?: { name: string; message: string; stack?: string; line?: number };
  startedAt: number;
  endedAt?: number;
  bots: Array<{ name: string; role: string; from?: string }>;
  events: ReportEvent[];
  failures: Array<{ bot: string; op: string; item?: unknown; error: string }>;
  logs: string[];
  vitals: { before: Record<string, Vitals>; after: Record<string, Vitals> };
}

/** A line the mod shows to players: French text, an optional clickable suffix. */
export interface Notice {
  to: string[];
  text: string;
  click?: { label: string; command: string; run?: boolean };
}
