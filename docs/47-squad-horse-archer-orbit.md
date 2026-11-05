# 47 — Horse archers circle their target in `attack`

Prompt: [docs/46](46-squad-horse-archer-circle-prompt.md). Status: §1 built (the aim fix), §2 **proposed, awaiting
Paul's OK**; nothing of the orbit is built yet.

## 1. The aim from a moving horse (audit, 2026-11-05)

**The solver already accounts for the shooter's own motion.** `solveAim` adds the shooter's velocity to the arrow
(`squad/src/aim/solve.mjs:62-64`, `launch` in `squad/src/aim/arrow.mjs:77-87` aims against the sideways part, the
checked flight adds it again at `solve.mjs:347-349`). `drawShot` measures it as the body's move per physics tick
(`squad/src/aim/draw.ts:464-471`) and starts the arrow where the body will be at the release
(`draw.ts`, `input()`: `from = p + selfVel × toRelease`). A ridden horse moves the body (`squad/src/bots/mount.ts:146-165`
sends the body's position as the horse's `vehicle_move` every tick), so `selfVel` is the horse's move.

**What the 26.1.2 server does** (javap of the unobfuscated `minecraft-common.jar`, Loom's cache):

- `Projectile.shootFromRotation` adds `shooter.getKnownMovement()` (y dropped when the shooter is on the ground).
- `ServerPlayer.getKnownMovement()`: for a player that steers its vehicle, `lastKnownClientMovement`;
  `ServerGamePacketListenerImpl.handleMoveVehicle` sets it to the horse's move (its position after the packet minus
  before). It is reset to 0 only by `handleClientTickEnd` in a tick with no move, and mineflayer sends no
  `client_tick_end`, so it stays the last `vehicle_move`'s delta. This matches `selfVel`.
- **The rider is seated on its horse only in the server's tick** (`Entity.rideTick` → `positionRider`; nothing in
  `handleMoveVehicle` moves the passenger). The bow's release arrives right after that tick's `vehicle_move`, so the
  arrow starts where the last server tick seated the rider: **one tick of the ride behind the body**. On foot there is
  no such lag (`handleMovePlayer` moves the player itself).

**The fix** (`draw.ts` `input()`): a riding shooter's start is extrapolated to one tick before the release. Tests in
`squad/tests/aim.test.ts`: « draw: a moving shooter … a rider's a tick behind its body » (on foot: the release
position; riding: a tick behind; the movement carried), and « solver: a horse archer riding across the line … ».

**The numbers** (the solver against a per-tick flight, a zombie, the rider crossing the line of fire):

| | 30 blocks | 50 blocks |
|---|---|---|
| flight | 10.6 ticks | 18.6 ticks |
| own motion ignored, 8 b/s | 4.0 blocks off | 6.7 |
| own motion ignored, 14 b/s | 7.0 | 11.8 |
| start one tick off (the bug fixed), 10 b/s | 0.5 | 0.5 |
| velocity read 2 ticks stale on a circle round the target | < 0.01 | < 0.01 |
| bow spread (±0.5°, σ per axis 0.00703 rad) | σ 0.21 | σ 0.35 |

A zombie's hit box with the arrow's margin is ±0.6 wide. Model estimate (lateral only): centred, 99 % at 30 and 91 % at
50; 0.5 off (the fixed bug at 10 b/s), 68 % and 61 %; 0.7 off (14 b/s), 32 % and 39 %. A stale velocity on the orbit
costs nothing: on a circle round the target, the turn is toward the target, along the line of fire.

**Not checked:** live (no shot from a running horse has been measured; `live-tests/range.ts` measures from foot);
1.21.1's `getMovement` for a rider (the seat lag is the same code there, the movement source is not read); the
rider's server-side `onGround` (stale while riding: the y of the horse's move may or may not be added, which matters
only on slopes and jumps).

## 2. The orbit (proposed)

A helper `orbit(bot, opts)` in `squad/src/api/orbit.ts` (type in `squad/reference/squad.d.ts`, a line in the
squad-author prompts), called by `attack.mjs` for archers that ride (`isRiding` and a bow), as it calls `lanceWaves`
for lancers. The geometry, the per-tick steering decision and the threat check are pure functions; a physics-tick
ticker applies them (forward held, `steer` for the heading), so the archer loop keeps calling `shoot` unchanged and
the horse keeps turning under its free rein during the draw.

**Who:** riders with a bow in `attack`, target or ground mode. New arg `orbit` (0 = today's behaviour, else the
radius, 16–48, default 30). On foot nothing changes.

**The radius: 30 by default.**
- Inner bound 24: the attacked group's radius (`group`, 8) + a lancer's run-out (`backoff`, 12) + 4. Foot melee
  (≤ 5.6 b/s sprinting) cannot catch a 10 b/s rider anyway; the threat rules handle mounted ones.
- Outer bound ~36: flight time, not spread, limits it. At 30 the arrow flies 0.53 s; a target that changes course at
  4 b/s moves up to ~2 blocks off the lead; at 50 (0.93 s), ~3.7. The spread costs little up to 40 (σ ≤ 0.28).
- **Not the General's `approach`:** `approach` stays the foot archers' stopping distance (40 by the General's
  default, past the accurate band for a rider). A rider orbits at `orbit` whatever `approach` says; one knob per kind
  of archer, and the General's briefing names both.
- **Outrunning enemy bows is not possible** (the same bow, the same aim). The protection is motion: see "jinking".

**The ride.**
- Centre: the attacked group's centre (`zoneOf`), recomputed each look; ground mode: the point.
- Joining: farther than R + 16, the rider heads for the tangent point of the circle (it merges into the orbit
  instead of riding at the enemy); within, heading = the tangent rotated toward the centre by
  α = clamp((r − R) / 8, −1, 1) × 60° (a spiral in when wide, out when close).
- Several riders: one direction for all (counter-clockwise seen from above), evenly spaced. Spacing by lane, not by
  speed (the horse has one speed): a rider within half a slot of the one ahead takes the outer lane (R + 4, slower in
  angle) until the gap opens; one more than half a slot behind takes the inner lane (R − 4).
- **Jinking:** enemy archers lead a target linearly (as ours do, a velocity smoothed over 0.8 s). A steady circle
  round an archer at the centre is predictable (its curvature is along their line of fire). So the rider varies its
  pace and lane at random intervals, but never in the last 6 ticks before its own release (its own aim extrapolates
  its motion). The benefit will be measured with our solver as the enemy (a test), before it is kept.
- Terrain, probed in the shared world 4 and 8 blocks ahead each look: a step up of more than 1, a drop of more
  than 3, water, lava or a wall → the lane moves (R ± 6, within the band); both lanes blocked → this rider reverses
  alone and keeps a phase gap. Stuck as `lance` judges it (under 0.5 blocks in 1.2 s) → reverse.

**Threats** (each look, 200 ms):
- An enemy creature within 12 blocks of the rider, or one closing on it faster than 7 b/s (faster than any player on
  foot: a horseman) within 32 → break away: ride straight away from it until 24 out, then rejoin.
- Hit by an arrow (`hurtBy`, kind `arrow`, `from`): for 15 s the orbit becomes an arc of ±60° on the far side of the
  centre from `from`, the rider turning back at its ends.
- Below 40 % health: leave the orbit away from the threats' centre, out to 64 blocks from the group, and hold there,
  not shooting; rejoin at 70 % (auto-eat heals) or end with the order. Not ending the bot's part: one wounded rider
  should not end the squad's order, and the squad-level retreat is the standing order's job (`hp < 50 → line
  @back 32`).

**Shooting:** unchanged: the pointed foe first, then the group (`targets()` load, `block`); a refused shot marks the
foe blocked 5 s and the rider rides on (no sidestep, no close-in). One change: a foe within 16 of the rider comes first.

**Ending:** as `attack` ends; `stop()` releases forward and the rein. The tally adds the orbit's laps.

**The General, the bench, the docs** (after the code): the briefing line for `attack` names `orbit`; the horse
archers' default `contact 64 → raid` becomes `→ attack` if the bench says so; `squad/agent/general/CLAUDE.md`'s horse
archer paragraph; `tests/fakes/battle.ts` puts an attacking horse archer on its circle at 7 b/s, shot at with a hit
chance scaled by what the jinking test measured; its before/after numbers here. Then docs/40 §4, docs/41,
`squad/README.md`.

**Live check** (method step 4): five horse archers `attack` a stationary zombie group on `dev-26.1.2`, orbit vs
`approach=40`: the radius held, shots per minute, hits, damage taken.
