---
id: gibber.money-system
title: Gibber - the coin money system
system: gibber
summary: The paulsbrawls:coin item, the entitlement ledger (gibbers_state NBT), salary scheduler math, /gib commands, join backlog payout, threading, edge cases and every other place coins are used.
tags: [gibber, coin, money, salary, revenue, persistentstate, nbt, gib, gib_salary, gib_salary_period, currency]
sources: [src/main/java/com/paul/brawl/Money.java, src/main/java/com/paul/brawl/RevenueManager.java, src/main/java/com/paul/brawl/SalaryScheduler.java, src/main/java/com/paul/brawl/PlayerPersistentState.java, src/main/java/com/paul/brawl/GibCommand.java, src/main/java/com/paul/brawl/GibberMath.java, src/main/java/com/paul/brawl/ItemIds.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/client/java/com/paul/brawl/ClientEntryPoint.java, src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/ChatBotFunctions.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/VillageHttpListener.java, src/main/resources/assets/paulsbrawls/models/item/coin.json, src/main/resources/assets/paulsbrawls/lang/en_us.json, src/main/resources/assets/paulsbrawls/lang/fr_fr.json, eden/src/social/trade.ts, eden/src/main.ts]
verified_at: 98cb908
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

## Payout algorithm — `RevenueManager.updateRevenue(uuid, server)` (`RevenueManager.java:28-63`)

```
player = server.getPlayerManager().getPlayer(uuid)      // online only
if player == null: log "player is null"; return
total = global[total_revenue]; paid = player_data[uuid] (0 if new)
owed = GibberMath.owed(total, paid)                     // max(0, total - paid), no overflow
if owed == 0: return
insert owed coins as max-size stacks with PlayerInventory.insertStack, stopping when one does not fit
if inserted > 0: player_data[uuid] = GibberMath.paidAfter(paid, inserted) // credit ONLY what landed (bug #10)
if inserted < owed: log "<name>: inventory full, <n> of <owed> coin(s) still owed"
```

`UpdateRevenueAll(server)` (`:65-69`) loops `getPlayerList()` (online players) and calls the above.

Consequences that follow directly from this code:

- **Offline players** are never iterated; their gap simply grows and is paid in full at their next join
  (the `JOIN` hook, `RevenueManager.java:19-26`).
- **New players receive the entire historical `total_revenue`** on first join (their paid value starts at 0).
- **Every Mineflayer bot is a player**: `LLMBot`, Eden's `Dieu`, Eden villagers and `EvalBot*` names all get
  the full backlog on first join and every subsequent salary.
- The paid marker advances only by the coins that reached the inventory; the rest stays owed and is paid on the
  next salary tick or join once there is room (bug #10 — it used to be set to `total` regardless, losing the coins).

## Salary scheduler — `SalaryScheduler`

| Step | Behaviour | Source |
|---|---|---|
| register | `SERVER_STARTED` → `start(server)`; `SERVER_STOPPING` → `stop()` | `SalaryScheduler.java:21-28` |
| start | Guarded by a static `started` flag. Creates `Executors.newSingleThreadScheduledExecutor()`. Reads `salary_period`; if `0`, writes `10` and uses 10. | `:40-55` |
| schedule | `scheduleAtFixedRate(task, initialDelay = 0, period, SECONDS)` — so one salary tick fires **immediately at server start** | `:58-63` |
| task | `server.execute(() -> giveDailyRevenue(server))` — hops to the main server thread | `:60-62` |
| giveDailyRevenue | `total_revenue = GibberMath.addToTotal(total, salary_per_day)` (saturating, bug #10), then `UpdateRevenueAll` | `:30-38` |
| stop | `shutdownNow()` and `started = false` (only if the executor exists and is not shut down) | `:72-77` |
| restart | `stop(); start(server)` — used by `/gib_salary_period` | `:79-82` |

Math: after the server has been up for `t` seconds with constant settings, `total_revenue` has grown by
`salary_per_day × (floor(t / salary_period) + 1)`. With the defaults (`salary_per_day = 0`) **no salary is
ever paid** until an admin runs `/gib_salary <n>`; the scheduler still ticks every 10 s.

`getInitialDelayToMidnight()` (`:66-70`) and the commented daily-period lines (`:46-47`) are dead code
left from a once-a-day design.

## Commands (`GibCommand.java`)

All three are registered through `CommandRegistrationCallback` and require **permission level 2**.
None sends chat feedback to the caller; each only writes a server log line (logger `GibCommand`).

| Command | Argument type | Effect | Log line | Lines |
|---|---|---|---|---|
| `/gib <amount>` | `IntegerArgumentType.integer(1)` — ≥ 1 (bug #10: negatives used to be accepted) | `total_revenue = GibberMath.addToTotal(total, amount)` (saturating at `Integer.MAX_VALUE`); `UpdateRevenueAll` (online players paid now) | `gibbed <amount>` | `GibCommand.java:20-42` |
| `/gib_salary <amount>` | `integer(0)` — ≥ 0 | `salary_per_day = amount` (takes effect on the next scheduler tick; no restart) | `gibbed salary <amount>` | `:49-68` |
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
| Eden `SettlementClient` | Rewrites trade item `coin` → `paulsbrawls:coin` before POSTing the Java-shaped `{botA,botB,aGives,bGives}` body (`COIN_ITEM`, `resolveItem`, `toSettlementRequest`). Called when a villager accepts a `propose_trade` offer (`answer_trade`) — see [../eden/social-and-trade.md](../eden/social-and-trade.md). | `eden/src/social/trade.ts:40`, `:55-62`, `:354-356`; `eden/src/main.ts:642` |
| AI God `Reward` tool | Gives any item via `giveItemFromString`, parsed like `/give` (namespace optional, components allowed) and clamped to `BridgeConfig.rewardMax` (bug #6); `paulsbrawls:coin` works if the model names it in full (a bare `coin` resolves to `minecraft:coin`) (the persona prompt does not mention coins) | `ChatBotFunctions.java:39-48`, `ChatBotActions.java:89-106` |
| AI God `Trade` tool + `/accept` | `getItemFromString` takes the registry id via `ItemIds.baseId` (components stripped, namespace defaults to `minecraft:`, so coins must be named `paulsbrawls:coin`); the take side matches inventory stacks by registry item (`isOf`) over `main` only; amounts must be 1–512 (`MAX_TRADE_AMOUNT`) | `TradeOffers.java:41-100`, `ChatBotActions.java:148-168` |
| `ChatBotActions.giveGoodReward` | Gives 10 coins — **no callers** (dead code) | `ChatBotActions.java:60-62` |

Village bots acquire coins through the normal Gibber backlog/salary (they are players), which is what
makes coin usable as the village currency.

## Gotchas & known issues

- ~~**Full inventory** loses coins; stacks above 99; negative `/gib`; integer overflow~~ **Fixed (bug #10):** payouts
  insert max-size stacks and credit only what landed (the rest stays owed); `/gib` takes `≥ 1` and `/gib_salary`
  `≥ 0`; the total and paid markers saturate at `Integer.MAX_VALUE` (`GibberMath`, `GibberMathTest`). The inventory
  side (`insertStack`) needs an in-game check.
  > ⚠ Unverified: exact vanilla 1.21.1 `PlayerInventory.insertStack` semantics (the code relies on it shrinking the
  > stack to the part that did not fit) — the Minecraft sources are not in the repo.
- **New-player windfall** (owner decision, unchanged): first join pays the whole historical total — intended
  "everyone is equal" semantics, but it also showers every new bot account.
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
