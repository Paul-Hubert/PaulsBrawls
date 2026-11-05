# 49 — A shield wall walks facing the enemy (as built)

From the prompt [48](48-squad-shield-walk-prompt.md). Squad only: `squad/src/bots/mount.ts`, `squad/src/api/formation.ts`,
`squad/src/stock/line.mjs`.

## What changed

In `line`, a **guard** (a bot with a shield, spearmen included) walking to its slot, whether to a new formation, a
re-formed one or back after a fight, keeps its look on the line's direction (`line.yaw`, level) with its shield up, from
the first step to the last. A wall re-formed behind itself walks backward behind its shields; moved sideways, it
sidesteps. It never sprints while it does. Before, it faced where it walked and turned its back (and its shield) to
the enemy on a retreat. Owner's decisions (2026-11-05): **always** facing the line, however far the slot; **no sprint**.

Melee bots on the flanks, the reserve and the archers are unchanged (a horse archer still shoots on the move with its
own free rein, docs/41).

## How

- **`freeLook(bot)`** (`mount.ts`): the riders' free rein, without its riding check. It sets `entity.moveYaw`; the
  prismarine-physics patch walks the body along `moveYaw ?? yaw`, and `steer()` (which the patched pathfinder and
  `stepTo` call) turns only `moveYaw` while it is set. On foot, mineflayer's position packets carry the look
  (`entity.yaw`), so the server sees a player strafing or walking backward. Each hold owns `moveYaw`: an earlier
  hold's release leaves a later one alone. `freeRein` is now a `freeLook` whose release turns the look back to the
  heading, on a horse only (unchanged behaviour).
- **`walkFacing(bot, yaw, pitch = 0)`** (`formation.ts`, also a script helper): a `freeLook`, the look turned to `yaw`
  (commander's degrees), and the look put back on any physics tick where something else turned it (a server's
  correction). On foot it sets the bot's pathfinder `movements.allowSprinting` to false until the release (and lets go
  of a held sprint), so a path planned while it is held has no gap that only a sprint jump crosses. Riding, the sprint
  stays (`mount.ts` sets the body's speed to the horse's assuming the pathfinder sprints).
- **`approach(bot, place, { facing })`** holds `walkFacing` from before the first goal (so the path is planned
  without sprinting) until after the goal is cleared, through the direct last step.
- **`line.mjs` `go()`** passes `facing: line.yaw` for the guards. A hit ends the walk (`until`), so `strikeBack` turns
  the guard to its attacker as before; its next walk holds the line's direction again.

## Decisions

- **Speed: walking (4.3 blocks/s), not sprinting, not the blocking speed.** Vanilla only sprints forward, so a
  backward sprint would be a tell. A vanilla client using an item walks at 20 % (about 0.9 blocks/s), but that is a
  client rule the server does not enforce. At that speed an 8-block retreat takes about 9 s instead of about 2 s,
  under arrows the whole time.
- **Always facing, however far** (owner): no crab-walk threshold. Facing does not change the walk itself (below), so a
  long facing walk costs nothing but looks.
- **Turning:** mineflayer turns the look in one tick, the shortest way. A guard whose look is far from `line.yaw`
  turns once at the start of the walk; the exposure is one tick. The shield is raised before the first step (its
  0.25 s delay below).
- **No fallback to facing the way.** The prompt asked for one for a step the guard could not take facing. There is no
  such step: the pathfinder's look-ahead (`lib/physics.js` `getController`) simulates with its own yaw (the direction of
  travel), so its sprint, jump, sprint-jump and parkour decisions do not read the look; the real body walks along
  `moveYaw`, which the pathfinder steers; climbing and swimming read collisions and water, not the look; the stuck
  check counts ticks (70) without the look. A guard that cannot reach its slot is caught by `go()`'s existing
  `STUCK_MS` loose hold, as before.

## What a 26.1.2 shield blocks (read from the server jar's bytecode)

`LivingEntity` takes the angle between the defender's head yaw (`yHeadRot`, horizontal, pitch ignored) and the
horizontal direction to the damage's source position (the attacker, or the arrow), with `Math.acos` of their dot
product. `BlocksAttacks$DamageReduction.resolve` reduces nothing when that angle is over `horizontal_blocking_angle`
(90° by default; the shield item's own component values were not read). Also: no block until the item has been
used for `block_delay_seconds` (0.25 s for a shield, 5 ticks); `bypassedBy` damage types and piercing arrows go
through. A player's head yaw is the yaw of its move packets, so a guard walking backward while facing `line.yaw`
blocks what comes from the front.

## Tests (fakes)

- `tests/mount.test.ts`: a free look on foot: `steer` turns only the walk, the release leaves the look, holds own
  `moveYaw`. The riders' free-rein test is unchanged and passes.
- `tests/approach.test.ts`: `approach` with `facing` to a place 8 blocks behind: the look is the facing on every tick,
  never a sprint, on the place, the hold released, sprinting allowed again; `walkFacing` puts back a turned look, and a
  rider keeps its sprint.
- `tests/item-orders.test.ts`: a wall re-formed 8 blocks behind itself walks there backward, facing west with its
  shields up on every walked tick, never sprinting (it fails without the change). The fake bot's physics walks along
  `moveYaw ?? yaw`, as the patch does. Older `line (guards)` tests used "facing the yaw" as the sign a guard had
  arrived; they now wait for the exact places.

No patch was touched.

## Not checked live

The live check of the prompt (five guards re-forming 8 blocks back under two zombies or a `/bots raid`, counting the
shields' blocks before and after) has not been run. Also unchecked in game: that the 26.1.2 server accepts a
backward walk at walking speed with a shield up without a correction, a facing walk through a door or up a ladder,
and the shield component's own angle and delay values.
