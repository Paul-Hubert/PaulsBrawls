# 29 — Squad: player-owned Mineflayer bots, ordered by LLM-written scripts (design)

> Status: **built and in use on the production server (2026-10-29).** As built: [docs/system/squad/overview.md](system/squad/overview.md).
> `squad/` passes `npm run check` (61 tests); the mod's `com.paul.brawl.squad` has 15 JUnit tests. Live on `server/`:
> spawn, `equip`, `follow`, `attack`, `defend` (with reclaim and return), `come` and `gather` ran on real bots. Not run
> yet with a real model: `/bots create`, `fix`, `trial_run`, `ticket`. Of §15, the hawkEye and checkJs-noise items are
> answered (§16); capacity, the chat-spam threshold and async attribution live are still open. Where the code differs from this design, §16 says how. The new system lives in its own folder, `squad/`; the mod only gets
> a thin `/bots` front in its own package. **Eden is dead code**: nothing is built inside it or kept in step with
> it. The Eden pieces worth having are **copied** into `squad/` (§3) and owned there from then on.

## 0. Summary

- An admin spawns bots and gives each one owners: `/bots spawn BOTNAME P1 [P2 …]`. A bot is a real Mineflayer
  player, connected by the **squad runtime**, one Node process in `squad/`.
- Any player writes `/bots create NAME <what it should do>`. The mod runs one turn of an external coding agent
  (`squad-author`, Claude Code). The agent writes a **squad command**: one JavaScript file that controls *all* the
  bots it is given. It checks the file, test-runs it on the player's idle bots, and submits it. Then the player is told
  **« Commande NAME prête — /bots order NAME »**.
- `/bots order NAME [args] [@bot …]` runs the command on the player's bots. **One order = one program controlling
  N bots.** The bots are the actuators of one controller, so cooperation inside an order is ordinary single-threaded
  JavaScript.
- The script API is the one LLMs write best (§5): **the real mineflayer `bot`**, its usual plugins, **Voyager's
  primitives under Voyager's names**, and a small `squad` layer: roles, `parallel`, a work queue, claims.
- Bots are shared between co-owners. A command's manifest declares **roles** (for example archers and melee).
  An order can **reclaim** busy bots role by role: the archers are pulled off their previous order while the melee
  bots stay on it. When the new order lets go of them, they go back to their old order (§6).
- Players are whitelisted and trusted: **no sandbox**. The runtime still guards *robustness*: a stuck loop, a
  leaked listener or two orders driving one body. Grief and PvP are **on**, with no vetoes.
- Commands are **private** to their author. `/bots share NAME P1 [P2 …]` lets other players order them.

## 1. Owner decisions (2026-10-26, do not relitigate)

| # | Decision |
|---|---|
| O1 | Players are whitelisted and trusted. **No sandbox.** Scripts get the real mineflayer bot. |
| O2 | The script API is chosen for LLM code-writing quality, not for safety. |
| O3 | Commands are private; `/bots share NAME P1 [P2 …]` grants others the right to order them. |
| O4 | Co-owners can preempt: an order reclaims busy bots as its script demands, per role. Bots not reclaimed stay on their previous order. |
| O5 | Grief and PvP are on. No protected regions, no target vetoes. |
| O6 | Only an admin spawns bots and sets their owners. |
| O7 | Eden is dead code. Useful Eden code is **duplicated** into `squad/`, never imported, never maintained in `eden/`. The whole new system is in `squad/`. |

## 2. Topology

```
 Player ─/bots…─▶ Fabric mod (thin front, package com.paul.brawl.squad)
                  ├ SquadCommand    Brigadier /bots, permissions, arg pre-parse, tab completion
                  ├ CommanderSnap   who ordered + where they stand/look (main thread)
                  ├ SquadMembers    whitelist entries, join gate, never op
                  ├ SquadAuthoring  one AgentBackend turn per /bots create|fix (reuses AgentTurns machinery)
                  ├ SquadClient ──── HTTP + bearer ─────────▶  squad runtime  (Node, squad/, 127.0.0.1:8772)
                  └ SquadEvents ◀─── SSE /events ───────────   ├ Roster      bots, owners, tags         (single writer)
                                                               ├ BotPool     mineflayer connections
 squad-author agent (claude -p, squad/agent/)                  ├ Leases      lease stacks, roles, reclaim
   └── MCP /mcp/squad + ticket ─────────────────────────────▶  ├ Orders      compile, run, supervise, report
                                                               ├ Store       commands, versions, shares
                                                               ├ Journal     SQLite: orders, reports
                                                               └ Supervisor  parent process: heartbeat, restart
```

- **The runtime owns all squad state** (roster, owners, tags, commands, shares, leases, reports). The mod
  stores none of it. It keeps an in-memory cache, fed by SSE, for tab completion and the join gate.
  Single writer per state: roster changes are API calls to the runtime.
- **The mod owns what only the server can do:** the player's identity and permission level, the commander's
  exact position and look target, whitelist entries, kicking an impostor, teleporting a new bot to the admin,
  chat with click events, and starting agent turns (the hard-won `ClaudeCodeClient` is reused, not rewritten).
- **One runtime process for all bots.** A script needs the real `bot` objects in its own JS realm, and a bot can
  move between orders mid-run (§6). Worker threads or processes per order would mean reconnecting a bot to
  reassign it. The risk of one process is a wedged event loop, which §7.3 handles.
- **Port 8772**, loopback only, one HTTP server: `/api/*` (mod control), `/events` (SSE to the mod),
  `/mcp/squad` (authoring tools). Bearer token `PAULSBRAWLS_SQUAD_TOKEN`, generated into `squad.properties` on
  first run when unset, like `mcpToken`. The port joins the registry in CLAUDE.md.
- If the runtime is down, every `/bots` command answers `[Bots] Le runtime des bots est injoignable.`, and the
  server is otherwise unaffected.

## 3. Layout

```
squad/
  package.json  tsconfig.json  squad.example.json        (squad.json gitignored)
  src/
    main.ts               the only composition root (plain constructor args, no DI)
    supervisor.ts         parent process: spawns main, heartbeat watchdog, restart with backoff
    config.ts  logger.ts
    bots/      pool.ts  hardening.ts  plugins.ts  signals.ts          ← duplicated from eden/src/bots
    roster.ts  leases.ts
    orders/    runner.ts  guard.ts (lease-guarded bot proxy)  report.ts
    script/    compile.ts (loop budget + scope globals) ← duplicated from eden/src/skills/instrument.ts
               check.ts   (parse + typecheck)            manifest.ts
    api/       squad.ts   commander.ts  errors.ts
               helpers/   Voyager primitives             ← duplicated from eden/src/skills/exemplars
               squad.d.ts the documented surface (source of the prompt's API reference)
    store/     commands.ts  shares.ts
    journal/   journal.ts  lag-monitor.ts                ← duplicated from eden/src/journal
    http/      api.ts  events.ts  mcp.ts
  agent/
    claude-code/  .mcp.json  settings.json  .claude/agents/squad-author.md
    prompts/      squad-author.md  exemplars/*.mjs (full-code examples, also run as tests)
  tests/       node:test via tsx; fakes/fake-bot.ts      ← duplicated from eden/tests/fakes
  live-tests/  real server + real bots, no LLM (stock commands), and one authoring scenario
  .squad-data/ (gitignored) roster.json  commands/  squad.db  llm/
src/main/java/com/paul/brawl/squad/   SquadCommand, SquadClient, SquadEvents, SquadMembers,
                                      SquadAuthoring, CommanderSnap, SquadConfig, SquadArgs (Minecraft-free)
```

What is copied from Eden, and why it earned it:

| Copied | Why |
|---|---|
| `bots/pool.ts` | Login stagger (I1), version pin 1.21.1 (R11), `viewDistance:'short'` (R8), keepalive rope (R13), reconnect backoff |
| `bots/hardening.ts` | The R4/R5 abort sequence and the bounded pathfinder (R6–R10). Upstream's default search is unbounded |
| `bots/plugins.ts` | Named imports for the CJS plugin trio (R15); auto-eat / armor-manager options; R3 pause around multi-click sequences |
| `skills/instrument.ts` | Acorn loop-budget injection + the macrotask-starvation canary (finding W). Its "syscall shim" is dropped (O1) |
| `skills/exemplars` | The 28 mortal Voyager primitives, already fixed against real mineflayer by live tests (findings Z/C/E) |
| `journal/lag-monitor.ts` | Event-loop lag canary (`monitorEventLoopDelay` armed before the measured block) |
| `tests/fakes/fake-bot.ts`, `keep-alive.ts` | Unit tests without a server; R73 keep-alive for `unref()`'d timers |

After the copy, `squad/` never imports from `eden/`, and a fix in one is not ported to the other.

## 4. Roster and identity

- **Spawn** `/bots spawn BOTNAME P1 [P2 …]` (permission 2):
  1. The mod checks the name: `[A-Za-z0-9_]{3,16}`, not an online or known player (usercache), not `LLMBot`, not
     a reserved name.
  2. It adds the name to the whitelist (offline UUID) when the server uses one.
  3. It calls `POST /api/bots {name, owners:[uuid…], spawnAt}`. The runtime writes the roster and connects.
  4. On the bot's first join, the mod teleports it to the admin server-side. **Bots are never op'd** and do not
     need to be.
- **Owners** are managed by admins: `/bots owners BOT add|remove P…`. Every owner has the same rights over the bot.
- **Tags** are free-form labels that role selectors match (§6): `/bots tag BOT +archer -melee`, by any owner.
- **Join gate.** A join under a roster name that does not come from loopback (configurable allowlist) is kicked.
  This costs nothing and prevents a name collision with a real login, which in offline mode would otherwise just
  happen.
- **Despawn** `/bots despawn BOT` (admin): stop its orders, disconnect, remove the roster entry and the
  whitelist entry.
- **Death:** the bot leaves its order (reason `died`), respawns automatically, and becomes idle. Its inventory is
  where it died. **Disconnect:** it leaves its order (reason `disconnected`), reconnects with backoff, and becomes
  idle.
- The server must be in offline mode (`online-mode=false`, as `run/server.properties` is today). Online mode
  would need one Microsoft account per bot, which is out of scope.

## 5. The script API

### 5.1 Choice

| Option | For | Against |
|---|---|---|
| Raw mineflayer only | Massive training prior; nothing to learn | Every script re-invents mining, crafting and chests. Those are exactly the calls the live tests proved models get wrong (`recipesFor` + table windows, drop pickup, `bot.X is not a function`) |
| A custom facade (`bot.goTo`, `bot.mine`) | Small, uniform | No prior: models write mineflayer anyway and hit unknown methods; it caps "maximum control" |
| **Mineflayer + Voyager primitives + a thin squad layer** | Both priors at once. Voyager's skill code is the most-read mineflayer code there is. The helpers are proven. Raw `bot` remains for anything else | Two vocabularies, solved by one reference and exemplars |

**Chosen: the third.** It follows Voyager, with a squad layer added on top for multi-bot control.

Rules that make code easy for a model to get right:

1. **One file, one shape.** A command is one ESM file: `export const manifest = {…}` plus
   `export default async function (squad, args, ctx)`. There is no separate manifest file to drift. ≤ 400 lines.
2. **No import is ever needed.** Every helper, `Vec3`, `goals`, `Movements` and the squad error classes are scope
   globals. An `import` of `vec3`, `mineflayer-pathfinder` or `squad` is also accepted and resolves to the
   same instances, so both habits work (Eden's `Vec3 is not defined` cost a whole revision live).
3. **Everything is awaitable.** No callback is required. Long-running behaviour is a loop over `await`, checking
   `squad.stopped`.
4. **Minecraft ids everywhere** (`oak_log`, `iron_ingot`, `zombie`): the minecraft-data names models already know.
5. **Helpers return data and throw with evidence.** `mineBlock` returns `{ mined, at }`. A failure says what and
   where: `mineBlock(Bob): no oak_log within 32 blocks of (102, 64, -40)`. Errors are English, for the model.
   What players read is French.
6. **A bot leaving is an exception, not a state to poll.** `BotLeftError` is thrown in that bot's own branch, and
   `squad.parallel` / `squad.tasks` already handle it.
7. **The result goes to the player.** The function returns a short French sentence, shown as
   `[Bots] « mine-area » terminé : <retour>`. `ctx.say(text)` reports progress (rate-limited).

### 5.2 Surface (`squad.d.ts` is normative; this is the outline)

**The manifest**

```js
export const manifest = {
  summary: 'Miner une zone autour du commandant',           // French, shown to players
  params: { type: 'object', properties: {                    // JSON Schema; positional order = property order
    radius: { type: 'integer', minimum: 1, maximum: 64, default: 16 },
    block:  { type: 'string', default: 'stone' } } },
  roles: {                                                   // optional; default: { all: { take: 'free' } }
    miners: { select: { hasItem: '_pickaxe' }, min: 1, take: 'free' } },
  duration: 'bounded',                                       // 'bounded' (maxMinutes, default 10) | 'until-stopped'
};
```

- A role is `{ select, min = 0, max = ∞, take = 'free' | 'reclaim' }`. `select` is an AND of `tag`, `hasItem`
  (substring of an item id, so `_pickaxe` matches any pickaxe), `name` and `not`.

**`squad`, the order's bots**

| Member | What |
|---|---|
| `squad.bots` | Live array of the order's guarded bots (§6.4). Bots that join or leave update it |
| `squad.roles.<role>` | Live array per role |
| `squad.parallel(bots, async bot => …)` | Runs on each bot at once; resolves to `[{ bot, ok, value, error }]`. One bot failing or leaving never rejects the whole call |
| `squad.tasks(items, async (bot, item) => …, { bots, retries = 1 })` | Work queue. Each free bot takes the next item; an item whose bot leaves goes back in the queue; **bots that join the order mid-run start pulling too**. Resolves to per-item results |
| `squad.claim(key, { ttlSeconds })` / `squad.unclaim(key)` | Reservation shared **across orders** (true if won). `blockKey(pos)` makes a key |
| `squad.acquire(roleSpec)` / `squad.release(bot)` | Ask for more bots mid-run with the same rules as the manifest, or let one go |
| `squad.on('joined' \| 'left', (bot, reason) => …)` | Membership events; the listeners are removed at order end |
| `squad.stopped` / `squad.sleep(ms)` / `squad.every(ms, fn)` | Cancellation flag; timers tracked and cleared at order end |

**`ctx`, the order's context**

| Member | What |
|---|---|
| `ctx.commander` | `{ name, uuid, at: { position, yaw, pitch, lookBlock, lookEntity, heldItem, dimension, trigger? } }`, a snapshot taken by the mod at order time; `trigger` when a bound item started it (§5.4) |
| `ctx.commander.on('trigger', at => …)` / `ctx.commander.next(timeoutMs)` | Later clicks of the bound item while the order runs: each replaces `ctx.commander.at` (§5.4) |
| `ctx.commander.entity(bot)` | The commander as that bot sees them now, or `null` when out of range. This is what `follow` and `come` use |
| `ctx.friends` / `isFriend(entity)` | The commander, the co-owners of the order's bots, and the roster bots sharing an owner with them (§16, 2026-10-31: it was every roster bot, so two players' armies could never fight; now another owner's bots are enemies, the same team as the server's rule below). Kept up to date as the roster changes. Scripts never target them. The server enforces only one thing (§16, 2026-10-31): a bot's damage to a bot sharing an owner with it, or to one of its owners, is cancelled; PvP is otherwise on (O5) |
| `ctx.args`, `ctx.log(...)`, `ctx.say(text)` | Parsed args; a log line in the report; a French chat line to the commander |
| `ctx.run(name, args, { bots })` | Run another command the commander may use, as a subroutine on a subset of bots. Depth cap 8, cycle check |
| `ctx.trial` | True during an authoring trial run (§8.3). Scripts rarely need it |

**The bot.** Each bot is a real mineflayer `Bot` with `pathfinder`, `pvp`, `collectBlock`, `tool`, `autoEat`
and `armorManager` loaded, plus `hawkEye` for bows (**to verify**: `minecrafthawkeye` against 1.21.1).
Extra read-only fields: `bot.tags`, `bot.role`.

**The helpers.** These are globals, and they use Voyager's names and signatures where Voyager has them:
- From Voyager: `mineBlock(bot, name, count)`, `craftItem(bot, name, count)`,
  `smeltItem(bot, itemName, fuelName, count)`, `placeItem(bot, name, position)`, `killMob(bot, mobName, timeout)`,
  `exploreUntil(bot, direction, maxTime, callback)`, `getItemFromChest(bot, chestPos, items)`,
  `depositItemIntoChest(bot, chestPos, items)`, `checkItemInsideChest(bot, chestPos)`.
- Added here: `goTo(bot, pos, range)` (hops of ≤ 40 blocks, R6), `follow(bot, entity, range, { untilMs, offset })` (until
  `untilMs`, the order stops or the bot leaves; a `null` entity just waits; `offset` follows a slot beside the entity),
  `attack(bot, entity, { timeoutMs, leash, until })` (a leash breaks off a fight that drifts from a point),
  `shoot(bot, entity)`, `equip(bot, name, dest)`, `eat(bot)`, `pickupDrops(bot, radius)`,
  `findBlock(bot, name, maxDistance)`, `nearestEntity(bot, filter, maxDistance, { from })`,
  `nearestHostile(bot, maxDistance, { from, filter })` (distances from `from`, e.g. the commander).

**Cooperation by default.** Inside an order, `mineBlock`, `collectBlocks` and `placeItem` claim their target block
and skip blocks other bots have claimed. Two bots told `mineBlock(bot, 'oak_log', 5)` at the same time chop
different trees, and so do two players' orders.

### 5.3 Two examples (they are also `agent/prompts/exemplars/` and tests)

**Reclaim per role.** Archers are pulled off whatever they were doing; melee bots are taken only if idle. (A first
sketch; the stock `squad/src/stock/defend.mjs` has grown from it: commander-relative threats, a leash, targets spread
over the guards, a slot per bot, §16.)

```js
export const manifest = {
  summary: 'Défendre le commandant : archers à distance, mêlée au contact',
  params: { type: 'object', properties: { radius: { type: 'integer', default: 16 } } },
  roles: {
    archers: { select: { hasItem: 'bow' }, min: 1, take: 'reclaim' },
    melee:   { select: { tag: 'melee' }, take: 'free' },
  },
  duration: 'until-stopped',
};

export default async function (squad, { radius }, ctx) {
  const threat = bot => nearestHostile(bot, radius) ?? nearestEntity(bot, e => e.type === 'player' && !isFriend(e), radius);
  await Promise.all([
    squad.parallel(squad.roles.archers, async bot => {
      while (!squad.stopped) {
        const t = threat(bot);
        if (t) await shoot(bot, t); else await follow(bot, ctx.commander.entity(bot), 6, { untilMs: 1000 });
      }
    }),
    squad.parallel(squad.roles.melee, async bot => {
      while (!squad.stopped) {
        const t = threat(bot);
        if (t) await attack(bot, t); else await follow(bot, ctx.commander.entity(bot), 3, { untilMs: 1000 });
      }
    }),
  ]);
  return 'Défense levée.';
}
```

**Work queue.**

```js
export const manifest = { summary: 'Couper N bûches', params: { type: 'object', properties: {
  count: { type: 'integer', default: 32 }, chest: { type: 'string' } } } };

export default async function (squad, { count }, ctx) {
  const batches = Array.from({ length: Math.ceil(count / 4) }, () => 4);
  const done = await squad.tasks(batches, (bot, n) => mineBlock(bot, 'oak_log', n));
  const got = done.filter(r => r.ok).reduce((s, r) => s + r.value.mined, 0);
  return `${got} bûches coupées par ${squad.bots.length} bots.`;
}
```

### 5.4 Orders bound to items (docs/33, 2026-10-31)

Holding an item, `/bots orders bind <order> [args…]` makes that item an order giver: using it starts the order, or
re-aims it while it runs, with the player's position and view at the click and what the click hit. Decisions:

1. **The binding lives on the item stack**, as `minecraft:custom_data` `{squad: {order, line, glint}}`, with one lore
   line (« Ordre : mur-de-boucliers ») and an enchantment glint, so the player sees it.
   - `order` is canonical: a stock command's name, otherwise `author:name`. Given away, the item still means the
     binder's command, and the store's sharing rules (O3) decide whether its new holder may run it.
   - `line` is the rest of the bind line, kept as typed: args, `@bot` filters, `--reclaim`/`--free`, the
     `/bots order` syntax (`SquadArgs.order`).
   - `glint` records that the bind added the glint override, so `unbind` removes only what `bind` added.
   - **Why on the stack:** the binding travels with the item, two shields can carry two orders, and the binding
     survives a runtime restart. The runtime stays the single writer of squad state; a binding is part of the
     player's item, not of squad state.
   - **Rejected: per player and item type in the runtime.** Every shield of the player would give the same order, and
     nothing would show it. It would also need a new store and routes, and an archer's bow could not be told from a
     bound bow.
2. **Commands** (anyone):
   - `/bots orders bind <order> [args…]` binds the held item. The runtime checks the order like `/bots order` (the
     command resolves for the player, the args parse against its manifest) on `POST /api/orders/check`.
   - `/bots orders unbind` removes the held item's binding.
   - `/bots orders bound` lists the bound items in the player's inventory.
   - Bare `/bots orders` still lists the running orders.
3. **Who it orders: the player using the item, and their own bots.** A bound item given to another player orders
   *their* bots, provided the command is one they may order (stock, theirs or shared with them). That is wanted: a
   captain can hand out bound items, and O3 holds. A roster bot never triggers anything: bots use items too, for
   example `raiseShield`.
4. **The triggers, per item:**

   | Item | Trigger | Server hook |
   |---|---|---|
   | Bow, crossbow | `arrow-release` when the arrow it shoots enters the world, then `arrow-hit` at that arrow's first hit (entity or block). Drawing it is not a trigger | `ServerEntityEvents.ENTITY_LOAD` (an arrow whose owner is the player, within 2 blocks of their eyes, whose `getWeaponStack()` carries the binding); a mixin on `PersistentProjectileEntity.onEntityHit` / `onBlockHit`, only for arrows tracked at release |
   | Anything else | `use`: the right-click, in the air, on a block or on an entity (when that entity does not take the interaction) | `UseItemCallback`, which always returns `PASS`: the shield still blocks, the bow still draws |

   - **Left-click (swing) is not a trigger.** It is the player's own attack, a click in the air reaches the server
     only as an arm-swing packet (a mixin with no Fabric event), and an attack reaches 3 blocks where a right-click
     aims at 64 (the `CommanderSnap` raycast).
   - **Stop gesture: sneak + right-click** with any bound item stops that binding's order. A bound bow drawn while
     sneaking stops it too, and an arrow shot while sneaking is not a trigger.
   - **Rate limit:** 4 triggers a second per player (a bucket of 4, refilled at 4/s). Arrow hits count. The excess is
     dropped silently.
5. **What the script receives.** The snapshot is taken on the main thread at the click (at the hit for
   `arrow-hit`), as for `/bots order`, plus
   `trigger: { kind: 'use' | 'arrow-release' | 'arrow-hit', item, hit?: { position, entity? } }`.
   - An `entity` (in `hit` and in `lookEntity`) carries `id`, the network entity id, which is mineflayer's key:
     `bot.entities[id]`. The helper `entityOf(bot, ref)` resolves one.
   - An order started with `/bots order` has no `trigger`.
6. **A second click.** A binding has one running order per player: the running order of that command
   (author + name) whose commander is the player, whether a click or `/bots order` started it.
   - **Running and listening** (it has called `ctx.commander.on('trigger', …)` or `ctx.commander.next()`): the
     trigger is delivered to it. `ctx.commander.at` becomes the new snapshot, the listeners get it, and a `next()`
     resolves with it, or the latest is kept for the next `next()`. Nothing is stopped or reclaimed, so a shield wall
     re-forms where the player now looks within a few hundred milliseconds.
   - **Running, not listening:** it is restarted (stopped, then started with the new snapshot).
   - **Not running:** the trigger starts it, exactly like `/bots order` with the binding's line.
   - **A trigger that arrives while the start is in flight** (a bow's `arrow-hit` after its `arrow-release`) waits
     for it, then is delivered.
   - **The route** is `POST /api/orders/trigger`. A delivered trigger answers `text: ''` (no chat line per click); a
     start, a restart, a stop or a refusal answers as `/bots order` does.
   - **The journal:** each trigger is one event in the order's report (`kind: 'trigger'`, at most 200), journaled
     with it, never the hot stream (R44).
7. **Helpers for formations** (globals, §5.2):
   - **yaw convention:** every helper takes yaw in the commander's convention, Minecraft's degrees (0 = south/+Z,
     90 = west/−X), as `ctx.commander.at.yaw`.
   - `lookDir(yaw, pitch?)`: the unit view vector.
   - `lineSlots(center, yaw, count, { spacing, ranks, depth })`: positions on a line through `center` perpendicular
     to the view, with further ranks `depth` blocks behind.
   - `groundAt(bot, pos)`: the nearest standable feet position in that column.
   - `faceYaw(bot, yaw)`.
   - `raiseShield(bot, on)`: the shield in the off-hand, held up with `activateItem(true)` or lowered. Blocking
     slows walking, so raise it after arriving.
   - `shoot(bot, target)` takes a position as well as an entity, for a volley on the ground. hawkEye aims at a
     `{ position, isValid: true }`; when it cannot, the angle is computed from the arrow's ballistics (3 blocks per
     tick at full draw, gravity 0.05, drag 0.99).
8. **The first stock commands** (all `until-stopped` except `tir`; their roles `take: 'reclaim'`, because a click is
   an explicit order and reclaimed bots return to their previous order afterwards, O4):
   - **`mur-de-boucliers`** (shield): the guards (`hasItem: 'shield'`) line up perpendicular to the view at the
     block looked at, or a few blocks in front of the player when it is too far or not standable. They face along
     the view and raise their shields once in place. Hostiles or enemies that reach the line are fought, leashed to
     the slot; the guard then returns to its slot.
   - **`epee`** (sword):
     - Looking at a non-friend entity: everyone attacks it, archers shooting and at most 2 guards on it. The other
       guards fight what is near it. Once it is dead or gone, the bots defend the commander.
     - Looking at the ground: the bots hold that spot, like `defend` anchored on a position instead of the commander.
   - **`ligne-archers`** (arrow, use): the archers form a line perpendicular to the view, a few blocks short of the
     point (on the player's side), and shoot threats within range from their slots.
   - **`tir`** (fired from the bound bow; `bounded`): the archers shoot at the arrow's target, from where they stand.
     - At an entity: until it is dead or a few seconds pass.
     - At the ground: a volley of N arrows each, spread around the point.
     - Then the order ends. Archers it reclaimed from `ligne-archers` go back to their slots there, so the formation
       is kept.

## 6. Leases, roles and reclaiming

### 6.1 Lease stacks

Each bot has a **lease stack** of orders, at most 4 deep. The order on top drives the bot. The ones below are
orders it was reclaimed from that are still running. An idle bot has an empty stack.

### 6.2 Granting an order's bots (atomic)

For each role in manifest order:
1. **Candidates** are the commander's bots that are online, match `select`, and are not already granted in this
   order. With `@bot` filters on the command line, only those bots count.
2. **Order:** idle bots first. Then, only if the role's `take` is `reclaim`, busy bots, least recently granted
   first.
3. **Grant** up to `max`. A bot that matches several roles goes to the first role.

If any role ends below its `min`, the order is refused and nothing is reclaimed:
`[Bots] Pas assez de bots pour « defend » : archers 0/1 (Archer1 hors ligne).`
The order-time flags `--free` / `--reclaim` override every role's `take`.

### 6.3 Reclaim and return

- **Reclaim.** When order O2 reclaims bot B from O1:
  1. B's lease in O1 is suspended.
  2. The abort sequence runs on B alone (§7.2).
  3. Any O1 call in flight on B rejects with `BotLeftError(reason: 'reclaimed')`, and later O1 calls on B throw
     the same.
  4. B leaves `squad.bots` in O1, and O1's `left` event fires.
  5. O1 keeps running with its other bots. O1's commander is told
     `[Bots] Alice a réquisitionné Archer1 pour « defend ».`
- **Return.** When O2 ends or releases B, B is popped off O2. If O1 is still running, B **returns to O1** in its
  old role: `joined` fires, `squad.tasks` workers start pulling with B again, and `squad.roles` includes it.
  Otherwise B goes idle.
- **Who may reclaim:** any owner of B, from any order, including another owner's. Admins may as well.
  `/bots stop @B` frees B from its top order. That order may then return B to the one below, as above.

### 6.4 The lease-guarded bot

A script never holds the raw bot. It gets a **Proxy** made for its order:

- **Reads pass through** (`bot.entity`, `bot.inventory`, `bot.blockAt`…).
- **Every method call** on the bot and on its plugin objects (`pathfinder`, `pvp`, `collectBlock`, `tool`,
  `hawkEye`…) first checks that this order holds the top lease, and otherwise throws `BotLeftError`. Two orders
  can never drive one body, even if a script keeps a reference to a bot it lost.
- **`on` / `once` / `addListener`** are recorded, bound to the order's async context, and removed when the bot leaves
  the order or the order ends. Listener leaks across orders are impossible.
- **`chat` / `whisper`** are rate-limited below vanilla's spam kick (**to verify**: the threshold). `quit` / `end`
  throw, because a script may not disconnect a bot.
- `bot._client` is reachable and not guarded. That is acceptable under O1 and documented.

## 7. Running an order

### 7.1 Path

1. **Mod.** `/bots order NAME [args] [@bot…] [--free|--reclaim]` is checked by `SquadArgs`, which tokenizes and
   is Minecraft-free. `CommanderSnap` is taken on the main thread. Then the mod sends
   `POST /api/orders {commander, command, args, filters, take, snap}`.
2. **Runtime.** It resolves `NAME`: own commands first, then commands shared with the commander;
   `owner:NAME` resolves a clash. It validates args against `params`, with defaults and coercion. It grants bots
   (§6.2), imports the command module (compiled once per version), and runs it.
3. **Running.** The reply is `{orderId, bots:[…]}`, shown as `[Bots] « defend » lancé (#12) : Archer1, Archer2,
   Brute1.` Progress (`ctx.say`, `left` / `joined`, reclaim notices) arrives over SSE and is shown in chat.
4. **End.** The result is `done` (the function returned), `failed` (it threw), `stopped` (`/bots stop`) or
   `timeout`. On failure the player gets the error's first line and a click to `/bots fix NAME`.

### 7.2 Supervision and cleanup

- **Wall clock:** `bounded` orders get `maxMinutes` (default 10, admin ceiling 60). `until-stopped` orders get the
  admin ceiling `maxStandingMinutes` (default 120).
- **Stalls are a helper concern, not an order concern.** `goTo`, `follow`, `mineBlock` and the others carry their
  own progress watchdog (no position change, dig progress or window event for 20 s → throw with evidence). A guard
  order standing still is legitimate, so the order itself has no stall timer.
- **Cleanup** runs when a bot leaves an order and when the order ends:
  1. The abort sequence: collectblock cancel → `pvp.stop()` → pathfinder `stop()` then `setGoal(null)` →
     `stopDigging` → `deactivateItem` (a drawn bow) → close any window → `clearControlStates` → one macrotask
     settle (R4/R5).
  2. The order's listeners and timers are removed.
  3. The order's claims are released.
- **Async errors are attributed.** Each order runs in its own `AsyncLocalStorage` context, which recorded
  listeners are bound to. An error thrown from a detached promise or an event listener in a script fails that
  order and nothing else. An error that cannot be attributed is logged by the process guards; it never kills the
  process.

### 7.3 A wedged event loop

There is no sandbox, so a synchronous `while (true) {}` would freeze every bot's physics.
- **Prevention:** the loop budget is injected into every loop body at compile time, and the starvation canary
  catches a loop that only awaits resolved promises (finding W). Both are duplicated from Eden.
- **Recovery, crash-only:**
  1. `supervisor.ts` is the parent process. It expects a heartbeat over IPC every second; after 10 s of silence
     it kills the child and restarts it with backoff.
  2. On boot, the runtime marks every `running` order in the journal `interrupted` and reconnects the roster.
     Owners are told `[Bots] Le runtime a redémarré ; ordres interrompus : #12, #14.`
  3. The journal keeps the last compiled command and its order, so the report points at the culprit.

### 7.4 Reports

Every order journals a **run report**: the command version, args, commander snapshot, granted and left bots
with reasons, each `parallel` / `tasks` result, `ctx.log` lines, the error with a stack **mapped to the
submitted source's line numbers**, and each bot's vitals and inventory before and after. `/bots fix` feeds the
report to the author agent (§8.2).

## 8. Authoring

### 8.1 `/bots create NAME <request>`

Permission 0. You must own at least one bot. NAME is `[a-z0-9-]{2,32}` and must be new among your commands.

1. **Mod.** It reserves the player's authoring slot *before* anything else, because a duplicate must not kill the
   running turn (`AgentTurnsTest` lesson). There is one turn per player and a global cap (`maxAuthoring`,
   default 2). The mod takes `CommanderSnap`, then calls `POST /api/authoring {mode:'create', player, name,
   request, snap}`. The runtime mints a **`cmd-…` ticket** bound to (player, NAME, mode) and returns it with
   the message body.
2. **Turn.** `SquadAuthoring` runs one `squad-author` turn through `ClaudeCodeClient` in `squad/agent/claude-code/`.
   That covers the same flags, isolation, UTF-8 stdin, `NO_PROXY` and kill-on-abort; default timeout 15 min.
   `[Bots] Écriture de « NAME »…` is shown when the turn starts.
3. **Close.** When the turn ends, the mod sends `POST /api/authoring/<ticket>/close`. The ticket dies, and the
   runtime says whether a version was submitted during the turn:
   - If one was: `[Bots] Commande « NAME » prête (v1) : <summary>. Utilise /bots order NAME <rayon> <bloc>`.
     The command part is clickable (`SUGGEST_COMMAND`) and the params come from the manifest.
   - If not: `[Bots] « NAME » n'a pas pu être écrite : <the agent's last text>`.

### 8.2 `/bots fix NAME [feedback]`

The same path with `mode:'fix'`, for the author only. The message body holds, in one message and never trimmed,
the current source, the last report of an order of NAME (whoever ran it), and the feedback. This is the
density invariant that made Eden's revisions work. The result is version N+1, and the ready message says
`(v2)`. Versions are append-only; `/bots revert NAME vN` makes an old version current again.

### 8.3 The agent and its tools

- **Agent.** `squad-author`, prompt `squad/agent/prompts/squad-author.md`. Its tools are only `mcp__squad__*`; no
  Bash, Read or Write. The agent does not need a shell, and a pure tool surface makes turns reproducible.
  The prompt holds:
  - the API reference, **generated from `squad.d.ts`**, with a drift test;
  - the exemplars in full code;
  - the rules of §5.1;
  - the workflow below.
  Model: `claudeModel` in `squad.properties`; the strongest model available.
- **Tools** (MCP, `@modelcontextprotocol/sdk`, stateless Streamable HTTP; every call carries the ticket):

| Tool | What |
|---|---|
| `get_context` | The commander's bots: name, tags, online, position, held item, inventory summary, lease state; the commander snapshot |
| `list_commands` / `read_command` | Commands the player can use (own + shared), as summary and params, or full source |
| `read_helper` | Source of one helper (from `api/helpers/`) |
| `check_script(source)` | Parse; manifest extraction and validation; **typecheck** with `checkJs` against `squad.d.ts` + mineflayer's own types. Returns diagnostics with lines. This catches `bot.X is not a function` before any run (**to verify**: noise level, measured on the copied primitives) |
| `trial_run(source, args, { seconds ≤ 60 })` | Runs the draft as a real order on the commander's **idle** bots only (never reclaims). `ctx.trial = true`. Returns the report. At most 3 per turn |
| `submit_command(source)` | Stores the next version of NAME. Refused if `check_script` has errors. Allowed once per turn |

- **Workflow** taught by the prompt: `get_context` → `list_commands` (reuse via `ctx.run`) → write →
  `check_script` until clean → `trial_run` when the world allows it → revise → `submit_command` → answer with
  one French line for the player.
- **Also from your own session.** The same tools work from an interactive Claude Code session holding a
  `cmd-…` ticket from `/bots ticket NAME`, mirroring `/construction ticket`. This is phase 5.

## 9. Commands

| Command | Who | What |
|---|---|---|
| `/bots spawn BOT P1 [P2 …]` | admin | Create and connect a bot owned by P1…Pn |
| `/bots despawn BOT` | admin | Stop, disconnect, forget |
| `/bots equip BOT archer\|guard\|miner\|farmer` | admin | Give the role's kit server-side (`SquadKits`): armor worn, weapon in hand, shield in the off-hand; replaced items go to the inventory. Tags the bot with the role (removing the other kit tags) |
| `/bots owners BOT add\|remove P …` | admin | Change owners |
| `/bots raid [distance] [archers] [guards]` / `raid stop` / `raid clear` | admin, in game | An enemy army (200 blocks ahead, 10 archers + 10 guards by default) owned by the virtual player `Envahisseur`: spawned, put on the ground there and equipped on arrival, then ordered `raid` against the caller and their bots. `stop` stops it, `clear` despawns every raider (§16) |
| `/bots stop all` | admin | Stop every order |
| `/bots create NAME <request>` | owner of ≥ 1 bot | Write a command (§8.1) |
| `/bots fix NAME [feedback]` | author | Revise from the last report (§8.2) |
| `/bots order NAME [args] [@bot …] [--free\|--reclaim]` | owner | Run a command on your bots |
| `/bots stop [#id \| NAME \| @bot]` | owner | Stop your orders: all, one, all of a command, or free one bot |
| `/bots list` | owner | Your bots: online, tags, current order and the order's commander |
| `/bots orders` | owner | Running orders touching your bots |
| `/bots orders bind <order> [args…]` / `orders unbind` / `orders bound` | anyone | Bind the held item to an order (checked like `/bots order`), unbind it, list your bound items. Right-click a bound item to start or re-aim its order on your bots, sneak + right-click to stop it; a bound bow triggers with the arrows it shoots (§5.4) |
| `/bots tag BOT +t -t …` | owner | Edit tags |
| `/bots commands` / `/bots show NAME` | any | Commands you can use; one command's summary, params, roles, version, author |
| `/bots share NAME P1 [P2 …]` / `/bots unshare NAME P…` | author | Grant or revoke ordering rights. A shared command always runs its current version |
| `/bots delete NAME` / `/bots revert NAME vN` | author | Delete (for everyone it was shared with) / roll back |

- **Args** are positional in `params` property order, or `key=value`. A string with spaces goes in quotes. A
  token starting with `@` filters bots. `--free` / `--reclaim` are flags.
- **Errors show usage** built from the manifest: `Usage : /bots order defend [radius=16]`.
- **Tab completion** comes from the mod's cache: bot names, command names, and each command's param names.

## 10. Mod ↔ runtime protocol

Everything is on `127.0.0.1:8772` with `Authorization: Bearer <token>`. The JDK `HttpClient` is forced to HTTP/1.1,
because the h2c upgrade is the `AgentClient` lesson. Calls are async and never run on the main thread.

| Route (all `POST`, JSON body with `by: {uuid, name}` and `admin` where a player acts) | Purpose |
|---|---|
| `/api/health`, `/api/state` | Liveness; roster + owners + tags + bot status + every command and its shares + stock names + running orders (the mod's cache) |
| `/api/bots/spawn`, `/despawn`, `/owners`, `/tag`, `/list` | The roster |
| `/api/orders/start`, `/stop`, `/list` | Orders (`stop` target: '' = mine, `all`, `#id`, `NAME`, `@bot`) |
| `/api/orders/check` | `{ command, tokens, filters }` → `{ ok, text, command: canonical, summary }`: may this player order it with these args (`/bots orders bind`) |
| `/api/orders/trigger` | `{ command, tokens, filters, take?, stop?, snap }` (the snap with `trigger`): deliver to the player's running order of that command, else start it (restart one that does not listen); `stop: true` stops it (§5.4) |
| `/api/authoring/open`, `/close`, `/revoke` | Authoring turns and manual tickets |
| `/api/commands/list`, `/show`, `/share` (`remove: true` = unshare), `/delete`, `/revert` | The command store |
| `GET /events` (SSE) | `hello`, `notice` (`{to: [uuid…], text, click?}`: a French line, kept for offline players by the mod) and `state` (refetch `/api/state`). Notices emitted while no mod is connected are buffered (200) |
| `POST /mcp/squad` | Authoring tools (ticket-gated; stateless Streamable HTTP, JSON responses) |

Every answer is `{ ok, text, … }` where `text` is the French line the mod shows as is.

When the SSE connection drops, the mod reconnects with backoff and refetches `/api/state`. That rebuilds the cache
completely, so missed events cannot leave it wrong.

## 11. Storage (`squad/.squad-data/`, gitignored)

- `roster.json`: bots, owner UUIDs, tags. Rewritten atomically on change; the runtime is its only writer.
- `commands/<authorUuid>/<name>/meta.json` (current version, shares, created-from request) and `v<N>.mjs`
  (submitted source). Versions are kept forever.
- `squad.db` (better-sqlite3, WAL): `orders`, `order_bots`, `reports`, `authoring`. Pulses are never journaled,
  only counted in memory (R44).
- `llm/`: authoring transcripts, when `debugPrompts` is on.

## 12. Failure modes

| Failure | Behaviour |
|---|---|
| Runtime down | `/bots …` → `Le runtime des bots est injoignable.` Server unaffected |
| Runtime wedged | Supervisor kills it at 10 s, restarts it; orders `interrupted`, owners told (§7.3) |
| Script throws | Order `failed`, mapped stack in the report, `[Corriger]` click |
| Script loops synchronously | Loop budget throws inside the script → `failed` |
| Two orders on one bot | Impossible: lease-guarded proxy (§6.4) |
| Bot dies / disconnects | `BotLeftError` in its branch; `parallel`/`tasks` carry on with the rest |
| Commander logs off | The order keeps running; `commander.entity()` returns `null`; the end message is queued until they log back in |
| Authoring turn times out / errors | Ticket closed; `n'a pas pu être écrite : …` |
| Chat spam | `chat` rate-limited before the vanilla kick |
| Name collision with a real login | Join gate kicks non-loopback; spawn refuses known player names |

## 13. Test plan

- **Node (`squad/`, `npm run check` = lint + tsc + `node:test`, on fakes only):**
  - Lease stacks: grant order, atomic refusal below `min`, reclaim, return to a live order, return to idle when it
    has ended, depth cap.
  - The guarded proxy: method calls after a reclaim throw; listeners and timers are removed; `quit` is blocked;
    chat is rate-limited.
  - `parallel` and `tasks`: isolation, requeueing, a joined bot pulls work.
  - Cross-order claims.
  - Compile: the loop budget and the canary on the W pattern.
  - Async attribution: a listener throw fails its own order only.
  - Manifest and args parsing; `check_script` diagnostics on known-bad scripts.
  - Every exemplar in `agent/prompts/exemplars/` runs on the FakeBot.
  - The supervisor restarts a deliberately wedged child.
  - The drift test between `squad.d.ts` and the prompt's reference.
- **Java:** `SquadArgs` tokenizing, `@` filters and flags (Minecraft-free); `SquadClient` against a stub runtime
  (HTTP/1.1, timeouts, the injoignable path); `SquadAuthoring` slot reservation, following `AgentTurnsTest`; a
  Claude Code E2E authoring turn with `ScriptedAnthropic` and the real squad MCP, following `ClaudeCodeE2ETest`.
- **Live (`squad/live-tests/`, dev server `:25599`, not in `check`):**
  1. Spawn 3 bots; `/bots order` with stock commands follow / mine-area / defend.
  2. A reclaim of archers from a running work queue, and their return.
  3. A runtime kill mid-order.
  4. One real authoring turn (`/bots create`) end to end.

## 14. Phases

1. **Runtime and roster, no LLM.** Bring in the copied Eden pieces, `supervisor.ts`, the roster, the pool, the
   mod's `spawn`/`despawn`/`owners`/`list`, the join gate and whitelist. Exit: bots connect, reconnect, survive a
   runtime restart.
2. **Orders.** Compile, the guarded proxy, `squad` / `ctx`, the helpers, leases and roles, reports, and stock
   commands installed as the admin's shared commands. Exit: live tests 1–3.
3. **Authoring.** The MCP tools, `check_script`, `trial_run`, the `squad-author` agent, `/bots create` and the ready
   message. Exit: live test 4 and the E2E test.
4. **Fix loop and library.** `/bots fix`, `revert`, `share` / `unshare` / `delete`, `ctx.run` composition.
5. **Extras.** `/bots ticket` for your own session, an opencode backend (a second `opencode serve` on `:4097` with
   `squad/agent/opencode.json`), and update CLAUDE.md (port 8772, Squad, Eden marked dead).

## 15. To verify

| Item | Checked by | Phase |
|---|---|---|
| `minecrafthawkeye` works on 1.21.1 with the copied pool; else `shoot` = manual aim (`lookAt` with drop compensation + `activateItem`/`deactivateItem`) | live test 1 (defend) | 2 |
| `checkJs` against mineflayer types is low-noise on the 28 copied primitives (≤ a handful of suppressions) | unit test over the primitives | 3 |
| Vanilla chat-spam kick threshold for a bot; rate-limit set below it | live test, deliberate burst | 2 |
| Whitelist add/remove API names in Fabric 1.21.1 mappings, offline UUID derivation | in-game check at spawn | 1 |
| Bots per runtime process before event-loop lag (`system.loop-lag`) — target 30 | live test with 30 bots idle + 10 mining | 2 |
| `AsyncLocalStorage` context survives mineflayer event emission when listeners are bound through the proxy | unit test with a FakeBot emitter, then live | 2 |
| Teleporting a newly joined bot server-side before mineflayer's first physics tick does not desync it | live test 1 | 1 |

## 16. As built: where the code differs from this design

- **The API reference is a tool, not a prompt section.** `get_api_reference` returns `squad/reference/squad.d.ts`,
  the same file `check_script` typechecks against, so the agent's reference cannot drift. The prompt
  (`squad/agent/prompts/squad-author.md`) teaches the workflow; `tests/agent.test.ts` pins the prompt against the
  Claude Code agent file, the permissions and the tool list.
- **The typecheck runs in a worker thread** (`src/script/typecheck-worker.mjs`). The first check parses every library
  file (~5 s of synchronous compiler work), which on the main thread would freeze every bot. Later checks take
  0.1–0.3 s; the runtime warms it at boot.
- **Typecheck noise (§15):** the eight stock commands typecheck with zero errors and zero warnings
  (`tests/check.test.ts`). Only unknown names or properties, wrong argument counts and syntax block a submission.
- **`squad.tasks` re-queues on a bot leaving and waits up to 30 s** for a bot to join when every bot is gone. It
  only starts workers while items are queued: an early version restarted idle workers forever, a microtask loop that
  froze the process (found by `tests/orders.test.ts`).
- **The bot-name check at spawn is "online now or has played here"** (`world/playerdata/<offline uuid>.dat`), not
  the user cache. In offline mode the user cache makes up a profile for any name it is asked about, so the first
  version refused every name (found on the production server, 2026-10-27). The real risk is a bot loading a real
  player's save, and the playerdata file is what shows it.
- **Stock commands:** `come`, `follow`, `defend`, `gather`, `deposit`, `attack`, `bring`, `raid` (`squad/src/stock/`).
- **A server mod's items can make a bot deaf (found on production, 2026-10-27).** The first live run on `server/`
  had empty inventories, gives that never arrived, and logs "mined" but never collected. Probes
  (`live-tests/probe-protocol.ts`, `probe-packet.ts`) showed why: mineflayer could not decode the login
  `declare_recipes` packet. The one non-vanilla recipe in it was Universal Shops' Trade Shop block, which Polymer
  sends as a player head carrying `polymer:stack` data. A packet that fails to decode with a non-partial error makes
  protodef's `FullPacketParser` fail its stream, and the bot hears nothing more while staying connected. Universal
  Shops was removed from production (no shop existed in any chunk or inventory). The bot side is hardened too, in
  `src/bots/protocol.ts` and `pool.ts`, so another mod cannot do it again:
  1. `declare_recipes` is read as raw bytes (`customPackets`). Mineflayer never uses it, and a vanilla armor-trim
     recipe in it also fails mineflayer's 1.21.1 data, as a partial read.
  2. protodef's `FullPacketParser` drops an undecodable packet and goes on, reported once a minute per kind instead
     of a stack trace on stdout.
  3. A connected bot that receives no packet for 20 s is ended, and the pool reconnects it.
  The tests are in `tests/protocol.test.ts`.
- **Pathfinding on a forest canopy (production spawn).** Eden's 2 s think limit failed at 14 blocks ("Took to long to
  decide path"); it is upstream's 5 s again, and the search radius stays bounded (R6). A `goTo` target nobody can
  stand at (in leaves) gave "No path to the goal": `goTo` now tries range + 2, then the column at any height, and
  hops aim at columns.
- **hawkEye fires nothing when it finds no clear trajectory**, silently: an archer "shot" for a minute without
  using an arrow. `shoot` checks the arrow count, falls back to a manual aimed shot, and otherwise throws "no arrow
  left the bow … (no clear line of fire?)" (`tests/helpers.test.ts`).
- **A 20-bot defence against zombie waves (2026-10-31; 10 archers, 10 guards, one owner).** Five faults, fixed together:
  1. *Friendly fire broke the team at once* (arrows into guards, sweeps). The mod cancels a bot's damage to a bot
     sharing an owner with it or to one of its owners (`SquadFriends`, an `ALLOW_DAMAGE` hook registered before
     FlagManager's, `SquadFriendsTest`). Bots still hurt mobs, other players and other owners' bots.
  2. *hawkEye is one per process.* `minecrafthawkeye` keeps the bot it drives (the last one that loaded it), the
     target and the drawn bow in module variables, so `archer.hawkEye.oneShot(t)` drove another bot. Each bot now
     loads its own copy (`plugins.ts`, `freshHawkEye`).
  3. *Archers slow.* `shoot` waited a fixed 1.5 s; it now returns when the arrow count drops (polled every 50 ms, cap
     1.45 s, then a manual shot). `defend` re-picks right after each shot, looks for threats every 200 ms instead of
     1 s, and steps aside after "no clear line of fire".
  4. *Guards on one creature, standing in one block.* Guards spread over the threats (at most 2 on one, an untaken
     one first); archers prefer a threat no other archer shoots. Each bot holds its own slot around the commander
     (`follow` with `offset`: guards on a ring of 3, archers of 6).
  5. *Guards chased far away.* Threats count only within `radius` of the commander, nearest to the commander first;
     `attack`'s `leash` breaks off when the target leaves that circle or the guard is more than radius + 4 away.
  Tests: `squad/tests/defend.test.ts`.
- **Two armies (2026-10-31, `/bots raid`).** Friends were every roster bot (§5.2), so one player's army could never
  fight another's. Friends are now the order's team only: the commander, the co-owners of its bots, and the roster
  bots sharing an owner with them, the same team as `SquadFriends`, rebuilt on every roster or lease change
  (`OrderRunner.refreshFriends`). A stock `raid` marches an army in formation on a point and fights what it meets;
  `/bots raid` (admin) spawns an enemy army owned by a virtual player, `Envahisseur` (never the caller, or it would
  be the caller's own team), sets it on the ground ahead of the caller, equips it on arrival and orders it `raid`
  as that owner (`/api/orders/start` takes `by` as the commander; no new route). O6 holds: only an admin spawns
  them. 40 bots need `limits.maxBots` raised (default 30). Details: docs/system/squad/overview.md. Tests:
  `squad/tests/raid.test.ts`, `SquadRaidPlanTest`. Not yet run on a server.
- **Bots could not follow anyone up a ladder (2026-10-31, `follow` and `defend` on production).** Reproduced on the dev
  server with a ladder built over RCON (on a pillar, through a hole in a floor, in a 1×1 shaft, down into a pit): a
  bot alone climbed it (`goTo`), but bots following a player who climbed did not. Four faults in
  mineflayer-pathfinder, all upstream (the same with our patches reversed), and one in `defend`. All are fixed in
  `patches/mineflayer-pathfinder+2.4.5.patch`, except the last, which is fixed in `follow`:
  1. *A ladder someone is on could not be climbed.* `getMoveUp` refuses to rise out of a block an entity stands in,
     a rule meant for building a pillar. The player climbing ahead, or the bot ahead, made the ladder unclimbable.
     The search found no path, or tunnelled through the wall behind the ladder, which dropped the ladder (`canDig` is
     on). On a ladder an entity now only adds to the cost. The block a ladder hangs on is never dug.
  2. *A path that ended on the ladder.* With the goal in reach from a ladder block (a `GoalFollow` of range 3 below
     the player), or from the air over its top, the bot stopped there, let go and slid to the foot. Its goal was
     reached on the way and the player stood still, so it never planned again. A* no longer ends a path on a ladder
     or rises over its top (it steps off the last ladder block). The executor does not count the goal as reached
     while the bot hangs on a ladder.
  3. *A ladder entered from the side.* Its plate's edge stops the body. The executor aims at the plate, so the bot
     pushed into the edge until "stuck", then got the same path again. A ladder block is now entered from its
     front only. A bot that slid off beside the ladder still was sent straight at it: a ladder node is placed against
     the plate, a block up, so from beside the ladder it looked nearer than the step in front of it, and
     `pathFromPlayer` (which trims a partial path to where the bot is) skipped that step. It no longer skips onto a
     ladder from another column. With the workers on, every update is trimmed so, which is where this showed (1 run
     in 8).
  4. *A search over several ticks moved its own nodes.* `postProcessPath` placed the nodes of each partial path onto
     their blocks in place, and the executor shifted their `toBreak`, while A* went on expanding them. A ladder node
     rose one block per tick, and the search could end in noPath. The path is now made of copies, as the worker
     pool's already were. Our 10 ms `tickTimeout` and the A* budget made partial searches common, which is why this
     showed up here.
  5. *A `defend` slot in the air.* A slot is the commander's position plus an offset, so while the commander is on a
     ladder, or at the edge of a tower, the slot is in mid-air: every search for it ran to its limit, and the bot
     went wherever the search stopped. While nobody could stand at the slot (`slotStandable`, `bots/follow-goal.ts`),
     `follow` follows the commander itself at the same range, and goes back to the slot once it is open again.
  Tests: `squad/tests/ladders.test.ts` (a synthetic world with a ladder: each patch, and the workers giving the same
  paths) and `defend.test.ts` (the slot fallback). Live: two `run.ts` scenarios build a ladder on the dev world, and a
  bot follows a climbing bot up it with `follow`, then with `defend`.
- **Stopping the runtime on Windows:** stopping `npm start` from outside can leave `tsx src/supervisor.ts` and its
  child running. Use Ctrl+C in its console, or stop the `node` processes.
- **Performance (docs/31, implemented by docs/32, 2026-10-30).** Measured: the bots' A* filled the one event loop at
  6–8 moving bots on the laptop. What the runtime does now ([docs/31 §11](31-squad-performance-review.md)):
  - **Patched dependencies** (`squad/patches/`, `patch-package --error-on-fail` on install): prismarine-physics'
    `PlayerState` requires, minecraft-protocol's varint framing, and in mineflayer-pathfinder a per-bot tick clock, the
    look-ahead memo + block cache, an A* block cache and `AStar.setBudget`. `tests/patches.test.ts` fails without each.
    The A* block cache once let `getMoveJumpUp` raise a shared cached block (`blockC.height += 1`); it uses a local
    height now.
  - **"Stuck" is counted in physics ticks** (70), not 3.5 s of wall time: a busy loop no longer makes bots throw their
    paths away and re-plan.
  - **An A\* budget, on by default:** all searches together get at most `pathfinding.astarBudgetMs` (20) ms per 50 ms
    window. Without it, 20–30 gathering bots saturated the loop (5.7–8.2 ticks/s); with it, 20 ticks/s.
  - **An optional pathfinding worker pool** (`pathfinding.workers`, default 0): only A* moves to worker threads; the
    bots and scripts stay on the main thread, so O2 and O4 hold. Off by default: with the budget the main thread holds
    30 moving bots on the desktop, and the workers cost about 9 GB at 30 gathering bots.
  - **A lag monitor** (copied from Eden, owned here), `POST /api/metrics`, a `vitals` journal table (one row per minute,
    7 days) and `/bots status`. It warns at loop p99 > 250 ms or ELU > 0.9, not Eden's 1 s: bots are in slow motion
    well before.
  - `follow` keeps its goal between calls, and the guard proxy caches its wrappers.
