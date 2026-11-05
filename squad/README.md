# Squad — player-owned Mineflayer bots, ordered by LLM-written commands

Design: [docs/29-squad-design.md](../docs/29-squad-design.md). The mod side is `src/main/java/com/paul/brawl/squad/`.

```
Player ─/bots…─▶ the mod (thin front) ──HTTP + SSE──▶ squad runtime (this folder, one Node process, :8772)
                                                       ├ the bots (mineflayer), the roster, leases, orders
/bots create ──▶ squad-author agent (claude -p) ──MCP──┤ check_script / trial_run / submit_command
                                                       └ commands (.squad-data/commands), journal (squad.db)
```

## Run it

```powershell
cd squad
npm install
cp squad.example.json squad.json     # gitignored; minecraft host/port, the token (or PAULSBRAWLS_SQUAD_TOKEN)
npm start                            # the supervisor + the runtime (restarts it if a script wedges it)
```

The mod reads `squad.properties` in the server's working directory (generated at first start):

| Key | Default | |
|---|---|---|
| `url` | `http://127.0.0.1:8772` | the runtime |
| `token` | generated | must equal the runtime's (`PAULSBRAWLS_SQUAD_TOKEN` wins on both sides) |
| `agentKind` | `claude-code` | or `opencode` (`opencode serve` on `agentUrl` with `agent/opencode.json`) |
| `claudeBin`, `claudeDir` | `claude`, `squad/agent/claude-code` | the agent directory (use an absolute path when the server runs elsewhere) |
| `claudeModel`, `claudeEffort` | Claude Code's defaults | |
| `authorTimeoutSeconds`, `maxAuthoring` | 900, 2 | |
| `joinGate`, `allowedBotAddresses` | true, loopback | a bot's name joining from elsewhere is kicked |
| `kitStaggerMs` | 100 | ms between two kits given (`/bots squad spawn`, `/bots raid`, `/bots equip`): one at a time, like the logins; 0 = at once |

The server must be in offline mode (bots have no Microsoft accounts). `/bots spawn` whitelists the bot.

**Logins.** `squad.json`'s `loginStaggerMs` (default 100) spaces the bots' logins: one at a time, at least that many
ms apart, whether they come from the boot, a spawn or a reconnect. Every login receives its chunks at once, so
logins all together stall the runtime (40 at once: up to 1.1 s, docs/36 §6). At 100 ms, 40 logins still stalled it
up to 1.6 s: each one decodes ~0.4 s of chunks, so a stall-free login needs ~0.4–0.5 s between bots (est.).

**How many bots.** `squad.json`'s `limits.maxBots` (default 30, as in `squad.example.json`) caps the roster, every
owner together. Twenty defenders against a 20-bot `/bots raid` need 40: set `"limits": { "maxBots": 40 }` (or more)
in `squad.json` and restart the runtime. Up to 30 moving bots were measured (docs/31 §11), not more.

**Patched dependencies.** `npm install` runs `patch-package` (postinstall), which applies [patches/](patches/) to
`node_modules`: the library hot spots of [docs/31](../docs/31-squad-performance-review.md) §3.3 (prismarine-physics'
`PlayerState` requires, minecraft-protocol's packet framing, mineflayer-pathfinder's look-ahead, A* block lookups and
"stuck" timer) plus an optional A* budget. A patch that no longer applies fails the install (`--error-on-fail`), and
`tests/patches.test.ts` fails if one is missing. `patch-package` is a runtime dependency, so `npm install --omit=dev`
applies them too. To change a patch: edit the file in `node_modules`, then `npx patch-package <package>`.
`squad.json`'s `pathfinding.astarBudgetMs` (default 20, 0 = off, at most 50) caps the A* time of all bots together per
50 ms window: measured better than no cap at 10-30 moving bots (docs/31 §11).

**Reader workers ([docs/37](../docs/37-squad-worker-reads-plan.md), on by default).** The job pool of [src/jobs/](src/jobs/):
read-only calculations run on worker threads, in batches, each worker with a CPU budget per 50 ms tick. Since P4 the
bots' **A* searches** run there, over the shared world below (a search first gets 3 ms on the main thread: most of
gather's end there and are answered at once, the long ones move to a worker). A worker costs ~60 MB: its heap is
sized (16 MB young, 512 MB old), or A*'s garbage grew it by hundreds of MB. The bots, their physics, the look-ahead and the
scripts stay on the main thread. This replaced docs/32 D's pathfinding worker pool, whose workers each parsed their
own copy of every chunk (about 9 GB at 14 workers and 30 gathering bots, docs/31 §11.6): now every worker reads the
one copy in shared memory. Job types: `path` (A*, P4), `findBlocks` (P6), `aim` (P3, below) and `echo` (P2's trivial one). On by default with as
many workers as allowed (docs/37 D7, 2026-11-02); `"count": 0` turns them off:

| Key in `squad.json` | Default | |
|---|---|---|
| `workers.count` | 32 | reader worker threads, an integer up to 32 (0 = off), capped at the hardware threads (a capped default is logged as info, not a warning). `pathfinding.workers`, the old pool's key, is an alias: it is read when `workers.count` is not set; when both are set, `workers.count` wins |
| `workers.tickBudgetMs` | 40 | each worker's CPU budget per 50 ms tick (above 0, at most 50). A worker stops its batch when it is spent; what it did not start goes back to the queue. Searches share it: one search alone on a worker computes up to 40 ms a tick |

With `workers.count` > 0 the shared world is on too (`world.enabled` defaults to true then), the dispatcher ticks on
one online bot's physics ticks (a self-correcting 50 ms timer when none is online), and, on the ticks it hands out an
aim job, it publishes a snapshot of every entity the bots know into shared memory (kept up from the bots' entity
events, not walked each tick). A search pending on a worker carries on over a block change next to the bot (the
plugin's `block_updated` reset) when every step of its path near the changes still holds; any path a worker sends is
checked the same way, and searched again if a change broke it (docs/37 §14). A search runs on the main thread as before when the workers cannot take
it: an unknown goal class, exclusion areas, a subclassed `Movements`, a column the store does not hold yet, no live
worker (every slot crashed 3 times in a minute), a failed job, or no sign of life for `thinkTimeout` + 2 s. `POST
/api/metrics` shows the job pool (`jobs`) and the searches (`paths`: offloaded, answered, cancelled, fallbacks by
reason; `carried` over resets and `notCarried` by why; `stale` worker paths). Gather mines fewer logs with the workers
than without (docs/37 §14.2; 43 % fewer at 30 bots with 32 workers, §15): part of the main thread's lead comes from the plugin giving a hard target up at once
when the A* budget is spent.
**Shared world ([docs/37](../docs/37-squad-worker-reads-plan.md) P1, P5, on by default).** `squad.json`'s `world` block
builds one copy of the chunks the bots receive, in shared memory ([src/world/](src/world/)). One writer thread decodes
it from the bots' packets, and any thread can read it lock-free. The reader workers read the store (A* since P4).
With `world.shared` the bots read it too: `bot.world` is a view of the store (`bot-world.ts`, through a replacement of
mineflayer's blocks plugin, `blocks-plugin.ts`), so no bot keeps ~313 parsed columns of its own or parses a chunk:
each one is decoded once, on the writer thread. A bot sees only the columns it holds, once the writer has published
them (a few ms after the packet; `waitForChunksToLoad` waits for that); the block changes it hears show at once. Light
and biomes are not kept (nothing reads them: a block's light is 0, its biome the first). With `"shared": false` the
bots keep their own worlds, as before. Measured: 30–36 MB less RSS per bot, and 40 logins no longer stall the
event loop (docs/37 §13.4).

| Key in `squad.json` | Default | |
|---|---|---|
| `world.enabled` | on with the reader workers (`workers.count` > 0) or `world.shared`, so on by default | build the store (a writer thread, ~70 MB for 850 columns). `false` with workers on keeps A* on the main thread (a warning at start) |
| `world.cacheSeconds` | 60 | a column no bot holds any more is kept this long, unreadable, in case a bot receives it again (no decode then) |
| `world.cacheColumns` | 2000 | at most this many such columns, oldest dropped first |
| `world.verify` | `false` | once a second, compare 256 random blocks of the store with the bots' own worlds and log mismatches (debug; nothing to compare with `world.shared`) |
| `world.shared` | `true` (`false` when `world.enabled` is set to `false`) | the bots read the store instead of keeping their own worlds (docs/37 P5). Turns `world.enabled` on; `"shared": true` with `"enabled": false` is an error |

`npx tsx live-tests/probe-world.ts` (dev server only) checks it block for block against six real bots.

**Block searches on the workers ([docs/37](../docs/37-squad-worker-reads-plan.md) P6, on by default).** With both
`workers.count` > 0 and `world.enabled`, `mineBlock` (so `gather`) finds its blocks with a `findBlocks` job: mineflayer's
`bot.findBlocks` read from the shared world on a reader worker, the same positions in the same order, in about 0.1 ms
instead of mineflayer's 15 ms on the main thread ([src/api/block-search.ts](src/api/block-search.ts)). Nothing else to
set. A search is never given up for being slow: it goes on on the workers, tick after tick, until it answers. One the
store cannot answer for that bot (not logged in, its column not in the store yet, the job failed) runs on the bot as
before. `findBlock` stays synchronous on the bot's own world (with
`world.shared`, the store's search on the main thread, over that bot's columns). With either key off,
every search is `bot.findBlocks`, as before.

**The archers' aim ([docs/37](../docs/37-squad-worker-reads-plan.md) P3, [src/aim/](src/aim/)).** `shoot` aims
with Squad's own solver (hawkEye is gone): Minecraft 1.21.1's arrow, the target led along its velocity, the line of
fire checked against blocks and every creature's hitbox (an enemy in the line counts as a hit; a friend blocks, and
the draw waits up to 1 s for it to step out before « no clear line of fire »), the low arc first, the high arc over a
wall. Solved again on the draw ticks of `aim.schedule`, the look
turning smoothly between the answers, the release on tick `aim.drawTicks`. With `workers.count` > 0 **and**
`world.enabled`, each update is an `aim` job on the reader workers (they see blocks only through the shared world);
otherwise it is solved on the main thread over the bot's own world (~50–70 µs a solve).

| Key in `squad.json` | Default | |
|---|---|---|
| `aim.schedule` | `[0, 10, 11, 12, 13, 14, 20, 21, 22, 23]` | the draw ticks whose aim is solved anew: the start, 500 ms in, the middle four, the four before the release. Increasing integers from 0, each below `aim.drawTicks` |
| `aim.drawTicks` | 24 | the bow's release tick (1.2 s; at least 21: a bow reaches full power after 20 server ticks) |
| `aim.overFriends` | `true` | a friend in the line is lobbed over on the high arc (docs/37 D6). `false`: a friend blocks the shot, so more shots are refused (19–32 % in a 20 v 20 fight) but each arrow kills more often and fewer arrows are in the air (docs/37 §11.6) |

**Watching the load.** The runtime samples its event loop every 10 s and logs one warning a minute at most when the
loop's p99 passes 250 ms or its ELU 0.9 (bots move in slow motion past that). `POST /api/metrics` returns the last
10 s: `loop { p50, p99, max }`, `elu`, `cpuPct`, `rssMb`, `heapMb`, `skippedPackets`, and per bot `ticksPerSec`, path
searches by outcome, path resets and deaf trips, plus `text`, the French line `/bots status` shows. With the reader
workers on, it also has `jobs`: `workers`, `alive`, `restarts`, `budgetMs`, `tick`, `tickSource` (`bot` or `timer`),
`ticks`, `queue`, `queueMax`, `inFlight`, `answered`, `dispatchMs { mean, max }` (the dispatcher's own main-thread time
per tick), `entities { count, published, skipped, overflow, writeMs, followed }` (the snapshot: written only for aim jobs; `writeMs` its main-thread time, `followed` the bots it follows), `inline { loaded, budgetMs, batches, usedMs }`, per job
type `types.<type> { submitted, done, carried, continued, late, failed, inline, retried, cancelled, latencyMs { p50,
p95 }, costMs }` and per worker `perWorker[] { index, alive, ready, disabled, restarts, batches, jobs, budgetMs { mean,
max } }` (budget use in ms per tick); `text` then ends with « calculs : 3/4 workers, file 12, p95 75 ms, … ». One
summary row per minute goes to the `vitals` table of `.squad-data/squad.db` (kept 7 days), with the jobs' minute in
`data.jobs`.

## In game

| | |
|---|---|
| `/bots spawn BOT P1 [P2 …]` (admin) | a bot owned by those players; it appears next to the admin; `@s` = whoever runs it (also inside a datapack function) |
| `/bots raid [distance] [archers] [guards]` (admin, in game) | an enemy army (defaults: 200 blocks, 10 archers, 10 guards) owned by the virtual player `Envahisseur` appears on the ground that far ahead of you, equipped, and runs `raid` against you and your bots. `/bots raid stop` stops it, `/bots raid clear` despawns every raider. Mind `limits.maxBots` (above) |
| `/bots equip BOT archer\|guard\|miner\|farmer` (admin) | the role's kit, worn and held (archer: chainmail, a bow with Infinity and Unbreaking III, 64 arrows; guard: iron armor, iron sword, shield; miner: iron tools, torches; farmer: hoe, seeds, bone meal, water), and the role as the bot's tag; you also become one of its owners |
| `/bots create NAME <what it should do>` | the agent writes it; you are told « Commande NAME prête » with `/bots order NAME` clickable |
| `/bots order NAME [args] [@bot …] [--reclaim\|--free]` | run it on your bots |
| `/bots stop [all \| #id \| NAME \| @bot]` | stop orders, or free one bot (it returns to the order it was reclaimed from) |
| `/bots fix NAME [what is wrong]` | rewrite it from its last run report |
| `/bots share NAME P…` / `unshare` / `delete` / `revert NAME V` | your commands are private until shared |
| `/bots list` · `orders` · `commands` · `show NAME` · `tag BOT +t -t` · `ticket NAME` | |
| `/bots orders bind NAME [args] [@bot …] [--reclaim\|--free]` (anyone) | binds the item in your main hand to that order, checked like `/bots order`; the item gets a glint and a lore line « Ordre : NAME args ». Then **right-click** it to start the order on your bots, or, while it runs, re-aim it where you look (an order that does not listen for clicks restarts); **sneak + right-click** stops it. A bound **bow or crossbow** gives the order with each arrow you shoot (when it leaves, then where it lands), not with the right-click. At most 4 clicks a second count. Given to another player, the item orders *their* bots, if the command is one they may use |
| `/bots orders unbind` · `/bots orders bound` | remove the held item's binding (its lore line and glint go too); list the bound items in your inventory |
| `/bots status` | the runtime's load over the last 10 s: ELU, loop p99, the slowest bot's ticks/s |
| admin: `despawn BOT` · `despawn all` (every bot) · `owners BOT add\|remove P…` · `list all` · `stop all` | |
| `/bots squad spawn archer\|guard\|miner\|farmer [n=5] [owner=@s] [others…]` (admin) | a ready squad: `n` bots of that kit around the owner, equipped on arrival, owned by the owner and the others. `/bots squad despawn [kit] [owner=@s]` removes the owner's bots of that kit (all of them without a kit, dead ones too). Both work from a datapack function (`@s` = the player running it). Kits may be plural (`guards`, `archers`…) |
| `/bots squad respawn [kit] [n] [owner=@s]` (admin) | a bot that dies drops nothing, disconnects and stays offline (« mort » in `/bots list`); this brings back up to `n` of the owner's dead bots of that kit (all, of every kit, without them) around you, each with exactly its kit again: `/bots squad respawn guards 10`. From a datapack function too |

Stock commands everyone has: `come`, `follow`, `defend` (archers reclaimed, melee kept; threats within `radius` of
the commander, at most two guards per creature, each bot on its own spot around the commander), `gather`, `deposit`,
`bring`, `raid` (an army marches on a point in formation behind a leader, melee ahead of the archers, fights any
enemy within `radius` of the leader on the way, then hunts the `target` player and their bots; it ends after `quiet`
seconds, default 60, without an enemy player), and the two item commands below.

**Mounted bots** (docs/41): the `horseman` and `horsearcher` kits ride a horse, and every command drives it (the bot's
body walks as on foot; its moves go to the server as the horse's). A horse is 1.4 wide: it does not pass a door or a
1-wide gap.

**Squads and the selector** (docs/40). Each `/bots squad spawn` is one squad: its bots carry the tag `esc-N` (N new
for each spawn; « Escouade 3 prête »). Bind a selector to any item, `/bots orders bind select`: a right-click on one of
your bots (as far as you can see) selects its squad (« Escouade 3 sélectionnée : Archer01, Garde01 (2 bots). »); a
right-click on nothing deselects. Every bound item's click then orders the selected squad only, and each squad keeps
its own order of a command: squad 1 holds a `line` while squad 2 `attack`s. With no squad selected a bound item's
click answers « Aucune escouade sélectionnée. » and does nothing. `/bots order` uses the selected squad too, and all
your bots when none is selected. Bots spawned otherwise (`/bots spawn`) have no squad and cannot be selected.

Two stock commands aim where you point (`/bots orders bind NAME`, docs/29 §5.4; e.g. a shield in hand,
`/bots orders bind line spacing=2`); each click re-aims the running order without restarting it. **Any item can carry
either** (a shield, a sword, a bow, a stick): a click says where you point, the same way for every item and from
`/bots order` too. Where you point: your arrow's hit (a bow), else the creature or the block in your crosshair. The
target there: that creature, else the nearest one within `near` (4) blocks of the point. A bow's arrow-release waits
for its hit (a release does not move a formation; its hit does).
- `line` (once `mur-de-boucliers` and `ligne-archers`): the guards (a shield) form a straight shield wall across your
  view where you point (or 8 blocks ahead when that is too far or the sky), face along it and raise their shields; the
  archers (a bow) line up `back` (4) blocks behind the wall, in `ranks` (1) ranks, and shoot what comes within
  `range` (120) of each archer, from where they stand, over the wall. A guard goes after nobody: hit in melee, it hits
  back once (at most `reach` (4) from its slot), then raises its shield again. Bots with neither (horsemen) hold the
  wall's flanks, 2 blocks apart, and hit back the same way. Each bot paths to within 2 blocks of its slot, then walks
  straight onto its exact place and stops there (no crouch walk, docs/43), on foot or on a horse. A guard walks there
  facing the wall's direction with its shield up, at walking speed: a re-formed wall sidesteps or falls back behind
  its shields, never showing its back (docs/49). Until stopped. Params `distance` 24,
  `spacing` 1 (guards), `archerSpacing` 2, `back` 4, `range` 120, `ranks` 1 (1–3), `reach` 4. `reserve` (0): that many
  melee bots stand `back` + 3 behind the wall instead of on its flanks, counter-attack what comes within `reach` + 8 of
  it (a subroutine `attack` on the wall's point) and come back (docs/45).
- `attack` (once `epee` and `tir`): a creature or an enemy where you point: the archers shoot it from where they
  stand, two melee bots fight it and the others fight what is near it, until it is dead or `seconds` (60) pass; only
  the ground: each archer fires a volley of `volley` (3) arrows spread over `spread` (3) blocks around the point,
  the melee bots take a ring of 3 around it and fight what comes within `radius` (16); the sky: « Aucune cible. »; a
  friend: refused. It ends by itself (the target down; the volley fired and the point clear), and bots it took from a
  `line` go back to their slots there. `approach` (0): an archer farther than that from its foe walks closer first.
- `flank` (docs/45): a creature or an enemy where you point: the squad goes round it at `radius` (24) to its `side`
  (`left`, `right`, or `rear` by way of `via`; relative to the way it moves, else to the way from the squad to it),
  then runs `attack` on its group from there. Ends with that attack.

Bots never hurt their own team: the mod cancels a bot's damage to a bot sharing an owner with it, or to one of its
owners. Everyone else (mobs, other players, other owners' bots) can be hit; PvP is on. A script's friends (`isFriend`)
are the same team: the commander, the co-owners of the order's bots, and the bots sharing an owner with them. Another
player's bots are enemies, so two armies fight.

## A command

One ES module: `export const manifest = { summary, params, roles, duration }` and
`export default async function (squad, args, ctx)`. Full API: [reference/squad.d.ts](reference/squad.d.ts) (also
what the agent reads and what `check_script` typechecks against). Examples: [src/stock/](src/stock/).

**Formations and fights** (docs/43): `lineUp` gives each bot an exact slot on the ground by where it stands,
`approach` walks it there and stops it on the place, `squad.crew` runs one loop per bot (restarted for a bot that
comes back, never spinning), `targets()` shares the threats among a role's bots, `melee` never starts a fight that
breaks off at once. `line`, `attack` and `raid` are written with them. **Subroutines**: `ctx.run(name, args, { bots,
until })` lends those bots to another command while it runs (they leave your loops, `left` reason `lent`) and gives them
back to their role when it ends: a line lending its melee to `attack` and getting them back is
[tests/fixtures/commands/charge.mjs](tests/fixtures/commands/charge.mjs).

**Orders given with a bound item** (`/bots orders bind`, docs/29 §5.4). Using the item starts the order, with
`ctx.commander.at.trigger` (`use`, or a bow's `arrow-release` then `arrow-hit`). A later click restarts it, unless the
script listens with `ctx.commander.on('trigger', at => …)` or `await ctx.commander.next(ms)`. A listening order is
re-aimed instead: each click replaces `ctx.commander.at`, and takes back the order's bots (the ones another order
borrowed, and idle ones its roles want: they join it). A click whose args differ from the running order's (a rebind)
restarts it with them. The mod asks the runtime
on `POST /api/orders/check` (bind) and `POST /api/orders/trigger` (each click; `stop: true` for sneak + right-click).

## Check

```powershell
npm run check       # lint + tsc + node:test (fakes only, no Minecraft)
npm run bench:load  # the load benchmark (bench/README.md; never against production)
npm run bench:jobs  # the job pool's own overhead: latency, dispatch cost, the entity snapshot (no server)
npm run bench:find-blocks  # block searches: mineflayer's findBlocks against the shared world's, and as a job (no server)
npm run live-test   # real bots on the dev server (dev/, ./gradlew runDevServer); ports and RCON password read from its server.properties
$env:LIVE_WORKERS='4'; npm run live-test   # the same scenarios with 4 reader workers and the shared world (A*, gather's search, the aim)
$env:LIVE_WORLD_SHARED='1'; npm run live-test   # the bots read the shared world (world.shared, docs/37 P5); with or without LIVE_WORKERS
$env:SERVER_PROPERTIES='../run/server.properties'; npm run live-test   # the production server (run/; world left as is)
$env:LIVE_ONLY='items'; $env:LIVE_RUNTIME_PORT='8779'; npm run live-test   # only the bound-item scenarios (below)
```

`LIVE_ONLY=core` runs the first scenarios (connect, `gather`, `come`, reclaim, ladders, despawn), `LIVE_ONLY=items`
the bound-item ones (`live-tests/items.ts`, dev world only): the four item commands, `/bots orders bind` with real
clicks and arrows, any item carrying any order (written for the four commands `line` and `attack` replaced: **not yet ported**, docs/40), and a guard coming back to `defend` after a wall. The test's runtime listens on `LIVE_RUNTIME_PORT`
(default: any free port). The scenarios driven through the mod need the dev server's mod to talk to that runtime, and
never to the real one on 8772. Before `./gradlew runDevServer`, set `dev/squad.properties` (it holds `enabled=false`):

```properties
enabled=true
url=http\://127.0.0.1\:8779
token=live-test-token
```

Then run with `LIVE_RUNTIME_PORT=8779`, and make sure `PAULSBRAWLS_SQUAD_TOKEN` is not set (it overrides the token on
both sides). Without them those scenarios are skipped. Another port (a dev server of one's own): the same port in
`dev/squad.properties`, `LIVE_RUNTIME_PORT` and `LIVE_MOD_PORT`. Set `enabled=false` in `dev/squad.properties` afterwards.
