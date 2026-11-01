// The `aim` job (docs/37 P3): one aim update of a drawing archer, solved on a reader worker over the shared world
// and the entity snapshot (squad/src/aim/solve.mjs). The main thread submits it two ticks before the update's tick
// (aim/draw.ts), so its answer is there on time; an answer past its deadline keeps the last aim.
//
// Input: AimInput (aim/solve.d.mts); answer: AimSolution. Without a shared world in this thread (a pool built with
// world.enabled off), every block reads as unknown: aim/draw.ts does not submit then, it solves on the main thread
// over the bot's own world.

import { solveAim } from '../../aim/solve.mjs';

export const type = 'aim';
/** It reads the entity snapshot (the hitboxes in the way): the pool publishes it for these jobs. */
export const needsEntities = true;

export function run(input, ctx) {
  return solveAim(input, ctx.world, ctx.entities);
}
