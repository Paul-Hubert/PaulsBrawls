---
id: eden.skills.stock
title: Eden stock skills — the bundled mortal primitives and divine powers
system: eden
summary: Every bundled stock skill in exemplars/index.ts (28 mortal + 9 divine) with tier, params, returns, real-mineflayer behaviour, composition and hardening notes.
tags: [eden, skills, stock, exemplars, mineflayer, farming, crafting, chest, divine, reflex]
sources: [eden/src/skills/exemplars/index.ts, eden/src/skills/library.ts, eden/src/skills/engine.ts, eden/src/main.ts, eden/roles.json, eden/src/config.ts, eden/tests/skills-exemplars.test.ts, docs/02-skill-system.md, docs/07-hard-won-lessons.md]
verified_at: 4a8081f
---

# Eden stock skills — the bundled mortal primitives and divine powers

**TL;DR.** `STOCK_SKILLS` (`eden/src/skills/exemplars/index.ts:843-876`) bundles **37** skills: 28
`mortal` (movement, mining, crafting, chests, farming/bread economy, reflexes) and 9 `divine` avatar powers
(server commands via chat). `seedStockSkills` (`:879-896`) seeds every one straight into `active` with
author `{kind:'stock'}` on **every boot** (`eden/src/main.ts:524`). Seven mortal skills are flagged
`exemplar: true` and ride as full code in every authoring prompt. They are ordinary library skills:
JS strings compiled by the engine, receiving only `(bot, args, ctx)`.

## How stock skills are used

- **Seeding:** `library.seedStock(input, 'active')` → `upsertDraft` + status `active` (no probation, D-12).
  Re-seeding appends a new version each boot (see [skills-library.md](skills-library.md#gotchas--known-issues)).
- **Exemplars (full code in prompts):** `go-to`, `mine-block`, `find-block`, `collect-blocks`,
  `craft-item`, `use-chest`, `deposit` (`eden/src/main.ts:583`). Test pins 5–7 exemplars, all mortal, each ≤ 60
  lines (`eden/tests/skills-exemplars.test.ts:41-48`).
- **Primitives palette:** all other mortal stock skills as `name — signature — summary` (`eden/src/main.ts:589-591`).
- **Reflexes:** `eden/roles.json` binds `hurt → flee-to-safety` (everyone, `notWhileRunning`, cooldown 3000),
  `night-falls → go-home` (everyone), `hurt → defend-self` (guard, cooldown 1000),
  `new-day → harvest-field` (farmer) — zero-token `{kind:'skill'}` handlers.
- **Composition:** stock skills are `active`, so they are composable via `ctx.skills.run`. Summaries are French.

## Shared inline helpers

Skill bodies compile one at a time, so helpers are string-inlined into each body
(`eden/src/skills/exemplars/index.ts:36-71`):

| Helper | Inlined into | Behaviour |
|---|---|---|
| `itemId(bot, name)` | craft-item, use-chest, smelt-item, place-item | `bot.registry.itemsByName[name].id`; unknown → `Error('unknown item "<name>" — not in bot.registry.itemsByName (D1)')` |
| `safeCloseStray(bot)` | craft-item, use-chest, smelt-item | if `bot.currentWindow`, `closeWindow` it then `await setTimeout(0)` (R1/R63) |
| `pauseMutators(bot)` | same | `autoEat.disableAuto()`, `armorManager.pause()` — each guarded (R3) |
| `resumeMutators(bot)` | same | `armorManager.resume()`, `autoEat.enableAuto()` |

## Catalogue

`req` = required param; defaults shown as `=v`. Line numbers are in `eden/src/skills/exemplars/index.ts`.

### Mortal — core primitives

| Skill | Ex. | Params | Returns | Tags | Lines |
|---|---|---|---|---|---|
| `go-to` | yes | `x,y,z` req, `range=1` | `{arrived}` | movement | 74-97 |
| `mine-block` | yes | `x,y,z` req | `{mined: string}` | mining | 99-113 |
| `find-block` | yes | `name` req, `maxDistance=48` | `{x,y,z,name}` | search, collection | 115-137 |
| `collect-blocks` | yes | `x,y,z` req, `maxHeight=32` | `{collected}` | collection, wood | 139-167 |
| `craft-item` | yes | `item` req, `count=1` | `{crafted}` | crafting | 169-213 |
| `use-chest` | yes | `x,y,z` req, `deposit=[]`, `withdraw=[]` (arrays of `{name,count}`) | `{ok}` | storage | 215-243 |
| `deposit` | yes | `x,y,z,items` req | `{deposited}` | storage | 245-257 |
| `withdraw` | no | `x,y,z,items` req | `{withdrawn}` | storage | 259-271 |
| `smelt-item` | no | `input,fuel` req, `count=1` | `{smelted}` | smelting | 273-302 |
| `place-item` | no | `item,x,y,z` req, `faceX=0,faceY=1,faceZ=0` | `{placed}` | building | 304-320 |
| `kill-mob` | no | `entityName` req, `maxDistance=16` | `{killed}` | combat | 322-337 |
| `explore-until` | no | `target` req, `maxHops=8` | `{found,x,y,z}` | exploration | 339-357 |

### Mortal — farming and the bread economy

| Skill | Params | Returns | Composes | Lines |
|---|---|---|---|---|
| `till-block` | `x,y,z` req | `{tilled,x,y,z}` | go-to | 366-406 |
| `sow-seed` | `x,y,z,seed` req | `{sown,crop,x,y,z}` | go-to | 408-440 |
| `find-till-spot` | `maxDistance=32` | `{found,x,y,z}` | — | 450-485 |
| `till-spot-near-water` | `maxDistance=32` | `{tilled,x,y,z}` | find-till-spot → till-block | 487-502 |
| `find-harvestable-plant` | `crop?`, `maxDistance=32` | `{found,x,y,z,crop}` | — | 504-528 |
| `harvest-plant` | `x,y,z` req | `{harvested,crop,x,y,z}` | go-to | 530-551 |
| `pickup-drops` | `radius=8` | `{picked}` | go-to (per drop) | 553-585 |
| `harvest-nearby-crop` | `crop?`, `maxDistance=32` | `{harvested,x,y,z,crop}` | find-harvestable-plant → harvest-plant → pickup-drops | 587-607 |
| `find-crafting-table` | `maxDistance=32` | `{found,x,y,z}` | — | 609-623 |
| `make-bread` | `count=1` | `{crafted}` | find-crafting-table → craft-item | 625-642 |
| `store-in-chest` | `items` req, `x?,y?,z?` | `{stored}` | deposit (→ use-chest → go-to) | 644-664 |
| `tend-bread-farm` | `cycles=6`, `seed='wheat_seeds'`, `breadThreshold=3`, `chest?` (object) | `{harvested,planted,baked}` | all of the above | 666-711 |

### Mortal — reflex handlers

| Skill | Params | Returns | Bound in roles.json | Lines |
|---|---|---|---|---|
| `flee-to-safety` | `home?` (object), `distance=12` | `{fled}` | everyone: `hurt` | 718-736 |
| `defend-self` | `maxDistance=16` | `{defended}` | guard: `hurt` | 738-764 |
| `go-home` | `x?,y?,z?`, `range=2` | `{home}` | everyone: `night-falls` (args `{}`) | 766-787 |
| `harvest-field` | `maxBlocks=16` | `{harvested}` | farmer: `new-day` | 789-809 |

### Divine (avatar only; invisible to villager retrieval)

All `exemplar:false`, built with the `divine(...)` helper (`:812-840`). Each is a one-liner that issues a
chat command and returns immediately — **no confirmation** that the command succeeded.

| Skill | Params | Returns | Effect on real server | Tags |
|---|---|---|---|---|
| `appear-near` | `villager` req | `{ok}` | `bot.chat('/tp ' + bot.username + ' ' + villager)` | body |
| `vanish` | `x=0,y=200,z=0` | `{ok}` | `/tp <self> x y z` (parking spot default 0,200,0) | body |
| `gesture` | `type` req | `{ok}` | `swing` → `bot.swingArm()`; `jump` → jump control 200 ms; any other type is a no-op | body |
| `fly-to` | `x,y,z` req | `{arrived}` | `await bot.creative.flyTo(new ctx.Vec3(x,y,z))` | movement |
| `summon-creature` | `entity,x,y,z` req, `count=1` | `{summoned}` | `/summon <entity> x y z` × count | spawn |
| `smite` | `x,y,z` req | `{ok}` | `/summon lightning_bolt x y z` | punish |
| `teleport-entity` | `target,x,y,z` req | `{ok}` | `/tp <target> x y z` | movement |
| `give-items` | `target,item` req, `count=1` | `{given}` | `/give <target> <item> <count>` | reward |
| `set-weather` | `weather` req | `{ok}` | `/weather <weather>` | world |

These require the avatar to be op'd on the server (Eden never ops; op-on-join is the Java mod's job —
see [java-integration.md](java-integration.md)). When the avatar runs a **mortal** root skill, the chat
interceptor drops `/`-messages (R25), including any divine callee's commands.

## Per-skill notes (real-mineflayer behaviour and hardening)

**go-to** — R7 hop walk: while the straight-line distance > 40, path to a waypoint 40 blocks along the line
with `GoalNear(...,2)` and `ctx.log('hop toward x,y,z')` (pulse); max 1024 hops; then
`bot.pathfinder.goto(new ctx.goals.GoalNear(x,y,z,range))`. Pathfinder liveness events keep the stall
detector alive. Throws `TypeError` if `bot.entity` is null.

**mine-block** — `bot.blockAt(new ctx.Vec3(x,y,z))` (real `Vec3` required, Blocker Z); throws
`no block at x,y,z (absent or chunk unloaded)`; `await bot.dig(block)`. Does not move into reach or equip
a tool (the `mineflayer-tool` plugin is loaded but not called here).

**find-block** — strips a `minecraft:` prefix; uses `bot.registry.blocksByName[name].id` as a numeric
matcher when known (fast path), else a name predicate; `bot.findBlock({matching, maxDistance})`. Throws
`aucun bloc "<name>" trouvé dans un rayon de N blocs`. Doctrine: compose this instead of hand-rolled
`blockAt` grid scans.

**collect-blocks** — R10 trunk-only: digs upward from `(x,y,z)` while the block name matches
`/(_log|_wood|_stem|_hyphae)$/`, stopping at the first non-log (floating leaf-logs never touched);
a failed dig is logged (`skip undiggable log: …`) and skipped. Gap E: if anything was dug, walk to
`GoalNear(x,y,z,1)` (best-effort, `pickup walk skipped` on error) and wait 300 ms so drops are auto-collected.
The base block must itself be a log.

**craft-item** — the R1–R3/R63 discipline: `safeCloseStray`, `pauseMutators`, then (inside `try`)
`itemId(item)`; locate `crafting_table` within 24 blocks; if > 3 blocks away compose `go-to` (range 2);
`bot.recipesFor(id, null, 1, table || null)[0]` (numeric id + table block — gap C); throws
`pas de recette pour <item>[ (aucun établi à portée pour une recette 3×3)]`; `await bot.craft(recipe, count, table)`;
then R2 packet quiescence: resolve once `set_slot`/`window_items` on `bot._client` are silent for 80 ms.
`finally`: close any window + resume mutators. **`count` is the number of craft operations**, and the
return value is `{crafted: count}` (not the item total; e.g. planks yield 4 per craft). `recipesFor` is
asked for a recipe craftable at least once, so `count > 1` can fail in `bot.craft` on short materials.

**use-chest** — compose `go-to` (range 3); `blockAt`; throws `no chest at …`; `safeCloseStray`;
`pauseMutators`; `bot.openContainer(block)`; deposit/withdraw each `{name,count}` via `itemId`;
`finally` `chest.close()` + `resumeMutators`. Works for any container block (chest, barrel…).

**deposit / withdraw** — thin wrappers over `use-chest`; the return is `items.length` (number of entries),
not the item count.

**smelt-item** — `findBlock` furnace within 16 (no movement — must already be in reach); close stray window,
pause mutators; `bot.openFurnace`; `putFuel(fuel, 1)` (always one fuel item); `putInput(input, count)`;
poll every 1 s with `ctx.log('smelting...')` (pulses) until `outputItem().count >= count`; `takeOutput()`;
`finally` close + resume. Not exercised on FakeBot (no furnace seam). If output never reaches `count`
(e.g. one fuel item insufficient), it loops until the wall-clock timeout because the log keeps pulsing.

**place-item** — `bot.equip(itemId(item), 'hand')`, `blockAt` reference block (throws
`no reference block at …`), `bot.placeBlock(ref, new ctx.Vec3(faceX,faceY,faceZ))` — places on the given
face of the reference (default top). No movement.

**kill-mob** — picks the **first** entity in `bot.entities` whose `name === entityName` within
`maxDistance` (not the nearest; uses `bot.entity.position.distanceTo`), `await bot.pvp.attack(target)`,
then polls `target.isValid` every 250 ms with a raw `setTimeout` (no pulse; relies on pvp movement/path
pulses). An unreachable/escaping target loops until stall or timeout.

**explore-until** — up to `maxHops` times: `findBlock(target, 48)`; else compose `go-to` to
`(p.x + 32, p.y, p.z)` — always east (+X).

**till-block** (R55) — refuses unless block is `dirt`/`grass_block`/`dirt_path` (returns early if already
`farmland`) and the block above is `air`/`cave_air`/`void_air`; needs any `*_hoe` in inventory; equips;
`go-to` if > 3 away; `bot.activateBlock(target)`; then polls `blockAt` 40 × 50 ms (2 s) for `farmland`
(server-confirmed, never read synchronously). French errors, e.g. `labour non confirmé après 2 s …`.

**sow-seed** (R55) — ground must be `farmland` (`sol non labouré … appelle d’abord till-block`), seed item
by exact name; equip; `go-to` if > 3 away; `activateBlock(ground)`; polls the block above 40 × 50 ms until
non-air.

**find-till-spot** — nearest `water` within `maxDistance`, then scans rings r = 1..4 around it at
dy = 0 then −1 for a `dirt`/`grass_block`/`dirt_path` with open air above (hydration box). Returns
`{found:false,x:0,y:0,z:0}`, never throws.

**find-harvestable-plant** — `findBlock` for `wheat`/`carrots`/`potatoes`/`beetroots` (or just `crop`)
whose `metadata >= MAX_AGE` (7/7/7/3); a block with no numeric metadata counts as mature. Never throws.

**harvest-plant** — refuses non-crop blocks (`bloc non récoltable: …`); `go-to` if > 3; `bot.dig`. Does not
check maturity. Drops land on the ground — follow with `pickup-drops`.

**pickup-drops** — item entities (`name === 'item'` or `displayName === 'Item'`; deliberately not the
deprecated `objectType`, which floods `console.trace`) within `radius`; `go-to` range 1 each then `sleep(200)`
(scope global, pulses). `picked` counts drops walked to, per-drop errors logged (`drop ignoré: …`).

**harvest-nearby-crop** — find → harvest → `pickup-drops {radius:8}`; only attaches `crop` when truthy,
because `crop: undefined` would fail the callee's `string` validation.

**make-bread** — confirms a table within 32 (`aucun établi … impossible de cuire du pain`), then
`craft-item {item:'bread', count}`.

**store-in-chest** — without full coords, finds the nearest `chest`/`barrel` within 32 (error lists the item
names); composes `deposit`. Returns the summed `count` of `items`.

**tend-bread-farm** — per cycle (checks `ctx.signal.aborted`): `harvest-nearby-crop`; if something was
harvested and a seed is in inventory, `sow-seed` at `y - 1` (try/caught); otherwise `till-spot-near-water`
then `sow-seed` (try/caught). If wheat ≥ `breadThreshold`: `make-bread {count: floor(wheat/breadThreshold)}`
and `store-in-chest` with `...chest` coords (try/caught). `sleep(500)` per cycle keeps macrotasks draining.
Max composition depth reached: 4 (`store-in-chest → deposit → use-chest → go-to`).

**flee-to-safety** — goes to `home {x,y,z}` if given, else `distance` blocks toward −X; composes `go-to` range 2.

**defend-self** — finds the nearest entity within `maxDistance` among 21 hostile names (zombie, husk,
drowned, skeleton, stray, creeper, spider, cave_spider, witch, pillager, vindicator, illusioner, ravager,
slime, silverfish, phantom, zoglin, hoglin, piglin, piglin_brute, zombie_villager); none → logs and returns
`{defended:false}`; else composes `kill-mob {entityName: target.name, maxDistance}`.

**go-home** — with `x,y,z` numbers composes `go-to`; otherwise logs `go-home: pas d’ancre maison fournie`
and returns `{home:false}`.

**harvest-field** — up to `maxBlocks` times, `findBlock` the nearest `wheat` within 16 and `bot.dig` it;
stops on the first dig error.

## Gotchas & known issues

- **use-chest / smelt-item leak paused mutators on open failure:** `pauseMutators` runs *before* the `try`,
  so if `openContainer` / `openFurnace` rejects (e.g. "windowOpen did not fire"), auto-eat and armor-manager
  stay disabled (`:232-241`, `:291-300`). `craft-item` wraps everything in `try/finally` and is safe.
- **tend-bread-farm is not failure-tolerant at the harvest/till steps:** `harvest-nearby-crop` and
  `till-spot-near-water` are not try/caught, so e.g. `till-block`'s `pas de houe dans l’inventaire` aborts the
  whole loop. `breadThreshold` is also used as the wheat-per-loaf divisor (correct only at 3).
- **harvest-field digs immature wheat** (no age check) and does not move or pick up drops; far wheat fails
  `dig` and ends the loop.
- **go-home is always a no-op as a reflex:** roles.json binds it with `args: {}` and no anchor substitution
  exists; additionally `night-falls` has no live signal source (see
  [bots-and-hardening.md](bots-and-hardening.md#signals-edensrcbotssignalsts)).
- **kill-mob** targets the first matching entity, not the nearest; **defend-self**'s chosen hostile may thus
  differ from the one `kill-mob` attacks.
- **gesture** advertises `sneak/nod` in its summary but only `swing` and `jump` do anything.
- **fly-to** needs creative mode; `god.gamemode` (`'creative'` default, `eden/src/config.ts:92`) is parsed but not
  consumed anywhere in `eden/src`, so nothing puts the avatar in creative.
- **Divine skills report success unconditionally** — the chat command's server response is never read.
- **Re-seed on every boot** appends a new version of all 37 skills (see skills-library gotchas).
- Several skills dereference `bot.entity.position` without a null check (go-to, defend-self, flee-to-safety,
  tend-bread-farm via callees) and throw `TypeError` on a dead/disconnected body.

## Related

- [skills-engine.md](skills-engine.md) — the ctx these skills use (`ctx.Vec3`, `ctx.goals`, `sleep`, composition)
- [skills-library.md](skills-library.md) — seeding, versions, exemplar prompt injection
- [bots-and-hardening.md](bots-and-hardening.md) — the TS twins of these helpers and the plugin set
- [villager-runtime.md](villager-runtime.md) — subscriptions/reflex bindings from roles.json
- [god.md](god.md) — the avatar that runs divine skills
- [java-integration.md](java-integration.md) — op-on-join for the avatar
