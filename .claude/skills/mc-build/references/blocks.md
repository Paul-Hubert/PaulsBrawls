# Blocks: states, placement, water, crops, light (Minecraft 1.21.1)

Read before writing blocks. `PROMPT.md` has the library side; this is the Minecraft side, and what went wrong before.

## How the server takes a block

- Ids are namespaced with an optional state: `minecraft:spruce_stairs[facing=east,half=top]`. **An unknown id is
  refused, but a state the server cannot parse is silently dropped** (the bare block goes in). A typo in a property
  name or value is therefore a silent bug: check names and values against the table below, and look at the dry run's
  counts per block string (`stats(plan).byBlock`).
- **A placed block replaces whatever is there**, air included. Your plan's air layers are how you cut openings,
  clear old terrain or remove grass inside a floor. Nothing protects someone else's build: the survey does.
- `build()` places in three passes: air, then structure (each material bottom-up), then attachments (blocks that
  hang on or stand on another). The pass is chosen from the id by `isAttachment` in `lib/plan.mjs`: torches,
  lanterns, ladders, doors, buttons, levers, signs, banners, carpets, rails, pressure plates, flower pots, flowers,
  saplings, vines, candles, chains, tripwire, redstone wire, snow layers, beds, bells. A new attachment kind that
  the regex misses can be placed before its support and pop off: extend the regex (with a test) if you use one.
- Gravity blocks (sand, gravel, concrete powder, anvils, scaffolding) fall if nothing is under them when placed.
  The bottom-up order handles a column; an overhang of sand does not hold.

## States that matter

| Block | State | Meaning |
|---|---|---|
| stairs | `facing`, `half=bottom\|top`, `shape` | `facing` = the way you walk to climb them (Y rises that way). Roof stairs face inward to the ridge; `half=top` hangs one upside down (eaves). `shape` is computed by `resolve` from the final layout. |
| slab | `type=bottom\|top\|double` | a top slab is a ceiling/overhang half block. |
| log, pillar, basalt, chain | `axis=x\|y\|z` | posts `y`, beams along their own axis. |
| door | `facing`, `half=lower\|upper`, `hinge=left\|right`, `open` | use `door(id, [x, y, z], facing)`: both halves; `facing` = the way you look as you walk in. |
| bed | `facing`, `part=foot\|head` | the head is one block from the foot in `facing`. Place both halves; transforms keep them paired. |
| button, lever | `face=wall\|floor\|ceiling`, `facing` | on a wall, `facing` points away from the wall it is fixed to. |
| ladder, wall torch, wall sign | `facing` | away from the wall behind it; that wall block must be solid. |
| lantern, soul lantern | `hanging=true\|false` | standing needs a block under it; hanging needs one above. |
| fence gate | `facing`, `open=false` | `facing=north/south` spans east–west (blocks a north–south passage). |
| trapdoor | `facing`, `half`, `open` | |
| fence, wall, pane, iron bars | side connections | computed by `resolve` from the final layout; never set them by hand. |
| chest | `facing`, `type=single\|left\|right` | two singles side by side stay two chests. |
| barrel | `facing=up\|…` | |
| furnace, smoker, blast furnace, loom, stonecutter, lectern | `facing` | the front. |
| grindstone | `face=floor\|wall\|ceiling`, `facing` | |
| farmland | `moisture=0..7` | |
| wheat, carrots, potatoes | `age=0..7` | 7 is ripe. |
| beetroots | `age=0..3` | 3 is ripe. |
| composter | `level=0..8` | |

## Redstone the simple way: a button that opens a door

A pressed button strongly powers **the block it is fixed to** for about a second (stone 1 s, wood 1.5 s). That block
then opens any door touching it, either half. So: put the button on the wall block **beside the door's upper half**,
on the side the button belongs to, and make that wall block a full conductive block (stone, bricks, planks: not glass,
slabs, stairs or leaves). Keep two doors from touching the same powered block, or one button opens both. `cellBlock`
does this; copy its pattern (`lib/components.mjs`).

## Palettes

Components ask for roles (`wall`, `trim`, `glass`, `door`, …); `palette(name, overrides)` maps them to blocks.
`bronzeAge`'s `glass` is **air**: its windows are open holes. That is fine for a house and wrong for anything that
must hold a creature (a 1 × 1 hole at y = 2 lets a baby or a chicken through): override `glass` or pass a real block.

## Water and lava

- A source in a basin closed on every side at its level (and below) stays put. Any open side flows, and keeps
  flowing until it finds a floor: check every edge of a pool, moat, channel or fountain in the top view.
- Water at y = 0 (the ground course) with ground around it is a closed trench. Water above the ground course needs a
  rim one block higher than the water, all round.
- Water is a ladder for the `walk` model (creatures swim up): a flooded pit is a way out.

## Crops and farms

- Crops (`wheat`, `carrots`, `potatoes`, `beetroots`) stand on `farmland` and nowhere else.
- Farmland stays farmland only with water within 4 blocks horizontally, on its level or one above. A full row of
  water every 9 rows (4 on each side) hydrates a whole field.
- Creatures falling onto farmland can trample it: no ledges above fields.
- Farmers need their own composter (see creatures.md) and farmland they can walk to.

## Light

- In 1.21 hostile mobs spawn only where the **block light is 0**. A light source spreads 1 level less per block
  (through air, around corners, not through solid blocks or tinted glass): a lantern (15) lights everything within
  14 steps. So a source every ~12 blocks of open ground, and one in every closed room, stops spawns; brighter looks better.
- Levels: lantern, glowstone, sea lantern, shroomlight, froglights, jack o'lantern 15; torch 14; soul lantern and
  soul torch 10.
- In open ground where a post would be in the way, set a full light block (shroomlight, froglight, sea lantern)
  flush into the ground course.
- **Over a whole build:** `surfaceLights()` in `build-babylon.mjs` puts a shroomlight on a 10-block grid. In each
  grid column it replaces the topmost plain floor, roof or ground block. If the top is a crop or flower, it lights the
  soil under it and removes the plant. If the top is stairs, leaves, water or the like, it tries the 8 neighbouring
  columns. Run it after everything else is composed and before the proofs. It only reaches open surfaces, so closed
  rooms need their own lights. Move it into `lib/` (with a test) when a second build needs it.
- **Where the components leave dark spots** (and what fixed them on Babylon):
  - `squareTower` gives one lantern per storey, in a corner. Up to about 7 × 7 inside that is enough. From 9 × 9 the
    far corner stays dark, so hang a lantern under each ceiling (`[0, floor - 1, 0]` in the tower's frame).
  - A hanging lantern 10 up (a tall hall) barely lights the floor: add light blocks flush in the floor every 6.
  - `house()` has one lantern per storey, in the middle. A long house (w 23) has dark ends: add lanterns.
  - Narrow terraces (a ziggurat's 4-wide rings) miss most points of a 10-block grid: lanterns on the edge every 8,
    off the side where stairs arrive.
  - A dark tower storey matters even behind an iron door. A mob that spawns there climbs the ladder to the walkway
    and drops into the enclosure.

## Job sites, beds and bells are points of interest

Villagers claim the nearest unclaimed one they can walk to (about 48 blocks around). A decorative one near villagers
changes their job or their home:

| Block | Profession |
|---|---|
| composter | farmer |
| blast furnace | armorer |
| smoker | butcher |
| cartography table | cartographer |
| brewing stand | cleric |
| barrel | fisherman |
| fletching table | fletcher |
| cauldron (any fill) | leatherworker |
| lectern | librarian |
| stonecutter | mason |
| loom | shepherd |
| smithing table | toolsmith |
| grindstone | weaponsmith |

A bed is a home (and makes breeding possible); a bell is the meeting point. Out-of-reach ones are ignored, so decor
behind walls villagers cannot cross is safe.

## The ground

The production world is superflat around the known builds: grass at y = -61, dirt at -62 and -63, bedrock at -64.
Nothing goes deeper than 3 below the ground course there (y = -1..-3 from the anchor at ground level). The survey
tells you the actual height; never assume it elsewhere.
