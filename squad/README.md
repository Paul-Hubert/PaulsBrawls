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
| `/bots equip BOT archer\|guard\|miner\|farmer` (admin) | the role's kit, worn and held (archer: chainmail, bow, arrows; guard: iron armor, iron sword, shield; miner: iron tools, torches; farmer: hoe, seeds, bone meal, water), and the role as the bot's tag |
| `/bots create NAME <what it should do>` | the agent writes it; you are told « Commande NAME prête » with `/bots order NAME` clickable |
| `/bots order NAME [args] [@bot …] [--reclaim\|--free]` | run it on your bots |
| `/bots stop [all \| #id \| NAME \| @bot]` | stop orders, or free one bot (it returns to the order it was reclaimed from) |
| `/bots fix NAME [what is wrong]` | rewrite it from its last run report |
| `/bots share NAME P…` / `unshare` / `delete` / `revert NAME V` | your commands are private until shared |
| `/bots list` · `orders` · `commands` · `show NAME` · `tag BOT +t -t` · `ticket NAME` | |
| `/bots status` | the runtime's load over the last 10 s: ELU, loop p99, the slowest bot's ticks/s |
| admin: `despawn BOT` · `owners BOT add\|remove P…` · `list all` · `stop all` | |

Stock commands everyone has: `come`, `follow`, `defend` (archers reclaimed, melee kept; threats within `radius` of
the commander, at most two guards per creature, each bot on its own spot around the commander), `gather`, `deposit`,
`attack`, `bring`.

Bots never hurt their own team: the mod cancels a bot's damage to a bot sharing an owner with it, or to one of its
owners. Everyone else (mobs, other players, other owners' bots) can be hit; PvP is on.

## A command

One ES module: `export const manifest = { summary, params, roles, duration }` and
`export default async function (squad, args, ctx)`. Full API: [reference/squad.d.ts](reference/squad.d.ts) (also
what the agent reads and what `check_script` typechecks against). Examples: [src/stock/](src/stock/).

## Check

```powershell
npm run check       # lint + tsc + node:test (fakes only, no Minecraft)
npm run bench:load  # the load benchmark (bench/README.md; never against production)
npm run live-test   # real bots on the dev server (run/); ports and RCON password read from its server.properties
$env:LIVE_PATH_WORKERS='4'; npm run live-test   # the same scenarios with 4 pathfinding workers
$env:SERVER_PROPERTIES='../server/server.properties'; npm run live-test   # the production server (world left as is)
```
