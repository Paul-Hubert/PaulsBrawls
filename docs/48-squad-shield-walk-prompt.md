# Prompt: shield bots walk to their place in a `line` facing the order's direction, shield up

You are working in the pauls-brawls repo, on the Squad runtime (`squad/`). Read first: docs/40 §4 (`line`), docs/43
(the formation audit: `approach`, `stepTo`, exact slots), docs/41 §1 (riding: `steer`, `freeRein`, `moveYaw`),
docs/45 (the General's standing orders, which re-form lines backward: `line @back N`), then
`squad/src/stock/line.mjs`, `squad/src/api/formation.ts` (`approach`, `stepTo`), `squad/src/bots/mount.ts`,
`squad/src/api/helpers.ts` (`raiseShield`, `faceYaw`), and the patches `squad/patches/prismarine-physics+1.11.1.patch`
and `mineflayer-pathfinder+2.4.5.patch`. Work only in `squad/` and `docs/`; run `npm run check` in `squad/` before you
finish. Report in one short message per step.

## What Paul wants

In a `line`, a **guard** (a bot with a shield) on its way to its slot, a new formation or a re-formed one, walks there
**facing the order's direction** (`line.yaw`, the direction the wall will face) with its **shield raised**, the way a
shield wall advances, side-steps or falls back under fire. Today it faces where it walks: marching to a slot behind
it, it turns its back (and its shield) to the enemy.

## What is there today (check it, cite `path:line` in your notes)

- `line.mjs` `guard()`: off its slot, it raises the shield and calls `go()` → `approach()` (the pathfinder to within
  2 blocks, then `stepTo` onto the exact place). Only once there does it `faceYaw(bot, line.yaw)`. Its look is the
  walking direction all the way: the pathfinder turns it (`bot.look`, or `bot.pathfinder.steer` when set, squad's
  pathfinder patch), and `stepTo` turns it through `steerWalk`.
- **The mechanism to walk one way and look another already exists, for riders only.** The prismarine-physics patch
  walks a body along `entity.moveYaw ?? entity.yaw`; `steer()` in `mount.ts` sets `moveYaw` instead of the look when
  it is defined; `freeRein()` defines it, but returns a no-op on foot (`if (!isRiding(bot) …)`). The position packets
  of a bot on foot carry its look (`entity.yaw`), so the server would see a guard facing `line.yaw` while it moves
  elsewhere: a strafe or a backward walk, which players do.
- The line's comment says « the bots' physics does not slow a blocking bot ». A vanilla client using an item (a raised
  shield) moves at about 20 % speed; the server does not enforce it. Decide whether the guards keep full speed or
  move at the blocking speed (a realistic wall is slow; a slow wall arrives late), and say why.
- A shield blocks a hit whose source is in front of the holder's look (vanilla: the angle between the look and the
  attacker under 90°; in 26.x, the shield's `blocks_attacks` component). Check what 26.1.2 does before relying on it.

## The behaviour to build (decide and justify each point)

1. **Walk with a free look, on foot.** Generalize the free rein so a bot on foot can walk along one yaw and look along
   another (a new helper in `src/api/` or `mount.ts`, e.g. `walkFacing(bot, yaw)` returning its release, used by
   `line`). The pathfinder's `steer` and `stepTo`'s `steerWalk` must then turn only the walk. Keep riders working as
   they do (a horse archer's `freeRein` must still work, and a horseman is not a guard).
2. **Which guards, when.** Guards (role `guards`) walking to a slot of the current formation: the look stays on
   `line.yaw` (pitch level, or a little down) with the shield up, from the first step to the last. A guard far from
   its slot (say more than 16 blocks, or with no enemy within 32) may walk facing its way and turn when it gets near:
   decide the rule, so a guard crossing a field does not crab-walk the whole way, and a guard re-forming under fire
   never shows its back.
3. **Turning.** A guard whose look is far from `line.yaw` turns first (or while walking), never through the back if
   an enemy is in front; then it keeps that look. Hit back (`strikeBack`) still turns it to the attacker, then back to
   `line.yaw`.
4. **The pathfinder's corner cases.** A path that climbs, descends, jumps or goes through a door with the look fixed:
   check the pathfinder still jumps and climbs when it walks sideways or backward (its jump and parkour decisions read
   the body's direction of travel or its look?), and that a stuck backward walk is detected (`approach`'s and
   `go()`'s timeouts). Fall back to facing the way for a step the guard cannot take otherwise, and log it once.
5. **Other bots of the line.** Melee on the flanks (horsemen, no shield) and archers keep today's behaviour unless
   you show a reason; a horse archer already shoots on the move with its own free rein.

## Rules

- One helper for the free look, pure where it can be; `line.mjs` stays under 400 lines (it is at ~352): the walking
  logic goes into `src/api/`, the line only calls it. Its type in `squad/reference/squad.d.ts` and one line in the
  squad-author prompts (both copies) if scripts may use it.
- Behaviour and docs change in the same commit; tests for every rule on fakes (`tests/fakes/fake-bot.ts` with
  `physics()`, `tests/approach.test.ts`, the `line (guards)` tests in `tests/item-orders.test.ts` as models): a guard
  walking to a slot behind it keeps facing `line.yaw` with its shield up on every tick, a re-formed wall walks
  backward facing the enemy, a guard far away walks facing its way and turns near the slot, a rider's free rein is
  unchanged. A test of the patches if one is touched (`tests/patches.test.ts`).
- Docs: `docs/49-squad-shield-walk.md` (as built: the rule, the speed decision, what 26.1.2's shield blocks, what was
  not checked live), and the `line` paragraphs of docs/40 §4 and `squad/README.md`. The General's doctrine
  (`squad/agent/general/CLAUDE.md`) gets one line if its fighting retreat (`line @back N`) now keeps the shields to
  the enemy.

## Method

1. Audit (a short note with `path:line`): every place that turns a walking guard's look (the pathfinder, `stepTo`,
   `faceYaw`, `raiseShield`, `strikeBack`, `mount.ts`), and whether the free look can work on foot as is.
2. Propose the design in one page (the helper, the rule of point 2, the speed) and **wait for Paul's OK**.
3. Implement in small commits, each with tests and docs.
4. Live check on the dev server (a probe like `squad/live-tests/probe-line.ts`): a wall of five guards told to re-form
   8 blocks behind itself while two zombies or a `/bots raid` army attack from the front; report how many hits the
   shields blocked during the walk, before and after.
