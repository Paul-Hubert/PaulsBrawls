# 47 — Horse archers circle their target in `attack`

Prompt: [docs/46](46-squad-horse-archer-circle-prompt.md). As built, 2026-11-05: the aim fix (§1), the orbit
(`squad/src/api/orbit.ts`, §2), what it was measured to do (§3), the General (§4), what was not checked (§5).

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

**Not checked:** hits per arrow from a running horse live (the live probe, §3, counts shots and damage dealt, not
hits; `live-tests/range.ts` measures from foot);
1.21.1's `getMovement` for a rider (the seat lag is the same code there, the movement source is not read); the
rider's server-side `onGround` (stale while riding: the y of the horse's move may or may not be added, which matters
only on slopes and jumps).

## 2. The orbit (`squad/src/api/orbit.ts`)

`attack.mjs` gives its riders with a bow (`canOrbit`: `isRiding` and a bow) to one `orbitRing`, as it gives its
lancers to `lanceWaves`: each look (200 ms) it calls `ring.step(riders, centre)` with the attacked group's centre (its
foes' mean; else where the target is or was; on the ground, the point), and `ring.stop()` in a `finally`. The archer
loop shoots as before: `shoot` finds the rein held (the ring holds a free rein the whole time) and the horse goes on
turning while the rider aims. New arg `orbit` (0 = off: the riders shoot as foot archers do, with `approach`;
16–48, default 30). The geometry and the per-look decisions are pure exported functions; the ring applies them.

**The radius, 30:** out of a charge's reach (the group's 8 + a lance's run-out 12 + 4 = 24 at
least), within the aim's good band (flight 10.6 ticks at 30; a target that changes course at 4 b/s strays ~2 blocks
off the lead at 30, ~3.7 at 50). `approach` does not apply to riders: it stays the foot archers' stopping distance.
A rider shoots at a foe within the radius + 12 (farther: still riding in). A target is « down » when it vanishes
within the radius + 12 of a bot (it was 24: an orbiting ring at 30 saw every kill as « lost from sight »).

**The steering** (`orbitHeading`, every physics tick, through `steer`): the tangent, turned toward the centre by the
smaller of the tangent point's angle (joining from far off, the rider rides at the point where its way meets the
circle, never at the enemy) and 60° × (r − R) / 8; inside the circle, out by up to 60°. Followed tick by tick from 80
out it joins without cutting inside and holds within half a block (test).

**Several riders:** all the same way round (the angle rising); spaced by lanes (`orbitLanes`): a rider less than half
an even share behind the one ahead takes the outer lane (R + 4, slower round), one more than one and a half shares
behind the inner lane (R − 4). Three riders started together spread out (test).

**Jinks:** the gallop let go for 3–5 ticks every 20–40 ticks at random, never so that a pulse ends after tick 15 of the
rider's own draw (`jinkMayStart`): the aim's last answers (ticks 21–23) read a steady motion, and the body's
inertia (0.546 a tick) has recovered by then. Not while breaking away or withdrawing.

**Terrain:** each look, the ground 4 and 8 blocks ahead along the heading is read in the bot's world (`groundAt`, one
step up, three down; water or lava at the feet or under them counts as blocked; an unknown block is not judged).
Blocked: the rider's lane shifts ± 6 (out first), back to its lane after 3 s of clear ground; both blocked: that rider
turns back (not more often than every 2 s). Stuck (under 0.5 blocks in 1.2 s while galloping): it turns back.

**Threats** (`orbitMode`, each look):
- an enemy (hostile mob or enemy player, `foesNear`) within 12, or one closing faster than 7 b/s within 32 (the
  closing speed from its positions 150 ms+ apart): break away from it, straight out, until 24 from it (4 s at most);
- hit by an arrow (`hurtBy` kind `arrow`, `from`): for 15 s an arc of ±60° on the far side of the group's centre from
  the shooter (`arcTurn`: back at the ends; outside it, toward it the short way);
- under 40 % health: withdraw straight away from the centre to 64 and hold there, not shooting (`canShoot` false);
  back at 70 %. The order goes on; the squad-level retreat is the standing order's (`hp < 50 → line @back 32`).

**Shooting:** a rider's first choice is a foe within 16 of it (not one its shots are blocked at), then the group as
for every archer; a refused shot marks the foe blocked for 5 s and the rider rides on (no sidestep, no close-in).

**Ending:** as `attack` ends; the tally adds « N tours à cheval ». `abortActiveTasks` now also deletes a held
`moveYaw` (a rein an ended order left).

## 3. Measured

**Jinks against an aim like ours** (`tests/orbit.test.ts` « jinks »: the enemy aims as our solver does, the rider's
velocity a least-squares fit of its last 16 ticks, led 4 ticks then along the flight, the bow's spread; a rider at
30 round the centre at 10 b/s; 130 shots each):

| enemy archer at | steady circle | jinking |
|---|---|---|
| the centre | 100 % hit | 37 % |
| 8 off the centre | 100 % | 41 % |

A steady circle round an archer is no harder to hit than a parked rider (its curvature is along the line of fire);
jinking costs 1.2 b/s (8.8 b/s mean).

**The General's benchmark** (`tests/general-bench.test.ts`, 3 seeds summed; `battle.ts` now moves a horse archer in
`attack` round the group at 7 b/s, away from enemy melee within 12, and multiplies the enemy arrows' hit chance on it
by 0.4, from the row above):

| doctrine | kills | losses | per loss |
|---|---|---|---|
| before (one line, no standing orders), unchanged | 33 | 60 | 0.55 |
| after (standing orders + wall at bow range), unchanged | 55 | 39 | 1.41 |
| after + horse archers `attack` the enemy line, circling | 60 | 38 | **1.58** |
| the same, `orbit=0` (standing at `approach` 40) | 43 | 57 | 0.75 |
| the same, `raid` | 38 | 58 | 0.66 |

The first two do not change: in them the horse archers stay in the line (their `contact 64` rule never fires there).

**Live** (`live-tests/probe-orbit.ts`, dev server 26.1.2, 2026-11-05): five horse archers (horse speed 0.225) `attack`
4 husks + 3 skeletons with 200 hp each, at night on a stone floor, 45 s per pass from 45 blocks south:

| pass | radius round the group (median, 10–90 %) | shots | per rider per min | damage dealt | damage taken |
|---|---|---|---|---|---|
| orbit (default) | 32.0 (22.7–42.9) | 123 | 32.8 | 531 | riders 2, horses 0 |
| `orbit=0 approach=40` (before) | 27.8 (22.8–32.1) | 94 | 25.1 | 507 | riders 88 (4 of 5 died), horses 0 |

The radius' spread is the lanes (± 4) and the break-aways from husks that walk out at the riders.

## 4. The General

- Default standing orders of `horsearcher`: `contact 64 → attack trigger`, `ended → attack nearest` (were `raid`),
  `hp < 50 → line @back 32` unchanged (`squad/src/general/standing.ts`).
- The briefing's `attack` line names the circle and `orbit`; `approach` is for foot archers.
- `attack` with `approach=0` refuses a target past 80 blocks only for foot archers (and horse archers with `orbit=0`):
  circling riders reach any target.
- `squad/agent/general/CLAUDE.md`: the horse archer paragraph, the defaults, the kit table.

## 5. Not checked

- Hits per arrow live (the probe reads damage dealt, not hits); enemy players' or bots' arrows at an orbiting rider
  live (the skeletons barely reached the ring; the jink figures are from the model in §3).
- A wall, water or a cliff on a real orbit (the terrain rules are tested on fakes only).
- 1.21.1 (§1); the rider's server-side `onGround` on slopes (§1).
- An arc after an arrow hit and the withdrawal at 40 %, live.
