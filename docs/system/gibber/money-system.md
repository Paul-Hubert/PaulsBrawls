---
id: gibber.money-system
title: Gibber - the coin money system
system: gibber
summary: The paulsbrawls:coin item, the entitlement ledger (gibbers_state NBT), salary scheduler math, /gib commands, join backlog payout, threading, edge cases and every other place coins are used.
tags: [gibber, coin, money, salary, revenue, persistentstate, nbt, gib, gib_salary, gib_salary_period, currency]
sources: [src/main/java/com/paul/brawl/Money.java, src/main/java/com/paul/brawl/RevenueManager.java, src/main/java/com/paul/brawl/SalaryScheduler.java, src/main/java/com/paul/brawl/PlayerPersistentState.java, src/main/java/com/paul/brawl/GibCommand.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/client/java/com/paul/brawl/ClientEntryPoint.java, src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/ChatBotFunctions.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/VillageHttpListener.java, src/main/resources/assets/paulsbrawls/models/item/coin.json, src/main/resources/assets/paulsbrawls/lang/en_us.json, src/main/resources/assets/paulsbrawls/lang/fr_fr.json, eden/src/social/trade.ts, eden/src/main.ts]
verified_at: 4a8081f
---

# Gibber - the coin money system

**TL;DR** — Money is a plain item, `paulsbrawls:coin` (stack size 99). The server keeps one global
counter `total_revenue` that **every player is entitled to**, plus a per-UUID "already paid" counter.
Whenever the gap is positive (on join, on `/gib`, on every salary tick) the player is handed the
difference as coins and marked paid. The salary scheduler adds `salary_per_day` (default **0**) to
`total_revenue` every `salary_period` seconds (default **10**). All values live in world NBT
(`gibbers_state`), so they persist across restarts. There is no balance/spend API — coins are just items.

## The coin item

| Aspect | Value | Source |
|---|---|---|
| Registry id | `paulsbrawls:coin` | `Money.java:21` |
| Java handle | `Money.MONEY` (static `Item`) | `Money.java:10` |
| Settings | `new Item.Settings().maxCount(99)` — no other properties | `Money.java:22` |
| Registered by | `Money.register()` from `ServerEntryPoint.java:26` (dedicated server) and `ClientEntryPoint.java:11` (client) | |
| Model | `models/item/coin.json` → `minecraft:item/generated`, texture `paulsbrawls:item/coin` (16×16) | assets |
| Name | `item.paulsbrawls.coin` = `Coin` (en_us) / `Pièce` (fr_fr) | `lang/*.json` |
| Vanilla give | `/give <player> paulsbrawls:coin <n>` works like any item | — |

No creative tab entry, recipe, or loot table references the coin.

## Data model — `PlayerPersistentState`

A Minecraft `PersistentState` obtained from the **overworld**'s `PersistentStateManager` with id
`gibbers_state` (`PlayerPersistentState.java:13`, `:27-31`), i.e. saved as the world's
`data/gibbers_state.dat`. The `Type` is built with `createNew`, `fromNbt` and a `null` DataFixTypes
(`:55-59`).

NBT layout written by `writeNbt` (`:62-76`):

```
<root>
├── player_data : Compound   { "<uuid string>": int, ... }   // coins already paid to that UUID
└── global_data : Compound   { "<key>": int, ... }
```

| `global_data` key | Constant | Meaning | Default when absent |
|---|---|---|---|
| `total_revenue` | `RevenueManager.TOTAL_REVENUE_KEY` (`RevenueManager.java:15`) | Cumulative coins every player is entitled to | 0 |
| `salary_per_day` | `SalaryScheduler.SALARY_KEY` (`SalaryScheduler.java:18`) | Amount added to `total_revenue` per tick of the scheduler (name is historical — it is per *period*, not per day) | 0 |
| `salary_period` | `SalaryScheduler.SALARY_PERIOD_KEY` (`SalaryScheduler.java:19`) | Scheduler period in seconds | 0 → rewritten to 10 on start |

Accessors: `getPlayerValue(uuid)` / `getGlobalValue(key)` return `getOrDefault(..., 0)`
(`:78-89`); both setters call `markDirty()` (`:82-94`) so the state is saved with the world. Malformed
UUID keys are skipped on load (`:36-43`).

## Payout algorithm — `RevenueManager.updateRevenue(uuid, server)` (`RevenueManager.java:28-49`)

```
player = server.getPlayerManager().getPlayer(uuid)      // online only
if player == null: log "player is null"; return
total = global[total_revenue]; paid = player_data[uuid] (0 if new)
if paid < total:
    player.giveItemStack(new ItemStack(coin, total - paid))
    player_data[uuid] = total
```

`UpdateRevenueAll(server)` (`:51-55`) loops `getPlayerList()` (online players) and calls the above.

Consequences that follow directly from this code:

- **Offline players** are never iterated; their gap simply grows and is paid in full at their next join
  (the `JOIN` hook, `RevenueManager.java:19-26`).
- **New players receive the entire historical `total_revenue`** on first join (their paid value starts at 0).
- **Every Mineflayer bot is a player**: `LLMBot`, Eden's `Dieu`, Eden villagers and `EvalBot*` names all get
  the full backlog on first join and every subsequent salary.
- The paid marker is set to `total` regardless of whether the coins fit in the inventory.

## Salary scheduler — `SalaryScheduler`

| Step | Behaviour | Source |
|---|---|---|
| register | `SERVER_STARTED` → `start(server)`; `SERVER_STOPPING` → `stop()` | `SalaryScheduler.java:21-28` |
| start | Guarded by a static `started` flag. Creates `Executors.newSingleThreadScheduledExecutor()`. Reads `salary_period`; if `0`, writes `10` and uses 10. | `:41-56` |
| schedule | `scheduleAtFixedRate(task, initialDelay = 0, period, SECONDS)` — so one salary tick fires **immediately at server start** | `:59-64` |
| task | `server.execute(() -> giveDailyRevenue(server))` — hops to the main server thread | `:61-63` |
| giveDailyRevenue | `total_revenue += salary_per_day`, then `UpdateRevenueAll` | `:30-39` |
| stop | `shutdownNow()` and `started = false` (only if the executor exists and is not shut down) | `:73-78` |
| restart | `stop(); start(server)` — used by `/gib_salary_period` | `:80-83` |

Math: after the server has been up for `t` seconds with constant settings, `total_revenue` has grown by
`salary_per_day × (floor(t / salary_period) + 1)`. With the defaults (`salary_per_day = 0`) **no salary is
ever paid** until an admin runs `/gib_salary <n>`; the scheduler still ticks every 10 s.

`getInitialDelayToMidnight()` (`:67-71`) and the commented daily-period lines (`:47-48`) are dead code
left from a once-a-day design.

## Commands (`GibCommand.java`)

All three are registered through `CommandRegistrationCallback` and require **permission level 2**.
None sends chat feedback to the caller; each only writes a server log line (logger `GibCommand`).

| Command | Argument type | Effect | Log line | Lines |
|---|---|---|---|---|
| `/gib <amount>` | `IntegerArgumentType.integer()` — any int, **negatives accepted** | `total_revenue += amount`; `UpdateRevenueAll` (online players paid now) | `gibbed <amount>` | `:20-45` |
| `/gib_salary <amount>` | `integer()` — any int, negatives accepted | `salary_per_day = amount` (takes effect on the next scheduler tick; no restart) | `gibbed salary <amount>` | `:49-68` |
| `/gib_salary_period <amount>` (seconds; the Brigadier argument is named `amount`, `GibCommand.java:76`) | `integer(1)` — min 1 | `salary_period = seconds`; `SalaryScheduler.restart(server)` (restart fires one salary tick immediately because initial delay is 0) | `gibbed salary period <seconds>` | `:72-92` |

All settings are stored in `gibbers_state` and therefore **persist across restarts** (per world).

## Threading

| Path | Thread |
|---|---|
| `/gib*` command execution | server thread |
| `JOIN` payout | server thread |
| Salary tick | `pool-N-thread-1` scheduler thread → `server.execute(...)` → server thread |
| State reads/writes | always on the server thread (none of the paths above touch it elsewhere) |

The scheduler thread comes from the default thread factory (non-daemon); it is shut down on
`SERVER_STOPPING`.

## Where coins are used elsewhere

| Consumer | How it touches coins | Source |
|---|---|---|
| Village settlement listener (`:8767`) | `resolveItem("coin")` tries `minecraft:coin`, then falls back to `paulsbrawls:coin`; `"paulsbrawls:coin"` also resolves directly. Coins are swapped like any item. | `VillageHttpListener.java:271-282` |
| Eden `SettlementClient` | Rewrites trade item `coin` → `paulsbrawls:coin` before POSTing the Java-shaped `{botA,botB,aGives,bGives}` body (`COIN_ITEM`, `resolveItem`, `toSettlementRequest`). Called when a villager accepts a `propose_trade` offer (`answer_trade`) — see [../eden/social-and-trade.md](../eden/social-and-trade.md). | `eden/src/social/trade.ts:40`, `:55-62`, `:332-334`; `eden/src/main.ts:556` |
| AI God `Reward` tool | Gives any `namespace:path` item via `giveItemFromString`; `paulsbrawls:coin` works if the model names it (the persona prompt does not mention coins) | `ChatBotFunctions.java:39-48`, `ChatBotActions.java:78-91` |
| AI God `Trade` tool + `/accept` | `getItemFromString` requires `ns:name`; the take side matches inventory stacks by registry item (`isOf`) over `main` only; amounts must be 1–512 | `TradeOffers.java:41-110`, `ChatBotActions.java:119-142` |
| `ChatBotActions.giveGoodReward` | Gives 10 coins — **no callers** (dead code) | `ChatBotActions.java:56-58` |

Village bots acquire coins through the normal Gibber backlog/salary (they are players), which is what
makes coin usable as the village currency.

## Gotchas & known issues

- **Full inventory**: `giveItemStack`'s boolean result is ignored (`RevenueManager.java:46`) and the
  player is marked paid anyway (`:47`). Coins that do not fit are not dropped or re-queued by mod code.
  > ⚠ Unverified: exact vanilla 1.21.1 handling of the leftover stack (`PlayerInventory.insertStack`) —
  > the Minecraft sources are not in the repo.
- **Stacks above 99**: a single `ItemStack(coin, diff)` with `diff > 99` is handed to `giveItemStack`;
  splitting into stacks relies on vanilla inventory insertion.
- **Negative `/gib`** lowers `total_revenue` but never removes coins. Players already paid above the new
  total receive nothing until the total climbs back past their marker; new joiners get the lower total.
- **Integer overflow**: `total_revenue` and paid markers are `int`; no overflow checks.
- **New-player windfall**: first join pays the whole historical total — intended "everyone is equal"
  semantics, but it also showers every new bot account.
- `salary_per_day` defaults to 0 — CLAUDE.md's description implies a working default salary; out of
  the box only `/gib` pays.
- No feedback messages for the `/gib*` commands — admins must check the server log.
- `started` is a non-volatile static flag shared between the scheduler lifecycle and command thread;
  benign in practice since both run on the server thread.
- A corrupted/negative `salary_period` in NBT (not reachable via the command's `min 1`) would make
  `scheduleAtFixedRate` throw during `SERVER_STARTED`.

## Related

- [../platform/entrypoints-and-wiring.md](../platform/entrypoints-and-wiring.md)
- [../platform/build-and-runtime.md](../platform/build-and-runtime.md)
- [../eden/java-integration.md](../eden/java-integration.md)
- [../eden/social-and-trade.md](../eden/social-and-trade.md)
- [../aigod/actions-and-trades.md](../aigod/actions-and-trades.md)
- [../reference/commands.md](../reference/commands.md)
