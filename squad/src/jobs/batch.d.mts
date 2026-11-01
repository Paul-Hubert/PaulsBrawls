// Types of batch.mjs: the job handler contract and the batch runner shared by the workers and the inline fallback.

import type { EntityReader } from './entities.mjs';

/** P1's world reader as the handlers see it (squad/src/world/reader.mjs `openWorld`); null when no world is given. */
export interface WorldReaderLike {
  enter(): void;
  leave(): void;
  [k: string]: unknown;
}

/** What a handler's run() gets besides its input. */
export interface JobContext<S = unknown> {
  world: WorldReaderLike | null;
  entities: EntityReader | null;
  /** The dispatcher tick of this batch. */
  tick: number;
  /** The job's deadline (Infinity: none). */
  deadlineTick: number;
  /** What the previous slice returned in { continue: state }; undefined on the first run. */
  state: S | undefined;
  version: string | undefined;
  /** The worker slot index (-1 inline). */
  worker: number;
  /** True when it runs on the main thread (no worker alive). */
  inline: boolean;
  /** What is left of this batch's budget, in ms (may be negative). */
  budgetLeftMs(): number;
}

/** What init() gets, once per thread, before any job. */
export interface HandlerEnv {
  version: string | undefined;
  world: WorldReaderLike | null;
  inline: boolean;
  worker: number;
}

/** A job handler module (`export const type`, `export function run`, optional `export function init`). */
export interface JobHandlerModule {
  type: string;
  run(input: unknown, ctx: JobContext): unknown;
  init?(env: HandlerEnv): unknown;
}

export interface WireJob {
  id: number;
  type: string;
  input?: unknown;
  resume?: boolean;
  transferred?: boolean;
  deadlineTick: number;
  est: number;
}

export interface WireError {
  message: string;
  stack?: string;
  name?: string;
}

export type WireResult =
  | { id: number; r: 'done'; value: unknown; ms: number }
  | { id: number; r: 'continue'; ms: number }
  | { id: number; r: 'failed'; ms: number; error: WireError; lost?: boolean; unknownType?: boolean; clone?: boolean }
  | { id: number; r: 'notStarted'; held: boolean };

export interface BatchEnv {
  handlers: Map<string, JobHandlerModule>;
  held: Map<number, { input: unknown; state: unknown }>;
  costs: Map<string, number>;
  world: WorldReaderLike | null;
  entities: EntityReader | null;
  version: string | undefined;
  worker: number;
  inline: boolean;
}

export declare const COST_ALPHA: number;
export declare function loadHandlers(
  urls: string[],
  env: HandlerEnv,
): Promise<{ handlers: Map<string, JobHandlerModule>; errors: Array<{ url: string; message: string }> }>;
export declare function isContinue(v: unknown): v is { continue: unknown };
export declare function serializeError(e: unknown): WireError;
export declare function runBatch(
  batch: { tick: number; budgetMs: number; jobs: WireJob[] },
  env: BatchEnv,
): Promise<{ results: WireResult[]; usedMs: number }>;
