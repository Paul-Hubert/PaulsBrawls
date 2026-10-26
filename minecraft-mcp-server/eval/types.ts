import type { AdminClient } from './admin.js';
import type { MockLLM } from './mock-llm.js';
import type { RconClient } from './rcon.js';

export type LLMMode = 'mock' | 'real';
export type SuiteName = 'reflex' | 'trade' | 'tasks' | 'all';

export interface EvalContext {
  rcon: RconClient;
  admin: AdminClient;
  /** null when --llm real (no mock server running). */
  mock: MockLLM | null;
  llmMode: LLMMode;
  log: (line: string) => void;
}

export interface Scenario {
  id: string;
  name: string;
  suite: Exclude<SuiteName, 'all'>;
  /** Budget for the assert phase's polling. */
  timeoutMs: number;
  /** Scenario depends on scripted mock responses / mock failure modes and is
   *  skipped under --llm real. */
  mockOnly?: boolean;
  /** State seeding that must happen BEFORE the village process boots
   *  (e.g. S7 writes a broken skill into the fresh dataDir). */
  preBoot?: (paths: { dataDir: string }) => Promise<void>;
  setup(ctx: EvalContext): Promise<void>;
  trigger(ctx: EvalContext): Promise<void>;
  /** Polls until the pass condition holds; throws with the last observed state
   *  on timeout. */
  assert(ctx: EvalContext): Promise<void>;
  teardown(ctx: EvalContext): Promise<void>;
}

export interface ScenarioResult {
  id: string;
  name: string;
  pass: boolean;
  skipped?: boolean;
  attempts: number;
  elapsedMs: number;
  /** Delta of the scheduler's `completed` counter across the scenario. */
  llmCalls: number;
  failure?: string;
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  llmMode: LLMMode;
  suite: SuiteName;
  pass: boolean;
  scenarios: ScenarioResult[];
}
