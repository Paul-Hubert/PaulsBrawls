# Prompt: horse archers circle their target in `attack` (shoot from a safe orbit)

You are working in the pauls-brawls repo, on the Squad runtime (`squad/`). Read first: docs/41 (horses: how a riding
bot moves, `steer` and `freeRein` in `squad/src/bots/mount.ts`), docs/44 (the lance waves: how `attack` already gives
horsemen their own movement through a helper in `squad/src/api/lance.ts`), docs/45 (the General reform: `attack`'s
`approach`, the standing orders, the benchmark), docs/40 §4 (`attack`), and `squad/src/stock/attack.mjs`,
`squad/src/api/helpers.ts` `shoot`, `squad/src/aim/`. Work only in `squad/` and `docs/`; run `npm run check` in
`squad/` before you finish. Report in one short message per step.

## What Paul wants

In `attack`, a **horse archer** (a bot with a bow riding a horse: `isRiding(bot)` and a bow, kit `horsearcher`)
should **circle its target**: ride round it on a wide orbit, at a radius where its bow is still accurate, shooting on
the move, and keep out of reach of what can hurt it. Not stand still, not close to melee range, not ride into the
enemy's arrows.

## What is there today (check it, cite `path:line` in your notes)

- `attack.mjs` archers shoot from where they stand; with `approach` > 0 (the General's default 40) they walk or ride
  toward the foe until within `approach`, then **stop** (the closing-in goal is cleared before a shot). A horse archer
  in `attack` therefore ends up parked at ~32–40 blocks from its foe: a still target for the enemy's archers.
- `shoot` already holds a **free rein** (`freeRein`): the horse keeps the heading `steer` gave it while the rider aims
  and draws (24 ticks). `line` uses it so horse archers shoot while riding to their slot (`rideAndShoot`). Nothing
  steers a horse round a point yet.
- The lance waves are the model to follow: a planner in `src/api/` (`lanceWaves`), called by `attack.mjs` for the
  riders that qualify (`canLance`); `attack.mjs` is at 378 lines and a command may not pass 400, so the new movement
  must live in a helper in `src/api/` (and its type in `squad/reference/squad.d.ts`, its line in the squad-author
  prompts, like `lance`).
- The General's standing order for horse archers is `contact 64 → raid trigger`; its doctrine (`squad/agent/general/
  CLAUDE.md`) tells it to keep them beyond the range the `under-fire` events report. The benchmark
  (`tests/fakes/battle.ts`) models horse archers as archers that close to `approach` and stop.

## The behaviour to design (decide and justify each point)

1. **Who circles:** riders with a bow in `attack` (target or ground mode). On foot, archers keep today's behaviour.
   A new arg to turn it off (e.g. `orbit=0`), default on for riders.
2. **The orbit radius.** Wide enough to be safe, close enough to hit:
   - the inner bound: out of melee reach and out of a charge's easy reach (a horseman's lance waves start 12–32 out:
     `backoff`), and beyond the enemy archers' effective range when they are archers;
   - the outer bound: where the aim still hits a moving target from a moving horse. The aim (`squad/src/aim/`) leads
     the *target*'s velocity; **check whether it accounts for the shooter's own motion** (a Minecraft arrow inherits
     the shooter's velocity, and a rider moves 8–14 b/s sideways to the line of fire). If it does not, that is the
     first fix, with a test, before any orbit; say what the error was in blocks at 30 and 50 blocks.
   - Propose a default (e.g. 28–36) and an arg `orbit` to set it; let the General's `approach` mean the same distance
     for riders, or say why not. Measure what you can (the aim's own tests; `live-tests/range.ts` is the live
     measurement harness) and write the numbers down.
3. **The ride.** A circle (or a racetrack/ellipse) round the target's group centre, not its one member: steer each
   tick along the tangent, corrected toward the radius (a spiral in when too far, out when too close). Several riders
   spread round the circle (phase offsets), all in the same direction, so they do not collide or bunch into one
   target. The horse turns through `steer` with a free rein while the rider aims; between shots it keeps riding.
   Terrain: a wall, water or a cliff on the orbit (the pathfinder is not in charge here, so say how the rider avoids
   them: probe the ground ahead with the shared world, reverse direction, or shrink/grow the radius); stuck detection
   as `lance` does (under 0.5 blocks in 1.2 s).
4. **Staying away from attacks.** Read the threats each look: an enemy (player or bot) within the inner bound, or
   closing on the rider faster than X b/s, pushes the orbit out or makes the rider break away and come back; an
   enemy archer that hit the rider (`hurtBy` in `src/bots/hits.ts`, kind `arrow`, `from`) moves the orbit beyond that
   archer's distance, or onto the far side of the target from it. Low health (say < 40 %): leave the orbit to the side
   away from the threats, out to a safe distance, then return (or end, and let the General's standing orders decide;
   say which and why).
5. **Shooting.** Pick foes as `attack` does (the pointed one first, then the group, `targets()` load and `block`);
   shoot only when the line of fire is clear (`shoot` refuses and the rider rides on, the foe marked blocked for a
   while); prefer the foe that threatens the rider most when one is close.
6. **Ending:** as `attack` ends today (the group down, or `seconds`); the circling stops with it.

## Rules

- One helper in `squad/src/api/` (`orbit` or `circleShoot`, your name), pure where it can be (the geometry, the
  steering decision per tick, the threat check) so the tests drive it with plain objects; `attack.mjs` stays under
  400 lines and only calls it for the riders that qualify, as it calls `lanceWaves`.
- Behaviour and docs change in the same commit; tests for every rule (fakes: `tests/fakes/fake-bot.ts` riding bots,
  `tests/mount.test.ts`, `tests/lance.test.ts` as models). No new machinery without a second consumer.
- The General: update its briefing line for `attack`, the horse archers' default standing orders if the orbit makes
  `attack` a better default than `raid` for them, and `squad/agent/general/CLAUDE.md`'s horse archer paragraph. Update
  `tests/fakes/battle.ts` so a horse archer in `attack` orbits (and is shot at while it does), and record the
  benchmark's numbers before and after in the doc (keep the bench's assertions true).
- Docs: a new `docs/47-squad-horse-archer-orbit.md` (as built: the radius and why, the steering, the threats, the
  numbers measured, what was not checked live), and a line in docs/41 and docs/44's neighbours where `attack` is
  described (docs/40 §4, `squad/README.md`).

## Method

1. Audit the aim with a moving shooter (point 2): a short note with `path:line`, and the fix with its test if needed.
2. Propose the orbit's design in one page (radius rule, steering, threat rules, ending) and **wait for Paul's OK**.
3. Implement in small commits, each with tests and docs.
4. Live check on the dev server (`squad/live-tests/`, a probe like `probe-horse.ts`): five horse archers `attack` a
   stationary group of zombies or a `/bots raid` army; report the orbit radius held, shots per minute, hits, and
   damage taken, against the same five with today's `attack approach=40`.
