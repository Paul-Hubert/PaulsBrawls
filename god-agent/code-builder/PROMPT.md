# Prompt: build in Minecraft by writing code

> For **your own interactive Claude Code session** on the server machine, with a `/construction ticket`. Paste
> everything below the line, then add your request at the end. Do not give this to the `/build` agent the mod
> starts: any player can type `/build`, and an agent that can run code would then run their text on this PC.
>
> Before pasting: in game, look at the pivot block, `/construction`, then `/construction ticket 60` and click
> the ticket to copy it. Start Claude Code in `god-agent/code-builder/` of the repo, and set:
> ```powershell
> $env:PAULSBRAWLS_MCP_TOKEN = "<mcpToken from PaulsBrawlsVanilla\god_agent.properties>"
> $env:PAULSBRAWLS_TICKET   = "bld-…"
> claude --model claude-opus-5-5 --effort high
> ```

---

You build structures in a running Minecraft 1.21.1 server by **writing and running Node.js scripts** that use
the component library in `lib/`. The server's mod exposes a `builder` MCP server; `mcp-build.mjs` is its client
and `lib/build.mjs` drives it. Reuse before you write: most structures are library components with parameters.

## The connection

- `PAULSBRAWLS_MCP_TOKEN` and `PAULSBRAWLS_TICKET` are already in your environment. Never print them, never
  write them to a file.
- First run `node mcp-build.mjs`. It must print `OK, ticket valid. Pivot (absolute): …`. If it fails, stop and
  tell me the error: "Ticket … inconnu ou expiré" means I need a new ticket, HTTP 401 a wrong token,
  "connection refused" a stopped server.
- Reach the server only through `mcp-build.mjs` / `lib/build.mjs`. No other network calls, no RCON, no `/`
  commands, and do not touch any file outside this directory.
- Server rules (the server enforces them; a refusal is a French `McpError` message, read it and fix the
  script): 128 blocks per call, **at most 4 sub-builds open on the whole server**, anchors within ±256 of the
  pivot, a sub-build idle for 2 minutes is closed. A placed block replaces what is there, air included.
  Creatures (`spawn_mobs`, this ticket only, never a `/build` one): 16 per call, 128 per sub-build, mobs only, no
  Wither or Ender Dragon. `node mcp-build.mjs` says whether the running mod has `spawn_mobs`.

## The library (`lib/index.mjs` re-exports everything)

Points are `[x, y, z]` offsets; X east+, Y up+, Z south+. A **plan** is `[{ block, points }]` in placement order;
later layers win where they overlap (an `air` layer after a wall cuts the opening).

- **Geometry** (`geom.mjs`, points only): `line(a, b)`, `polyline(pts)`, `box(a, b)`, `hollowBox`, `walls` (sides
  only), `frame` (edges), `rectRing(x0, z0, x1, z1, y)`, `disc(cx, y, cz, r)`, `ring(cx, y, cz, r, t)`,
  `cylinder(cx, cz, r, y0, y1, { hollow })`, `sphere(c, r)`, `sphereShell(c, r, t)`, `dome(c, r)`,
  `archOpening(w, h)` / `archRing(w, h, t)` (2D cells) + `extrude(cells, axis, depth)`,
  `spiralSquare(cx, cz, half, y0, y1)` / `helix(...)`, `gableRoof({ x0, z0, x1, z1, base, ridge, overhang })`,
  `hipRoof(...)`, `coneRoof(cx, cz, r, base)` (roofs return `{ slope: [{ p, dir }], ridge, … }`, `dir` = the
  stair's facing), `bbox`, `uniq`, `subtract`.
- **Blockstates** (`blockstate.mjs`): `withProps(id, { facing, half, axis… })`, `rotateBlock(b, turns)`,
  `mirrorBlock(b, 'x'|'z')`, `rotateDir`, `dirStep`. Turns are clockwise seen from above (north → east).
- **Plans** (`plan.mjs`): `layer(block, points)`, `concat(...plans)`, `translate`, `rotate(plan, turns)`,
  `mirror(plan, axis)`, `placeAt(plan, { at, turns, mirror })`, `swapBlocks(plan, { from: to })`, `stats(plan)`.
  Rotating or mirroring a plan fixes every blockstate (stair facing and shape, log axis, door hinge, fence sides).
  `resolve` (used by build) keeps the last block per position, computes stair corner shapes and fence/wall
  connections from the final layout, and orders passes: air, structure (bottom-up), attachments last.
  Creatures are kept apart from blocks: `spawns(entity, points, { nbt, persistent })` makes a group (a point is
  the block the feet stand in), `placeSpawns(groups, { at, turns, mirror })` moves groups like `placeAt`.
- **Palettes** (`palettes.mjs`): presets `stoneCastle`, `oakCottage`, `sandstone`, `deepslate`, `bronzeAge` (mud
  brick, open windows: its `glass` is air); roles `wall trim
  floor accent pillar roof roofStairs roofSlab glass light door fence path bars stairs`.
  `palette('oakCottage', { roof: 'minecraft:bricks' })`. An unknown role throws.
- **Components** (`components.mjs`), every option defaulted, `palette` = a preset name or a palette:
  - `tower({ radius, height, roof: 'flat'|'cone'|'dome'|'none', crenellations, overhang, stairs: 'auto'|'spiral'|'ladder'|'none', openings: [{ side, y, height, width, door }], landings: [y], windowSides, windowEvery, lights })` — centred on (0,0,0).
  - `squareTower({ w, d, height, storey, floors: [y], ladder: side|null, openings: [{ side, y, height, width, door, at }], slits, crenellations, overhang, lights })` — footprint x 0..w-1, z 0..d-1; hollow storeys, 1 × 1 arrow slits, a ladder through every floor.
  - `wall({ from: [x, z], to: [x, z], y, height, thickness, walkway, crenellations: 'both'|'outer'|'none', outer, overhang, lights })` — axis-aligned.
  - `gatehouse({ width (odd), height, depth, sideWidth, upperFloor, bodyHeight, sideDoors, turrets, portcullis })` — passage along Z centred on x = 0, front at z = 0.
  - `house({ w, d, floors, floorHeight, roof: 'gable'|'hip'|'flat', door: side, furnish })` — footprint x 0..w-1, z 0..d-1.
  - `earthworks({ x0, z0, x1, z1, glacisHeight, glacisRun, berm, moatWidth, moatDepth, clear: [[x0, z0, x1, z1]], glacis, water })` — glacis, berm and moat around a wall ring's outer faces.
  - `bridge({ length, width, rise, railings, lights, pierDepth })` — along +X, centred on z = 0.
  - `stairsBetween(a, b, { width, block, landing, fill })` — a straight flight, either end higher.
  - `castle({ size, towerRadius, towerHeight, towerRoof, wallHeight, wallThickness, gate: {…} })` — composes all of the above.
  - `cellBlock({ cells, rows: 1|2, cellW, cellD, height, corridor, bed, door, button, window, catwalk, entrances: ['west'|'east'], entranceButtons })` — locked cells along a corridor (x along it): a bed, an iron door, its button on the corridor side only, a glass window; a guards' catwalk storey over it. `cellBlockLayout(opts)` gives each cell's interior, door, spawn and back cell (a job site goes there: `bed: null, catwalk: false` makes workshop stalls).
  - `door(id, [x, y, z], facing)` — both halves.
- **Build** (`build.mjs`): `await build(plan, { label, anchor: [ax, ay, az], live, yes, parallel })` dry-runs by
  default (counts per material, bounding box, nothing placed); `live: true` places. It dedupes, sends 128 per
  call, runs air + structure in up to `parallel` sub-builds (by region), then attachments in one more, ends
  every sub-build in `finally`, retries for 10 min while the 4 slots are busy, refuses over 5 000 positions
  without `yes`, and prints the server-confirmed count. `cliOptions()` reads `--build --yes --anchor=x,y,z
  --parallel=N --key=value`. `sliceMap(plan, y)` prints an ASCII top view of one level. `build(plan, { spawns })`
  spawns the groups once every block stands (128 per sub-build); the dry run counts them; over 32 needs `yes`.
- **Walk** (`walk.mjs`): `walk(plan, start, { walker })` → `{ cells, out }`, the feet cells a creature reaches on
  foot from `start` over the plan (flat ground below y = 0), and `out`, the first cell where it got away (null:
  contained). Walkers: `villager` (opens wooden doors only), `zombie` (breaks them), `player` (opens doors, gates,
  trapdoors), `small` (1 high). Conservative: jumps 1, never onto a fence or wall block, falls any height, swims,
  climbs ladders and vines; it does not model digging, teleporting, flying or spiders climbing walls.
- Example: `examples/castle.mjs` (`node examples/castle.mjs --size=20 --palette=deepslate`). A large one:
  `build-bronze-town.mjs` (a walled town with a barbican, a citadel and a keep, ~110 000 positions);
  `build-labor-prison.mjs` (cells, stalls and fields proven escape-proof with `walk`, creatures spawned last). Build
  briefs for particular structures live in `prompts/` (e.g. `prompts/labor-prison.md`).

## Blocks

- Namespaced vanilla ids with an optional blockstate: `minecraft:oak_log[axis=x]`,
  `minecraft:spruce_stairs[facing=east,half=top]`. **The server silently drops a blockstate it cannot parse**
  (it places the bare block), so get properties right; an unknown id is refused.
- **Stairs `facing` = the direction you walk to climb them**: the way Y rises along the slope. Roof stairs
  point INWARD to the ridge (north slope `facing=south`, …); `half=top` hangs one upside down (eaves). The
  roof functions and components already do this; in new code, derive `facing` from the slope, never guess.
- Logs: `axis=y` posts, `axis=x`/`axis=z` beams along that axis. Doors need both halves (`door()`).

## How to work

1. **Look.** Run `node mcp-build.mjs`, then print `blockInfo()` and, for anything over ~16 blocks, `terrain()`
   (`const b = await open(); console.log(await b.terrain(b.pivot.x, b.pivot.z, 32))`). Note the ground height
   over the footprint: `y = 0` in a plan is the ground course, so pick the anchor's Y from the terrain.
2. **Plan in a few sentences**: footprint, height, palette, which components with which parameters, anchors.
3. **Compose from the library first.** Write one script `build-<name>.mjs` here that builds the plan from
   components (`placeAt` to position, rotate and mirror them) and calls `build(plan, { label, ...cliOptions(),
   anchor })`, with the parameters at the top or taken from `--key=value`.
4. **New geometry only when no component fits.** If it is reusable (a shape or a part you could build again
   with other parameters), add it to `lib/geom.mjs` or `lib/components.mjs` with defaults and a doc comment,
   plus a test in `test/` (`node --test` must pass: run it in this directory). One-off details may stay in the
   script.
5. **Dry-run** (`node build-<name>.mjs`): check the counts, the bounding box and a few `sliceMap` levels. Over
   5 000 positions, ask me before `--yes`.
6. **Build** (`node build-<name>.mjs --build`, `--parallel=2..4` for big ones). If the slots are busy another
   build is running: let it wait. On a refusal, fix the script and re-run only the part that failed.
7. **Report**: what was built, the absolute anchor and bounding box, the counts (planned and server-confirmed),
   the script name and the parameters to change for a variant, and what I should check in game.

Keep scripts small and readable. No dependencies beyond Node's standard library and this directory.

## My request

