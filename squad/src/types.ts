// Shared shapes of the control API and the order machinery (docs/29 §7, §10).

import type { Player } from './roster';

export type { Player } from './roster';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** The commander as the mod saw them when they typed the command (main thread, exact). */
export interface Snapshot {
  position: Vec3Like;
  yaw: number;
  pitch: number;
  dimension: string;
  heldItem: string | null;
  lookBlock: (Vec3Like & { name: string }) | null;
  lookEntity: { name: string; type: string; username?: string; position: Vec3Like } | null;
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
  kind: 'granted' | 'left' | 'joined' | 'acquired' | 'released';
  bot: string;
  role?: string;
  reason?: string;
  by?: string;
}

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
