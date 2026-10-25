# Build brief: the slavers' labor prison

A walled work camp run by illager slavers: captured villagers labor in its fields and workshops, sleep in locked
cells, and cannot get out. You build it by code, as in `PROMPT.md` in this directory: **read `PROMPT.md` first**. It
holds the connection rules, the library, the server limits and the workflow. This file is the brief and the
extra rules for this build.

## 0. Wait for the ticket

- **Place nothing, spawn nothing, open no sub-build until I give you a ticket.** The ticket is in
  `PAULSBRAWLS_TICKET`, or I paste it in chat (`bld-…`). If I paste it, pass it only as an environment variable
  on each `node` command. Never echo it, never write it to a file.
- `PAULSBRAWLS_MCP_TOKEN`: if it is not set, read `mcpToken` from `god_agent.properties` in the running server's
  directory (`C:\Users\Paul\Desktop\PaulsBrawlsVanilla\` for production) and pass it the same way. That read is the
  one exception to "no file outside this directory".
- Run `node mcp-build.mjs`. It must print `OK, ticket valid` and `spawn_mobs: available`. If it says
  `spawn_mobs: MISSING`, the server still runs a mod built before spawning existed. Tell me, then go on with the
  structure (spawning comes last anyway). I rebuild the mod with the server stopped and restart it.
- Tickets expire (30 minutes on this server). On "Ticket … inconnu ou expiré", stop and ask me for a new one.

## 1. Survey, then plan

Do `PROMPT.md` step 0 (block info, terrain at radius 16, 32 and 64). Keep clear of every existing build:
- the Bronze Age town (absolute x 182..352, z 656..852), its moat included;
- the palace near x=151 z=384, the ziggurat and Ishtar gate near x=9 z=264, the cottage near x=44 z=147;
- unknown builds west of the pivot (about x 11..122, z 589..860).

Report the site, then **plan in a few sentences and wait for my go**: footprint, zones, creature counts, palette.
Size it to the space. The town is about 170 × 200; the prison should be its own place, about 80 to 140 blocks across.

## 2. What to build

- **Perimeter:** a wall at least 8 high with a walkway, crenellations on both faces, and the `overhang` lip. Put a
  `squareTower` at each corner and at least one more per side. Add `earthworks` (a moat) if it fits. There is
  **one** way in: a gatehouse. Its gates are closed fence gates or iron doors. Villagers can open neither.
- **Cell block:** rows of cells, each at least 2 × 3 inside and 3 high. Each has a roof, one bed (both halves) and
  an **iron door** onto a corridor. The **button** sits on the corridor side only. Cells face each other across
  the corridor, and the guards' catwalk runs above it. This is new reusable geometry: add
  `cellBlock({ cells, rows, cellW, cellD, height, corridor, bed, door })` to `lib/components.mjs`, with doc and
  test, as `PROMPT.md` step 3 says.
- **Labor** (they must really work: a villager works at the job-site block it claims, in the daytime):
  - **Fields:** walled plots of farmland, ripe crops and water channels, with **farmer** villagers inside. They
    harvest and replant. Put a composter in each plot.
  - **Workshops:** stalls along a hall, one job-site block each, one villager each with the matching
    profession. Pairs: blast furnace → armorer, smithing table → toolsmith, grindstone → weaponsmith, stonecutter
    → mason, loom → shepherd, smoker → butcher, fletching table → fletcher, cauldron → leatherworker, lectern →
    librarian, brewing stand → cleric.
  - Optionally, a quarry pit, stepped and fenced, as the camp's centrepiece.
- **The slavers' side:**
  - Guards on the gate, the towers, the catwalks and the yard corners.
  - The overseer's house, with a raised office overlooking the yard.
  - Barracks, an armory, a stable.
  - Lanterns everywhere.

## 3. The rules that keep them in

Minecraft facts the design must respect:
- Villagers open wooden doors. They can't open iron doors, fence gates or trapdoors, and can't press buttons.
- They jump one block and never onto a fence or wall block (1.5 high).
- They climb any ladder, vine or scaffolding they bump into.
- Baby villagers (from beds and food) fit through 1 × 1 holes.
- Zombies break wooden doors.
- Pillagers, vindicators and evokers attack villagers on sight.

1. **Prove it with `walk`** (`lib/walk.mjs`). This is a hard requirement, run on the dry-run plan before you ask
   to build. From one start cell in every zone a prisoner occupies (each cell, each field, each workshop stall,
   the yard), run `walk(plan, start, { walker: 'villager' })` and again with `{ walker: 'small' }`.
   - `out` must be `null`.
   - Every cell it reaches must lie inside that zone's own bounds: a cell's villager stays in its cell, a
     farmer in its field.
   - Then `walk` from outside the gate with `{ walker: 'zombie' }`: it must reach no prisoner zone.
   - Put the check in the build script so it runs on every dry run, and print one line per zone.
2. **No ladder, vine or scaffolding anywhere a prisoner can reach.** In the bronze town, the only way a villager
   got out was up a tower ladder and over the parapet. Guards' ladders go behind iron doors.
3. **Walls a villager stands next to are 3 high, or roofed.** A bed, a workstation or a crop block beside a 2-high
   wall is a step up and over it.
4. **No 1 × 1 holes** in a prisoner zone's walls (babies). Light through glass or an open roof that nothing can reach.
5. **Iron doors** on every door a prisoner could use. Buttons and levers go on the guard side only.
6. **Light level:** a lantern at least every 6 blocks in and around every prisoner zone, so no zombie spawns inside.
7. **Guards never kill the prisoners.** An illager guard is either:
   - a **statue**, with NBT `{NoAI:1b,Silent:1b,Invulnerable:1b,Rotation:[<yaw>f,0f]}` plus a held item
     (`HandItems:[{id:"minecraft:crossbow",count:1},{}]`); or
   - live, but **sealed off**: solid walls between it and any prisoner, and no line of sight through glass, bars
     or fences.

   Iron golems may patrol the yard live. They guard villagers and attack hostile mobs.

## 4. Spawning creatures

- In the script, put creatures in `spawns(entity, points, { nbt, persistent })` groups (`lib/plan.mjs`) and pass
  them as `build(plan, { spawns, ... })`. Use `placeSpawns(groups, { at, turns, mirror })` to move them with a
  component.
- A point is the block the creature's feet stand in. It needs a floor under it and 2 clear blocks above (3 for an
  iron golem).
- `build()` spawns after every block is placed (the structure, then the attachments). It uses `spawn_mobs`, at
  most 16 per call and 128 per sub-build.
- Creatures are persistent by default. The Wither and the Ender Dragon are refused, and so is anything that is
  not a mob.
- The dry run lists creatures per type. Over 32 creatures, `build()` refuses without `--yes`: ask me first.
- Worker NBT:

  ```
  {VillagerData:{profession:"minecraft:farmer",level:2,type:"minecraft:plains"},Xp:10}
  ```

  `level:2` with some `Xp` keeps the profession even when the job site is out of reach for a while. Vary `type`
  (plains, desert, savanna, snow, swamp, taiga, jungle) for a mixed captive population.
- A creature spawned without NBT is initialised as `/summon` would (random equipment, variant).
- Check the NBT spelling against 1.21.1 (`count`, lower case, in item stacks). The server refuses SNBT it cannot
  parse, but a wrong key is silently ignored.

## 5. Report

`PROMPT.md` step 6, plus:
- the creature counts, planned and spawned, per type;
- the `walk` results per zone;
- what I should check in game: iron doors, the buttons from the corridor, the farmers working at dawn, and
  that no villager is outside the walls after a night.
