# Creatures: spawning, NBT, behaviour (Minecraft 1.21.1)

Read before spawning anything, and before designing anything a creature lives in.

## Spawning with the library

- `spawns(entity, points, { nbt, persistent })` makes a group; a point is the block the creature's **feet** stand
  in. The server spawns it there whatever is around, so it is on you to give it a floor and clear blocks for its
  height: 2 for villagers, illagers, zombies and horses, 3 for an iron golem (crops, carpets, buttons and torches
  count as clear). Otherwise it falls, or suffocates in a wall.
- `placeSpawns(groups, { at, turns, mirror })` moves groups like `placeAt` (the NBT is not rewritten: turn a
  statue's `Rotation` yourself).
- `build(plan, { spawns })` spawns after every block stands. Creatures are persistent unless `persistent: false`.
- Limits: 16 per call, 128 per sub-build (build() splits), mobs only (armor stands, item frames, boats and other
  non-mob entities are refused), never the Wither or the Ender Dragon. Over 32 creatures, `build()` needs `--yes`:
  ask first.
- **Spawning twice duplicates.** A re-run of a whole build spawns everything again: re-run blocks only
  (`--mobs=none` in the template) or creatures only (`--mobs=only`).
- One group per distinct NBT string; give each villager its own group when their NBT differs.

## NBT in 1.21.1

SNBT the server cannot parse is refused (so is NBT over 4 096 characters, and passengers are dropped); **a key it
does not know is silently ignored**, so spelling matters.

| Key | Example | Note |
|---|---|---|
| item stack | `{id:"minecraft:crossbow",count:1}` | `count` is lower case since 1.20.5. An empty slot is `{}`; never `minecraft:air` (invalid). |
| `HandItems` | `[{id:"minecraft:iron_axe",count:1},{}]` | main hand, off hand. |
| `ArmorItems` | `[{},{},{id:"minecraft:iron_chestplate",count:1},{}]` | feet, legs, chest, head. |
| `HandDropChances`, `ArmorDropChances` | `[0f,0f]` | keep guards from dropping their gear. |
| `Rotation` | `[180f,0f]` | yaw, pitch. Yaw 0 looks south (+z), 90 west, 180 north, -90 east; from a direction (dx, dz): `atan2(-dx, dz)` in degrees. |
| `NoAI`, `Silent`, `Invulnerable` | `1b` | a statue. |
| `CustomName` | `'"Gardien"'` | a JSON text component inside a string. `CustomNameVisible:1b` shows it. |
| `VillagerData` | `{profession:"minecraft:farmer",level:2,type:"minecraft:plains"}` | add `Xp:10`: level ≥ 2 with some XP keeps the profession even while its job site is out of reach. `minecraft:none` = unemployed (takes a job), `minecraft:nitwit` = never works. Types: plains, desert, savanna, snow, swamp, taiga, jungle. |
| horse | `{Tame:1b,SaddleItem:{id:"minecraft:saddle",count:1}}` | |
| `Age` | `-24000` | a baby (for breedable mobs). |

A creature spawned without NBT is set up as `/summon` would (random gear, random variant).

**Statue pattern** (a guard that never acts): `{NoAI:1b,Silent:1b,Invulnerable:1b,Rotation:[<yaw>f,0f],HandItems:[…]}`.
It still counts as that mob for everyone else's AI: see panic and golems below.

## Behaviour to design for

**Villagers**
- Open wooden doors; cannot open iron doors, fence gates or trapdoors, nor press buttons or pull levers.
- Jump one block; never onto a fence, wall or fence gate (1.5 high). A 1-high block beside a 2-high wall (a bed, a
  workstation, a composter, a crop's farmland edge) is a step over it: walls they stand next to are 3 high, or roofed.
- Climb any ladder, vine or scaffolding they bump into; swim.
- Babies (from beds + food) fit through 1 × 1 holes.
- **Work** needs the villager's own job-site block (one per villager: two farmers cannot share a composter), reachable
  on foot, and happens in the daytime; farmers harvest and replant farmland. They sleep at night in a bed they
  claimed, and meet at a bell around midday.
- **Panic:** a villager panics when it *sees* a hostile mob within its range, and a panicking villager stops working
  and flees. Ranges: zombie, husk, drowned, zombie villager, vex 8; vindicator, zoglin 10; evoker, illusioner,
  ravager 12; pillager 15. `NoAI` does not exempt a statue. Sight is a straight line between the eyes: solid blocks,
  glass and closed doors block it. So keep every illager or zombie (statue or not) out of sight of working villagers,
  or farther than its range (3-D distance, feet to feet). Panicking villagers can also summon an iron golem.

**Iron golems** attack every hostile mob but creepers, statues included: an invulnerable statue gets punched forever.
Keep golems where they cannot see statues, or leave golems out.

**Illagers** (pillager, vindicator, evoker) attack villagers, golems and players on sight. A live one near villagers
needs solid walls between them and no line of sight (glass, bars and fences let them see).

**Zombies** break wooden doors (Hard difficulty) and hunt villagers. Baby zombies fit through 1-high gaps.

**What no wall stops:** spiders climb walls (roof a pen), endermen teleport, flying mobs (phantoms, bats, parrots,
ghasts) fly, and players dig. The `walk` proof does not model any of these.

## Before you spawn: a checklist

- Every point has its floor and headroom, and no two creatures share one.
- Every worker has its own reachable job site of the right kind; nothing else claimable is in reach.
- No hostile (statue or live) is within panic range and in sight of a working villager; the script can check
  distances (see proofs.md).
- The counts per type in the dry run match the plan.
