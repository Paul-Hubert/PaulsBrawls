# Prompt: fixing what Paul found in the first real fights (shield wall, archers, dead bots, item orders)

> Paste everything below the line into a new Claude Code session at the repo root (branch `rework`). It lists seven
> fixes Paul has already decided, with the evidence and where the code is. Written 2026-11-01, after a session that
> read the production journal (orders #174–#233, 2026-10-31 19:04–19:26) and proposed these fixes; Paul approved them
> and settled the open points.

---

You will fix seven problems Paul found while playing with Squad, the player-owned Mineflayer bots. The fixes are
decided (below, "Owner decisions"): implement them, don't redesign them.

## Read first

1. `docs/34-squad-archer-guard-fixes-prompt.md`. Its sections "The system in one paragraph", "Read first", "The code
   you will touch", "Lessons already paid for", "Servers: production vs dev", "How to work each report" (steps 2–8)
   and "Constraints" all hold here. Read what it points to.
2. This file, then work through the fixes in order (F1 → F7), one commit each.

## Owner decisions (2026-11-01, Paul; do not relitigate)

- **D1.** The shield wall keeps **any angle and any position** (no rounding to 90°). When two guards would share a
  block, **the right wing is pushed one block to the side**.
- **D2.** **A bot that dies disconnects** and stays offline until an admin brings it back with
  `/bots squad respawn <kit> [n]` (e.g. `/bots squad respawn guards 10`). It drops nothing when it dies.
- **D3.** On respawn the bot's **inventory is reset to its kit**: everything it carries is cleared, then its kit is
  given.
- **D4.** The archer line's **range is as far as possible**.
- **D5.** A click on a bound item **takes back the order's bots**; a click whose args differ from the running order's
  restarts it.
- **D6.** The archer kit's **bow has Infinity and Unbreaking III** (Paul: « infinity and unbreakable 3 »). This also
  settles running out of arrows.
- **Out of scope:** the range of `defend` / `epee` archers (they stay within `radius` of the commander or the target).

## Evidence

The production journal is `squad/.squad-data/squad.db` (SQLite, table `orders`, one row per order with its JSON
`report`: `bots`, `events`, `logs`, `result`). Read it read-only, never write it; the production runtime may be
running:

```bash
cd squad && node -e "const D=require('better-sqlite3');const db=new D('.squad-data/squad.db',{readonly:true,fileMustExist:true});
const r=JSON.parse(db.prepare('select report from orders where id=?').get(207).report);console.log(r.args,r.events.length,r.logs)"
```

Paul's squads are 10 bots per kit (`/bots squad spawn guard 10`, `archer 10`). He bound `mur-de-boucliers` and
`ligne-archers` to tipped arrows, `epee` to an arrow, `tir` to a bow; an enemy `/bots raid` (owner `Envahisseur`)
fought them. No mobs (`doMobSpawning false`): the enemies were bots.

## F1 — Dead bots keep running their order's loop

**Seen:** `defend` #233: 296 log lines « shoot(ArcherNN): no bow in the inventory » from five archers that had died in
its first 15 s (events `left … died` at 0.1–14.7 s).

**Cause:** the lease-guarded bot (`src/orders/guard.ts`) checks the lease on method calls, but reads pass through.
`shoot` reads `bot.inventory.items()` and throws a `HelperError` ("no bow") before any guarded call, so the loop never
gets `BotLeftError`: `defend`'s `guard()` logs, sleeps 250 ms and picks again, forever. The ghost also holds its target
in `taken`, so live archers avoid that target. Any helper that can throw before a guarded call has the same hole.

**Fix:** `shoot` and `attack` (and any other helper that can throw before touching the bot through a guarded call)
make a lease-checked call first, as `follow` does (`bot.pathfinder.isMoving()`), so a bot that left throws
`BotLeftError` at once. A small shared function in `helpers.ts` is fine.

**Test (fails without the fix):** in `defend`, an archer that leaves (death) while a threat is in range stops
looping: no further log lines from it, and its target leaves `taken` (another archer takes it).

## F2 — The middle guards of the shield wall overlap (D1)

**Seen:** in a 10-guard wall the two middle guards stand in the same block.

**Cause:** `lineSlots` (`src/api/helpers.ts`) is exact; `groundAt` then snaps every slot to its block centre. With an
even count and `spacing` 1 the two middle slots sit at ±0.5 from the point's block centre, exactly on a block edge;
any yaw that is not exactly axis-aligned puts both in one block (10 guards at yaw 87° → 9 distinct blocks, the middle
two sharing block z = 0). At steeper diagonals, other neighbours collide too. The live test passed only because its
yaw was exactly 90.

**Fix (D1):** keep the exact yaw and point. Give the slots out on distinct blocks: going left to right (as the
commander sees it, rank by rank), a slot whose block is already taken moves one block further along `right`, **and
so does every slot to its right** (the right wing); repeat while its block is still taken (on a diagonal one block
along `right` can stay in the same block). Suggested shape: an option of the pure `lineSlots`, e.g.
`lineSlots(center, yaw, count, { spacing, ranks, depth, distinct: true })` (block = `Math.floor` of x and z; `groundAt`
keeps the column, so distinct columns stay distinct). Use it in `mur-de-boucliers` and `ligne-archers`. If you add the
option, update `squad.d.ts`, both author prompts and the `lineSlots` docs. The guards still face the exact yaw.

**Tests:** `helpers.test.ts`: 10 slots, spacing 1, yaw 87° → 10 distinct blocks, the left five unchanged, the right
five shifted one block; a 45° line; yaw exactly 90 unchanged. `item-orders.test.ts`: a 10-guard wall at 87° → every
guard in its own block.

## F3 — Archers' bows: Infinity and Unbreaking III (D6)

**Seen:** archers run out of arrows: `tir` #201 logged « no arrows » 165 times; each `tir` click uses about 9 arrows
per archer, from a kit of 64.

**Fix, the mod (`SquadKits`, `Squad.equip`):**
- The archer kit's bow carries Infinity I and Unbreaking III. Keep the 64 arrows: Infinity needs at least one, and a
  plain bow still works.
- `SquadKits.Item` gets its enchantments as Minecraft-free data (enchantment id → level), and `SquadKitsTest` checks
  them.
- `Squad.equip` applies them. In 1.21.1 enchantments are a dynamic registry: get the entry from
  `server.getRegistryManager().get(RegistryKeys.ENCHANTMENT)`, then `ItemStack.addEnchantment(entry, level)`. Check the
  names against yarn `1.21.1+build.3`.
- Raiders use the archer kit, so they get the same bow.

**Fix, the runtime (`shoot`, `src/api/helpers.ts`):**
- `shoot` knows a shot left by the arrow count dropping, so with Infinity it would never see one. It would fall back
  to the manual shot, then throw « no arrow left the bow » on every shot, and `tir` would count no arrows.
- Detect the arrow itself: an `arrow` entity that spawns with this bot as its owner. In 1.21.1 the `spawn_entity`
  packet's data field is the owner's entity id; check which field mineflayer stores it in. If the owner isn't
  available, use an arrow spawned within 2 blocks of the bot's eyes. Keep the count drop too, for a plain bow.
- Pick the bow in hand first, else one with Infinity, else any bow. `/bots equip` on an existing archer puts the new
  bow in its hand and moves the old one to the main inventory, which `inventory.items()` lists before the hotbar.
- `tir`'s shot count and the "no clear line of fire" sidestep must keep working.

**Tests:** FakeBot spawns an arrow entity, owned by the bot, when it shoots with an Infinity bow; its arrow count
stays the same.
- `helpers.test.ts`: such a shot resolves at once, with no manual fallback and no throw; a plain bow still works by
  the count; the held bow is preferred over a plain one in the inventory.
- `item-orders.test.ts`: `tir`'s volley count with Infinity bows.
- **Live (dev):** `live-tests/items.ts` counts arrows. Where it reads inventories, count arrow entities instead, then
  re-run `LIVE_ONLY=items`.

## F4 — The archer line: always two ranks, doesn't always shoot, short range (D4)

**Seen:** `ligne-archers` always forms two ranks, and archers often don't shoot at enemies Paul sees. #207 and #222
logged no shooting error at all, so the archers had no target or were walking.

**Causes (`src/stock/ligne-archers.mjs`):**
- `ONE_RANK = 8`: past 8 archers, two ranks. Paul's squads are 10.
- An archer that has not reached its slot never shoots (`archer()`: not arrived → walk, return). Every click re-forms
  the line (11 clicks in #207) and every archer coming back from a `tir` walks back to its slot (98 reclaims in #207),
  so archers spend much of the fight walking; a slot that is hard to reach (spacing 3, back 10, uneven ground) keeps
  one walking for 10 s or more.
- Targets count only within `range` (24) of the line's centre.
- In two ranks the back rank shoots into the front rank (friendly damage is cancelled, the arrow is wasted).

**Fix:**
- A `ranks` param, default 1, 1–3, instead of `ONE_RANK`.
- An archer with a foe in range shoots it from where it stands, then goes on to its slot (don't let it walk while it
  draws; check that hawkEye's shot is not spoiled by a goal still set).
- `range` (D4): default and maximum about 120, a foe counting when it is within `range` **of the archer** (still
  preferring foes in front of the line, then untaken ones). Why 120: a full-draw arrow carries about 117 blocks on
  flat ground (124 shooting downhill, by our `ARROW` model; check with `arrowReach`), and the bots see entities out to
  about 128 blocks (`viewDistance: 'short'` = 8 chunks; production's server `view-distance` is 64, so the bots' 8 is
  the limit). Keep the limit a named constant with that reason.
- Log why an archer holds fire, once per change of reason per archer (walking, nothing in range), not every look.

**Tests:** 10 archers → one rank; `ranks: 2` → two; an archer walking to its slot shoots a foe in range; a foe 100
blocks from the archer is shot, one 130 away is not.

**Live (dev):** accuracy at 60–120 blocks against moving bots is unknown (hawkEye, then `bowAim`'s out-of-range
branch). Measure it: a `ligne-archers` facing a small `/bots raid` on the dev world; report hits per arrow by
distance. Don't tune blindly; report what you measured.

## F5 — A click doesn't take the order's bots back (D5)

**Seen:** Paul had to sneak + click (stop) and click again to get a working wall and line.

**Cause:** an `epee` (#220, bound to an arrow, until-stopped) reclaimed all 10 guards of the wall (#205) and all the
archers of the line (#207), and was never stopped; a guard also died. Later clicks on the wall were *delivered* to an
order with no bots: `OrderRunner.trigger` (`src/orders/runner.ts`) delivers to a listening order and never grants or
reclaims (docs/29 §5.4 item 6, "Nothing is stopped or reclaimed"). Paul stopped #205 and #207 (19:21:25, 19:21:27) and
started them again. Second case: a click with new args (rebinding `spacing=2` → `spacing=1`) is delivered with the old
args (#221 → #223).

**Fix (D5), in `trigger`, before delivering:**
- If the click's parsed args, `@bot` filters or take differ from the running order's, **restart** it (the
  not-listening path) instead of delivering.
- Otherwise, **top the order up**: plan its manifest roles again, as a start would (idle matching bots first, then,
  for `take: 'reclaim'` roles, the commander's busy ones), over the commander's bots not in the order, and grant them
  to the running order mid-run. Reuse the `squad.acquire` path (`Order.acquire`, `api/squad.ts`) rather than a new
  one; the four item commands already re-form on `squad.on('joined')`.
- A bot whose lease stack already holds this order below the top (lent to `epee`, a `tir`): **pop the orders above
  it** (they see it leave, reason `reclaimed`) so it returns to this order. Never push a second entry of the same order
  on a stack (`src/leases.ts`, depth 4).
- A taken-back bot returns to the order it came from when this order stops, as any reclaim (O4).
- Update docs/29 §5.4 item 6 and the overview's trigger section: a delivered click now grants.

**Tests (`triggers.test.ts` / `item-orders.test.ts`):** a wall whose guards an `epee` reclaimed gets them back on a
click, and `epee` goes on with its archers; an idle bot that was not in the order joins on a click; a click with other
args restarts the order with them; no duplicate stack entries.

## F6 — Bots drop their items when they die (D2)

**Fix (mod):** a roster bot drops nothing when it dies. Its inventory is simply lost: F7 resets it to the kit when the
bot comes back. Other players are unchanged (no `keepInventory` gamerule).
- Add a mixin at HEAD of `PlayerEntity.dropInventory()` that cancels it for a roster bot (`Squad.botNames()`, compared
  case-insensitively).
- Register it in `paulsbrawls.mixins.json`. `defaultRequire: 1` means a wrong target fails at startup.
- Check the target in the named jar, the intermediary jar and the generated refmap, as was done for
  `PersistentProjectileEntityMixin` (docs/system/squad/overview.md, "the mod").
- Nothing is copied to the respawned player. XP stays vanilla.

**Tests:** put the roster check in a Minecraft-free helper with a JUnit test. **Live (dev):** `/kill` a guard over
RCON; no item entities lie at its death spot.

## F7 — A dead bot disconnects until `/bots squad respawn` (D2, D3)

**Seen:** dead bots respawn at world spawn ("at base") and stand there idle.

**Now:** `bot.on('death')` (`src/bots/pool.ts`) emits `gone … died`, the runtime clears the bot's leases
(`leases.drop`), and mineflayer respawns it automatically at world spawn.

**Fix, the runtime:**
- On death the bot leaves its orders, as now. It is then **disconnected and marked dead** in the roster (`roster.ts`,
  `.squad-data/roster.json`; the runtime is its only writer).
- A dead bot is never reconnected: not by the reconnect backoff, not at boot, not by the deaf-bot watchdog.
- Suggested mechanism: let mineflayer respawn it, then quit once it has respawned. The server then saves it alive at
  world spawn with an empty inventory (F6), and the mod's existing first-join placement (`Squad.expectArrival`) works
  when it returns. If you choose otherwise, say why.
- The `state` event carries it (status `dead`); `/bots list` and `/bots status` show « mort ».
- **A new route**, e.g. `POST /api/bots/respawn { by, owner, kit?, n? }`, in `http/server.ts`:
  - it takes up to `n` of `owner`'s dead bots tagged `kit` (all of them when `n` is left out, and every dead bot of the
    owner when no kit is given);
  - it clears their `dead` mark and connects them, keeping the login stagger;
  - it answers with their names.

**Fix, the mod:**
- **A new command,** `/bots squad respawn [kit] [n] [owner=@s]`. It is admin-only, like `squad spawn` (O6), and works
  from a datapack function (`@s` = the player running it).
  - As in `SquadSpawn`, each bot is expected around the caller (`expectArrival` with a spot and a callback).
  - On arrival its **inventory is reset to its kit (D3)**, and its kit tag is kept.
  - The answer is in French, e.g. « [Bots] 7 gardes ramenés : Garde56, … » or « [Bots] Aucun garde mort. ».
- **The reset (D3):** add `Squad.resetToKit(srv, bot, kit)`. It clears the whole inventory (main, armor, off-hand),
  then gives the kit as `Squad.equip` does, so an archer comes back with its Infinity bow (F3).
  - The kit is the command's kit, else the bot's kit tag (`SquadKits.NAMES`).
  - A bot with no kit tag comes back with an empty inventory, and the answer says so (« sans kit »).
  - `Squad.equip` itself (`/bots equip`) is unchanged.
- **Plural kit names:** `guards`, `archers`, `miners` and `farmers` are accepted wherever a kit is (`squad spawn`,
  `squad despawn`, `squad respawn`, `equip`).

**Other rules:**
- Dead bots still count toward `limits.maxBots`.
- `/bots despawn`, `squad despawn` and `/bots raid clear` remove dead bots too.
- A raider that dies stays dead until `/bots raid clear`, so the enemy army shrinks.
- With F5, a respawned bot comes back idle, and the next click of a running wall or line takes it back.

**Docs:** docs/29 §4 (a death no longer brings the bot back idle) and §9 (commands), the overview, the command table
in `squad/README.md`, `SquadCommand`'s admin help line, and the Squad paragraph of `CLAUDE.md`.

**Tests:**
- **Runtime:**
  - a death makes the bot quit and marks it dead;
  - the mark survives a restart (roster reload), and neither the backoff nor the boot reconnects it;
  - the route reconnects up to `n` bots of the right kit and owner.
- **JUnit:** the plural names, and which kit a bot is reset to (Minecraft-free).
- **Live (dev):**
  1. Kill an archer and a guard over RCON (`kill`). Both disconnect and stay off.
  2. Run `execute as LiveCaptain at @s run bots squad respawn archers 1` over RCON. The archer comes back next to the
     captain, alive, with exactly its kit: an Infinity + Unbreaking III bow, 64 arrows, nothing else. The guard stays
     dead.

## When you are done

- `cd squad && npm run check` is green, and so is `./gradlew test` (F3, F6 and F7 change Java). Never run `./gradlew
  build`; use `remapJar` if a jar is needed.
- The live scenarios you added or touched pass on `dev/`. See docs/34 for `dev/squad.properties`; put `enabled=false`
  back afterwards, and stop the dev server with RCON `stop`.
- Make one commit per fix, in the repo's style, and push to `rework`.
- Tell Paul, for each fix:
  - what was wrong, what changed, and what you verified (fakes, live on `dev/`, or not run);
  - what he must restart on production: the runtime (`cd squad; npm start`) for F1–F5 and F7, the server
    (`./gradlew runServer`) for F3, F6 and F7. Don't restart production yourself.
  - that his existing archers keep their plain bows until they get the new one: a `/bots equip BOT archer` (the new
    bow goes in the hand, and `shoot` prefers it), or a death followed by `/bots squad respawn`.
