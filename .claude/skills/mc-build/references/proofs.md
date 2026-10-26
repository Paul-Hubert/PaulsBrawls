# Proving an enclosure holds, with `walk`

Read when the build contains creatures (a pen, a farm, a prison, a zoo) or must keep them out (a keep, a walled
town, a gate). The proof runs in the build script on every dry run and throws before anything is placed: a design
that leaks is caught at the cheapest moment. `assets/build-template.mjs` has the code.

## The tool

`walk(plan, start, { walker, ground = 0, margin = 2, maxCells })` → `{ cells, out }`

- `cells`: every feet cell (`"x,y,z"`) the walker reaches from `start` (a feet cell, so usually y = 1).
- `out`: the first cell found more than `margin` past the plan's bounding box, i.e. it got away; `null` = contained.
- The world is the plan over flat ground: solid at y ≤ `ground`, air above, except where the plan puts something
  (air or water at y ≤ 0 is a hole or a pool).
- Walkers: `villager` (opens wooden doors only), `zombie` (counts wooden doors as open: it breaks them), `player`
  (doors, fence gates, trapdoors), `small` (1 high, opens nothing: babies, chickens, baby zombies), or your own
  `{ height, opens: /regex/ }`.
- The model is conservative: it jumps 1 block (never onto a fence, wall or fence gate), falls any height, swims (water
  is climbable), climbs ladders, vines and scaffolding. It does **not** model digging, breaking anything but wooden
  doors, teleporting, flying, spiders climbing walls, pistons or water currents.

## The zone pattern

Keep a list of zones while composing: `{ name, start, bounds: [x0, y0, z0, x1, y1, z1] }`, one per place a
creature lives (each cell, each pen, each field, each stall, a yard). Compute `start` and `bounds` through the same
transform as the part (the template's `at()` helper), so they move with it.

For each zone, run `walk` with `villager` and with `small`, and require both:
1. `out` is `null`, and
2. **every reached cell lies inside that zone's own bounds.** A villager that wanders from its cell into the next one,
   or from a field into the yard, has escaped too, even though `out` stays null.

Set the bounds to what a creature may legitimately reach:
- the interior floor cells (y = 1);
- y + 1 where it can stand on a 1-high block (a bed, a workstation, a composter);
- y = 0 cells where the floor is water (a channel);
- doorway or gateway cells up to the closed door or gate. (A yard's proof first failed because its bounds stopped one
  cell short of the fence gates it legitimately reaches.)

Print one line per zone (`ok` / `FAIL`, cells reached, where it got out or strayed) and throw if any fails.

## Keeping creatures out

`walk` returns at the first cell past the plan's box, so a walk that starts outside stops almost at once and proves
nothing. Wrap the plan in a **barrier ring** that is never built (a tall `minecraft:barrier` wall around the plan and
the start), walk from the start outside with `zombie` **and** `small` (baby zombies), then check that no reached cell
falls in any zone. The template does both when `outside` is set. Don't skip `small`: on Babylon, `zombie` from
outside passed while `small` got into the city (the tower-slit row below).

## What usually fails, and the fix

| Symptom | Cause | Fix |
|---|---|---|
| `small` gets out, `villager` does not | a 1 × 1 hole: an arrow slit or open window at y = 2, an open `bronzeAge` window | glass or bars there, slits higher up, or none on that face |
| out over a wall | a 1-high block beside a 2-high wall | walls 3 high, or a roof |
| out via a tower or wall top | a ladder in reach, then the walkway parapet (a 1-high step) and down the outside | the ladder behind an iron door, or no ground access to that tower |
| out through a door | a wooden door | an iron door, its button on the guard side |
| into the next enclosure | a shared door or gap | its own walls; check strays, not only `out` |
| zombie reaches a zone | a wooden door on the way in, a gap, a pool to swim | iron doors or fence gates on the only way in; close the gap |
| `small` from outside reaches a zone, `zombie` does not | `squareTower`'s 1 × 1 arrow slit at y = 2 on a wall tower's outer face: in through it, up the tower's ladder, then off the walkway's open inner edge | fill the tower's whole y = 2 ring with wall except its door (Babylon's `midTower` / `cornerTower`); slits higher up stay |

## Line of sight and panic, for open-air zones

`walk` says nothing about villagers panicking at the sight of hostile mobs (creatures.md). For every zone open to the
sky (a field, a yard, a pen), check the 3-D distance from each hostile statue or live mob to the nearest cell of the
zone at feet level (y = 1 and 2): it must exceed that mob's panic range (pillager 15, evoker 12, vindicator 10,
zombies 8), unless solid blocks stand between them. Closed rooms with glass windows are safe: glass blocks sight.
Print the nearest margin and throw when it is negative.

## Cost

One `resolve` of the plan, then each walk is fast: a 56 000-position build with 34 zones (68 walks plus a zombie
walk over 19 000 cells) proves in about two seconds. Pass the resolved layers to every walk instead of the raw plan.
