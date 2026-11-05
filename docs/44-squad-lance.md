# 44 — Lance charges and group targets in `attack` (as built, 2026-11-05)

Paul: « horsemen with spears aren't capable of hitting targets, because they miss range. Their attack order should
start a charge in the last formation with extended spear for speed damage, then back off a certain distance and
charge again. Attack doesn't simply attack one specific bot but the bots around the selected bot/position ».

## 1. Why horsemen missed

A 26.x spear is not a sword. Its `attack_range` component reaches 2–4.5 blocks from the eyes: a target **nearer than
2 blocks is not hit**. `attack()` (mineflayer-pvp) closes in to about 2 blocks and swings from there, so a horseman
with a spear mostly swung at a foe inside its minimum reach. The spear's real blow is its **charge**
(`kinetic_weapon`): while the holder keeps using it (right button held), the server hits, each tick, the creatures
within that range along the holder's look, harder the faster the two move relative to each other.

## 2. The lance (`squad/src/api/lance.ts`, scope globals)

- `canLance(bot)`: it rides a horse (mount.ts `isRiding`) and has an item named `*_spear`. On 1.21.1 the kits give an
  iron sword instead (no spears): no lance there, the horseman fights as before.
- `lance(bot, through, { foe, until, timeoutMs })`: one pass. The spear goes to the hand, its use is held
  (`activateItem`), the pathfinder's goal is cleared and the bot rides at full speed (forward + sprint, a jump when it
  collides) toward `through`, a point beyond its foes. It holds a **free rein** (mount.ts `freeRein`, the "Archer
  movement" session's API): the horse keeps its heading (`steer`), the rider's look is free. While `foe()` is ahead
  (within 60° of the way) the look is on the foe's body (a pitch down from the saddle), and the heading onto it until
  it is within 1.5 blocks; then straight on to `through`. Ends there (`passed`), on `until()`, when stuck (under 0.5
  blocks in 1.2 s) or after `timeoutMs` (8 s); always lets go of the use, the controls and the rein. `struck` counts
  the creatures seen hurt (`entityHurt`) within reach during the pass.
- `foesNear(bot, range, { from, filter })`: every hostile mob or enemy player within range, nearest first.
- `lanceWaves({ backoff, ground, view })`: the waves of §3 as one planner (it moved out of `attack.mjs`, which had
  grown past the 400-line limit of a command). `step(riders, foes)` every look of the order runs the phases (idle,
  form, charge); `ride(bot, { foe, until, log })` in each rider's loop is its pass (`lance`), else its ride to its
  place: `'charged' | 'forming' | 'waiting' | 'idle'`; `reset()` for a new target; `passes`, `struck` for the tally.

## 3. `attack` (`squad/src/stock/attack.mjs`)

- **A group, not one bot.** Pointing at a creature attacks it **and every threat within `group` (default 8) of it**.
  Each bot takes a foe of the group nobody is on (the pointed one first), else one with room (melee: 2 per foe).
  The order ends once the pointed one is gone and nothing is left within `group` of where it was last seen (1.5 s
  clear); `group=0` is the old single-target attack. On the ground the point's `radius` was already a group.
- **Horsemen charge in waves.** Melee bots that `canLance` do not fight with `melee`:
  1. **The formation.** At the first wave each rider's place in the formation it stands in (across the axis to the
     group: `lat`; behind the front rank: `rear`, in ranks of 2.5) is kept for the whole order, at least 2 blocks
     apart across. A rider that joins later goes on the front rank's end.
  2. **Charge.** If every rider is within `backoff` + 20 of the group, the first charge starts from where they
     stand; else they first form up `backoff` short of it. All charge together; each rides at the group's foe nearest
     its lane (spread: a foe already taken counts 3 blocks off), through it to `backoff` (default 12) beyond.
  3. **Form up** on the far side: the shape again, facing back at the group (`assignSlots`, so no paths cross), until
     every rider is within 2.5 of its place or 8 s; then the next charge, back through the group.
  Until the group is gone (or `seconds`). On the ground with nothing near the point they hold the ring of 3 like
  other melee bots. The end text counts the charges and the hits seen.
- New args: `group` (0–32, 8), `backoff` (6–32, 12). The General's briefing and the squad-author prompts name them.

## 4. Tests

`squad/tests/lance.test.ts`: a pass on a FakeBot rider (spear equipped before the use, the look below level at the
zombie's body, a hit counted, the use and the rein let go at the run-out point), a stuck pass, `canLance` on foot or
with a sword, `foesNear`, and `attack` with two riders side by side: through the group and out, formed up beyond,
back through, still apart, the order ending once the group is down, a zombie outside the group untouched.
`item-orders.test.ts`: the order no longer ends while the target's neighbour stands; two archers spread over a group
and leave a zombie beyond `group` alone.

## 5. Not checked live

Nothing here ran against a server. Open: the spears' real numbers in 26.1.2 (range, the use's delay before the charge
counts, how long it lasts, the minimum speeds for damage, knockback and dismount); whether the server's speed for a
horse moved by `vehicle_move` (mount.ts) is what the charge's damage reads; a charge through a crowd (the horse is
pushed, `stuck` ends the pass); uneven ground on the run-out (only a jump on collision). Spearmen on foot still fight
with `melee` and have the same minimum-reach problem.
