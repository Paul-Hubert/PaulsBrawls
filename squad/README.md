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

The server must be in offline mode (bots have no Microsoft accounts). `/bots spawn` whitelists the bot.

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

**Pathfinding workers (optional).** `squad.json`'s `pathfinding.workers` (default 0 = off, at most 16, capped at the
cores minus one) runs the bots' A* searches on that many worker threads, over a shared mirror of the world
([src/bots/pathworkers/](src/bots/pathworkers/)). The bots, their physics and the scripts stay on the main thread.
Searches the workers cannot take (unknown goals, exclusion areas, a dead or silent worker) run on the main thread as
before. Turn it on when the main thread is the limit (a slower PC, more bots): with 14 workers, 30 moving bots ran at a
main-thread ELU of 0.2-0.34 instead of 0.44-0.62 (two sites, so rough), but the process grew to about 9 GB at 30 gathering bots
(docs/31 §11.6).

**Watching the load.** The runtime samples its event loop every 10 s and logs one warning a minute at most when the
loop's p99 passes 250 ms or its ELU 0.9 (bots move in slow motion past that). `POST /api/metrics` returns the last
10 s: `loop { p50, p99, max }`, `elu`, `cpuPct`, `rssMb`, `heapMb`, `skippedPackets`, and per bot `ticksPerSec`, path
searches by outcome, path resets and deaf trips, plus `text`, the French line `/bots status` shows. One summary row
per minute goes to the `vitals` table of `.squad-data/squad.db` (kept 7 days).

## In game

| | |
|---|---|
| `/bots spawn BOT P1 [P2 …]` (admin) | a bot owned by those players; it appears next to the admin |
| `/bots raid [distance] [archers] [guards]` (admin, in game) | an enemy army (defaults: 200 blocks, 10 archers, 10 guards) owned by the virtual player `Envahisseur` appears on the ground that far ahead of you, equipped, and runs `raid` against you and your bots. `/bots raid stop` stops it, `/bots raid clear` despawns every raider. Mind `limits.maxBots` (above) |
| `/bots equip BOT archer\|guard\|miner\|farmer` (admin) | the role's kit, worn and held (archer: chainmail, bow, arrows; guard: iron armor, iron sword, shield; miner: iron tools, torches; farmer: hoe, seeds, bone meal, water), and the role as the bot's tag |
| `/bots create NAME <what it should do>` | the agent writes it; you are told « Commande NAME prête » with `/bots order NAME` clickable |
| `/bots order NAME [args] [@bot …] [--reclaim\|--free]` | run it on your bots |
| `/bots stop [all \| #id \| NAME \| @bot]` | stop orders, or free one bot (it returns to the order it was reclaimed from) |
| `/bots fix NAME [what is wrong]` | rewrite it from its last run report |
| `/bots share NAME P…` / `unshare` / `delete` / `revert NAME V` | your commands are private until shared |
| `/bots list` · `orders` · `commands` · `show NAME` · `tag BOT +t -t` · `ticket NAME` | |
| `/bots orders bind NAME [args] [@bot …] [--reclaim\|--free]` (anyone) | binds the item in your main hand to that order, checked like `/bots order`; the item gets a glint and a lore line « Ordre : NAME args ». Then **right-click** it to start the order on your bots, or, while it runs, re-aim it where you look (an order that does not listen for clicks restarts); **sneak + right-click** stops it. A bound **bow or crossbow** gives the order with each arrow you shoot (when it leaves, then where it lands), not with the right-click. At most 4 clicks a second count. Given to another player, the item orders *their* bots, if the command is one they may use |
| `/bots orders unbind` · `/bots orders bound` | remove the held item's binding (its lore line and glint go too); list the bound items in your inventory |
| `/bots status` | the runtime's load over the last 10 s: ELU, loop p99, the slowest bot's ticks/s |
| admin: `despawn BOT` · `owners BOT add\|remove P…` · `list all` · `stop all` | |

Stock commands everyone has: `come`, `follow`, `defend` (archers reclaimed, melee kept; threats within `radius` of
the commander, at most two guards per creature, each bot on its own spot around the commander), `gather`, `deposit`,
`attack`, `bring`, `raid` (an army marches on a point in formation behind a leader, melee ahead of the archers, fights
any enemy within `radius` of the leader on the way, then hunts the `target` player and their bots; it ends after
`quiet` seconds, default 60, without an enemy player).

Four stock commands are made for bound items (`/bots orders bind NAME`, docs/29 §5.4; e.g. a shield in hand,
`/bots orders bind mur-de-boucliers spacing=2`); each click re-aims the running order where you look, without
restarting it:
- `mur-de-boucliers` (a shield): the guards with a shield line up across your view at the block you look at (or 5
  blocks ahead), face along it and raise their shields once there; they fight what comes within `reach` (4) of their
  slot, then go back. Params `distance` 24, `spacing` 1, `reach` 4.
- `epee` (a sword): looking at a creature or an enemy, the archers shoot it and two guards fight it (the others fight
  what is near it) until it is dead or `seconds` (60) pass; looking at the ground, the bots hold that spot (rings of 3
  and 6 around it); looking at the sky or a friend, they defend you. Params `radius` 16, `seconds` 60.
- `ligne-archers` (an arrow, right-click): the archers line up across your view, `back` (4) blocks short of the point,
  in two ranks past 8, and shoot what comes within `range` (24) of the line, from their slots. Params `distance` 24,
  `spacing` 2, `back` 4, `range` 24.
- `tir` (a bow): the archers shoot where your arrow went, from where they stand: the creature it hit until it is dead or
  `seconds` (8) pass, or a volley of `volley` (3) arrows each spread over `spread` (3) blocks around where it landed.
  It ends after that; archers it took from a `ligne-archers` go back to their slots there.

Bots never hurt their own team: the mod cancels a bot's damage to a bot sharing an owner with it, or to one of its
owners. Everyone else (mobs, other players, other owners' bots) can be hit; PvP is on. A script's friends (`isFriend`)
are the same team: the commander, the co-owners of the order's bots, and the bots sharing an owner with them. Another
player's bots are enemies, so two armies fight.

## A command

One ES module: `export const manifest = { summary, params, roles, duration }` and
`export default async function (squad, args, ctx)`. Full API: [reference/squad.d.ts](reference/squad.d.ts) (also
what the agent reads and what `check_script` typechecks against). Examples: [src/stock/](src/stock/).

**Orders given with a bound item** (`/bots orders bind`, docs/29 §5.4). Using the item starts the order, with
`ctx.commander.at.trigger` (`use`, or a bow's `arrow-release` then `arrow-hit`). A later click restarts it, unless the
script listens with `ctx.commander.on('trigger', at => …)` or `await ctx.commander.next(ms)`. A listening order is
re-aimed instead: each click replaces `ctx.commander.at`, and nothing is stopped or reclaimed. The mod asks the runtime
on `POST /api/orders/check` (bind) and `POST /api/orders/trigger` (each click; `stop: true` for sneak + right-click).

## Check

```powershell
npm run check       # lint + tsc + node:test (fakes only, no Minecraft)
npm run bench:load  # the load benchmark (bench/README.md; never against production)
npm run live-test   # real bots on the dev server (run/); ports and RCON password read from its server.properties
$env:LIVE_PATH_WORKERS='4'; npm run live-test   # the same scenarios with 4 pathfinding workers
$env:SERVER_PROPERTIES='../server/server.properties'; npm run live-test   # the production server (world left as is)
$env:LIVE_ONLY='items'; $env:LIVE_RUNTIME_PORT='8779'; npm run live-test   # only the bound-item scenarios (below)
```

`LIVE_ONLY=core` runs the first scenarios (connect, `gather`, `come`, reclaim, ladders, despawn), `LIVE_ONLY=items`
the bound-item ones (`live-tests/items.ts`, dev world only): the four item commands, `/bots orders bind` with real
clicks and arrows, and a guard coming back to `defend` after a wall. The test's runtime listens on `LIVE_RUNTIME_PORT`
(default: any free port). The scenarios driven through the mod need the dev server's mod to talk to that runtime, and
never to the real one on 8772. Before `./gradlew runServer`, create `run/squad.properties`:

```properties
enabled=true
url=http\://127.0.0.1\:8779
token=live-test-token
```

Then run with `LIVE_RUNTIME_PORT=8779`, and make sure `PAULSBRAWLS_SQUAD_TOKEN` is not set (it overrides the token on
both sides). Without them those scenarios are skipped. Delete `run/squad.properties` afterwards. The mod also adds the
test bots to `run/whitelist.json`; `git checkout -- run/whitelist.json` restores it.
