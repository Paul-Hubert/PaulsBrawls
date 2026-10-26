import { fixtureBot } from '../fixture.js';
import type { EvalContext, Scenario } from '../types.js';
import { dist3, pollUntil } from '../util.js';
import { deaths, outfit, parkAllExcept, pollBot, settle, summonEvalZombie, sweepScenario } from './helpers.js';

/**
 * S2 guard-alert-chain — two zombies hit a farmer while a guard stands ~30
 * blocks away. The stock chain must fire with zero deliberations: the farmer's
 * `self-defense` flees and runs TO the guard and tell()s for help; the guard's
 * `guard-respond` answers the call and kills the threats (with `guard-watch`
 * mopping up anything that closes in). Pass: within 90 s both zombies are
 * dead, the farmer is alive, and the guard came within 6 blocks of the farmer.
 */

const FARMER = 'EvalMargaux';
const GUARD = 'EvalRempart';
const TAG = 'eval_s2';
/** 30 blocks east of the farmer's home — inside the reflex's 48-block guard
 *  search but ~2 chunks out, the edge of what 'tiny' view distance can see. */
const GUARD_POST = { x: 40, y: 64, z: 10 };

interface S2State {
  deathsBefore: number;
  minGuardFarmerDist: number;
}

let state: S2State | null = null;

export const s2GuardAlertChain: Scenario = {
  id: 'S2',
  name: 'guard-alert-chain',
  suite: 'reflex',
  timeoutMs: 90_000,

  async setup(ctx: EvalContext): Promise<void> {
    state = null;
    await ctx.rcon.killTagged(TAG);
    await parkAllExcept(ctx, [FARMER, GUARD]);
    const home = fixtureBot(FARMER).home;
    await ctx.rcon.tp(FARMER, home.x, home.y, home.z);
    await ctx.rcon.tp(GUARD, GUARD_POST.x, GUARD_POST.y, GUARD_POST.z);
    await settle();
    await outfit(ctx, FARMER, { armor: true });
    await outfit(ctx, GUARD, { sword: true, armor: true });
  },

  async trigger(ctx: EvalContext): Promise<void> {
    state = {
      deathsBefore: await deaths(ctx, FARMER),
      minGuardFarmerDist: Infinity,
    };
    const home = fixtureBot(FARMER).home;
    await summonEvalZombie(ctx, home.x + 2, home.y, home.z + 2, TAG);
    await summonEvalZombie(ctx, home.x - 2, home.y, home.z + 2, TAG);
  },

  async assert(ctx: EvalContext): Promise<void> {
    const s = state;
    if (!s) throw new Error('trigger did not run');
    await pollUntil({ label: 'S2 guard chain', timeoutMs: this.timeoutMs, intervalMs: 1_000 }, async () => {
      if ((await deaths(ctx, FARMER)) > s.deathsBefore) {
        throw new Error('S2: the farmer DIED — the tell→respond chain did not save them');
      }
      const farmer = await pollBot(ctx, FARMER);
      const guard = await pollBot(ctx, GUARD);
      if (farmer.position && guard.position) {
        s.minGuardFarmerDist = Math.min(s.minGuardFarmerDist, dist3(farmer.position, guard.position));
      }
      const zombiesAlive = await ctx.rcon.anyEntityWithTag(TAG);
      return {
        done: !zombiesAlive && s.minGuardFarmerDist <= 6 && (farmer.health ?? 0) > 0,
        detail: `zombiesAlive=${zombiesAlive} minGuardFarmerDist=${s.minGuardFarmerDist.toFixed(1)} farmerHealth=${farmer.health}`,
      };
    });
  },

  async teardown(ctx: EvalContext): Promise<void> {
    await sweepScenario(ctx, TAG);
  },
};
