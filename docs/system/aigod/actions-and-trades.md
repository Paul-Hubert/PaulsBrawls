---
id: aigod.actions-and-trades
title: AI God — world actions (ChatBotActions) and trades (/accept)
system: aigod
summary: ChatBotActions world effects (items, lightning, weather, spawns, block placement, getBlockInfo, avatar invulnerability) and the TradeOffers pending-offer + /accept flow.
tags: [aigod, chatbotactions, tradeoffers, accept, reward, punishment, smite, weather, spawncreature, getblockinfo, avatar, invulnerable, coin]
sources: [src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/TradeMath.java, src/main/java/com/paul/brawl/ChatBotFunctions.java, src/main/java/com/paul/brawl/GodService.java, src/main/java/com/paul/brawl/MinecraftGodWorld.java, src/main/java/com/paul/brawl/MainThread.java, src/main/java/com/paul/brawl/WorldRefusal.java, src/main/java/com/paul/brawl/ChatPrinter.java, src/main/java/com/paul/brawl/BridgeConfig.java, src/main/java/com/paul/brawl/Money.java, src/main/java/com/paul/brawl/Raycaster.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/main/java/com/paul/brawl/GodSessionManager.java, src/main/java/com/paul/brawl/GodClamps.java, src/main/java/com/paul/brawl/ItemIds.java, src/main/java/com/paul/brawl/BlockInfoJson.java, src/main/java/com/paul/brawl/ChatCommand.java]
verified_at: 98cb908
---

# AI God — world actions and trades

**TL;DR.** `ChatBotActions` holds the server-side effects behind the God's tools: giving items, lightning
(`smite`), `/weather`, entity spawning, block placement, a block-context probe, and the avatar's invulnerability flip.
Since docs/27 phase 2 it only *applies* already-checked effects: the clamps and refusals live in `GodService`, and a
failure is thrown as a `WorldRefusal` whose message the model reads. All must run on the server thread
(`MinecraftGodWorld` hops there through `MainThread.call`). `TradeOffers` keeps one pending
offer per player in RAM, executed by `/accept` (perm 0) within 5 minutes; both amounts must be 1–512 and the take side
matches by registry item. No special coin logic (`paulsbrawls:coin` is just another item id).

## Thread contract

Every method that touches the world assumes the server thread. Callers: `MinecraftGodWorld` (the `GodWorld` port
behind `GodService`) through `MainThread.call`/`run` (`MainThread.java:31-71`: `GodActionQueue.submit` + bounded 5 s
wait, inline when already on the server thread, a `WorldRefusal` on timeout) for
`Reward/Trade/Punishment/ChangeWeather/SpawnCreature` and for `buffAvatar`/`restoreAvatar` on `Appear`/`Vanish`,
Brigadier for `/block` & `/construction`, and `MinecraftBuildWorld.place` (the build text scanner via `BuildService`),
which since bug #7 queues one `GodActionQueue` bulk task per call line (see [building.md](building.md)). `restoreAvatarOnMain`
is the one helper called directly from server-thread code that has just cleared the queue.

## Server handle

| Member | Lines | Notes |
|---|---|---|
| `private static volatile MinecraftServer SERVER` | `ChatBotActions.java:51` | Set on `SERVER_STARTED`, nulled on `SERVER_STOPPING` (`ServerEntryPoint.java:46-60`). |
| `setServer(server)` / `server()` | `:53-54` | Used by off-thread watchdog paths. |
| `register()` | `:56-58` | Registers `/block` and `/construction` (called from `ChatBot.register`). |

## Item giving

### Item parsing

Two parsers (bug #6 fixed — splitting on `:` used to reject both a bare `diamond` and the component syntax the `Reward`
tool advertises):

- `getItemFromString(String str)` (`:130-150`) — the **registry item** only (used by `TradeOffers`): `ItemIds.baseId(str)` strips a
  `[components]` / `{nbt}` suffix, lower-cases, defaults the namespace to `minecraft` (unit-tested, `ItemIdsTest`);
  `Identifier.tryParse` → `Registries.ITEM.getOrEmpty(id).orElse(null)`. Blank / invalid → log `Invalid item string`, `null`.
- `parseItemStack(server, str)` (`:91-102`) — the **full stack**, parsed exactly like `/give`: `ItemStackArgumentType.itemStack(
  CommandRegistryAccess.of(server.getRegistryManager(), enabledFeatures)).parse(…)`, then `createStack(1, false)`.
  So `minecraft:enchanted_book[minecraft:enchantments={levels:{…}}]` keeps its components. Syntax error → log, `null`.
  (The component *contents* follow vanilla 1.21.1 `/give` syntax; the tool's example text is the model's guide.)

### Methods

| Method | Lines | Behaviour | Returns |
|---|---|---|---|
| `giveItemStacks(player, itemName, amount)` | `:77-88` | `Reward`, behind `GodService.reward` (`GodService.java:55-72`), which refuses `amount < 1` and clamps to `BridgeConfig.rewardMax` (64) via `GodClamps.rewardAmount` first — no clamp in here. `parseItemStack`; gives max-size stacks with `offerOrDrop` (what does not fit is dropped at the player's feet). | void; a bad item throws `WorldRefusal("Reward cancelled, item <itemName> does not exist or is malformed, please try again.")`. `GodService` returns `"You gave the player a reward: <n> <itemName>[ (limité à <n> sur <asked> demandés)]"` / `"Reward cancelled, amount must be at least 1 (got <a>)."` |
| `giveItem(player, Item, amount)` | `:117-119` | `player.giveItemStack(new ItemStack(item, amount))`. No clamp, no overflow drop. **Unused** (its last caller `giveGoodReward` was deleted). | void |
| `giveItemWithCommand(player, item, amount)` | `:104-114` | Runs `/give <name> <item> <amount>` as server source. **Unused.** | `""` |
| `stripArguments(str, commandName)` | `:121-128` | **Unused and broken**: `split(regex, 1)` always yields one element, so it always returns `null`. | `null` |

> `Reward` no longer uses `giveItemStack`: `PlayerInventory.offerOrDrop` drops the overflow, and a non-positive amount is
> refused before anything is parsed (bug #6).

## Punishment — `smite`

| Method | Lines | Behaviour |
|---|---|---|
| `smite(player, int strikes)` | `:153-156` | Strikes exactly `strikes` times; void, no clamp. `GodService.punish` (`GodService.java:95-107`) clamps first with `GodClamps.punishments(amount, BridgeConfig.punishmentMax)` (0..3 by default, bug #6) and returns `"God punished the player <n> times.[ (limité à <n> sur <asked> demandés)]"`. |
| `smite(player)` | `:159-168` | `EntityType.LIGHTNING_BOLT.create(world)`, `refreshPositionAfterTeleport(blockX, blockY, blockZ)` (block corner, not centred), `world.spawnEntity`. Null-safe on player/world. |

All bolts of one call spawn in the same tick at the same position.

## ChangeWeather

`GodService.changeWeather(uuid, type, seconds)` (`GodService.java:109-124`) → `MinecraftGodWorld.setWeather` →
`ChatBotActions.changeWeather(player, weatherType, durationSeconds)`, `ChatBotActions.java:292-299`:

- `GodService` trims and lower-cases the type and **refuses anything but `clear`, `rain` or `thunder`**
  (`"Météo refusée : type inconnu '<type>' (clear, rain ou thunder)."`; a null type is refused the same way); the
  duration is clamped to `0..1 000 000` (`MAX_WEATHER_SECONDS`). Before docs/27 phase 2 the type was not validated and
  any value was reported as a success.
- Null player/server → `WorldRefusal("Impossible de changer la météo : joueur ou serveur invalide.")`.
- Executes `"/weather " + weatherType.toLowerCase(Locale.ROOT) + " " + durationSeconds` via
  `server.getCommandManager().executeWithPrefix(server.getCommandSource(), …)` (server source = full permissions); void.
- `GodService` returns `"La météo a été changée en <type> pour <n> secondes."` if the clamped duration is `> 0`, else
  `"… pour une durée indéterminée."` — the command's own result is still not checked.

> ⚠ Unverified (no MC sources in checkout): in Minecraft ≥ 1.19.4 the `/weather` duration is a *time* argument where a
> bare integer means **ticks** and the minimum is 1. If so, `durationSeconds=30` yields 1.5 s of weather and `0`
> (documented as "permanent") makes the command fail — while the tool still reports success (the type is validated now, the
> duration only clamped).

## SpawnCreature — `spawnCreature(player, entityType, count, x, y, z, griefAllowed)`

The rules are in `GodService.spawnCreature` (`GodService.java:126-144`); the effect is `ChatBotActions.java:307-339`
(returns the number spawned, throws `WorldRefusal` on a failure):

1. Blank `entityType` → `"Spawn annulé : entityType vide."` (`GodService`).
2. `clamped = clamp(count, 1, max(1, BridgeConfig.spawnCountMax))` — default cap 8 (`BridgeConfig.java:54`);
   `count <= 0` still spawns 1. Each offset is clamped to `±BridgeConfig.spawnOffsetMax` (16) by
   `GodClamps.spawnOffset` (bug #6 — they used to be unclamped); `griefAllowed = BridgeConfig.creatureGriefingAllowed`.
3. Player null or world not a `ServerWorld` → `"Impossible de spawner : joueur ou monde invalide."`
4. `Identifier.tryParse(entityType.trim())` null → `"Spawn annulé : identifiant invalide '<entityType>'."`
   (a bare `zombie` defaults to the `minecraft` namespace).
5. Not in `Registries.ENTITY_TYPE` → `"Spawn annulé : type d'entité inconnu '<entityType>'."`
6. `basePos = player.getBlockPos().add(dx, dy, dz)` (already clamped).
7. For `i in 0..clamped-1`: position `basePos + ((i % 3) - 1, 0, ((i / 3) % 3) - 1)` (3×3 fan, repeats after 9),
   `type.create(world)`, `refreshPositionAndAngles(x+0.5, y, z+0.5, playerYaw + 180, 0)`; if
   `!griefAllowed` (default `false`) and it is a `MobEntity`, `setCanPickUpLoot(false)`;
   `world.spawnEntity` → counts successes.
8. `GodService` returns `"God a fait apparaître <spawned> <entityType>[s] près du joueur[ (griefing désactivé)]."`.

Sharp edges: "griefing disabled" only stops loot pickup (creepers still explode, endermen still take blocks); entities
are created with `EntityType.create` without spawn initialization (no random equipment/variants); no check that the
position is free.

## Block placement

Used by `/block` and, through `BuildService` → `MinecraftBuildWorld.place`, by the build bots' textual calls and
`BuildSubAgent` (semantics in [building.md](building.md)). The line/points walks moved to `BuildShapes`
(`BuildShapes.line` is the same DDA as the old `placeLineAt`: `maxLen = max(1, max(|dx|,|dy|,|dz|))`, `i = 0..maxLen`
inclusive, integer division per axis; `BuildShapes.points` zips the three arrays up to the shortest length).

| Method | Lines | Behaviour |
|---|---|---|
| `placeBlock(player, x, y, z, blockType)` | `:208-213` | `/block` only. Pivot = `Raycaster.getLastPos(uuid)`; no-op if null; `placeAll` with one offset. |
| `placeAll(player, origin, offsets, blockType)` | `:215-227` | `parseBlockState` once (unknown → `WorldRefusal("Bloc inconnu ou mal formé : '<block>'.")`), then `world.setBlockState(origin + offset, state)` per offset (default flags; no drops, no permission check). Returns the count. Caps are `BuildService`'s. |
| `isKnownBlock(server, blockType)` | `:262-265` | `parseBlockState(...) != null`; `BuildService.submit` checks it before queueing. |
| `parseBlockState(server, blockType)` (private) | `:267-288` | `BlockArgumentParser.block(registryWrapper(BLOCK), blockType, false)`; on syntax error, retries with the part before `[` (state dropped); logs warnings; `null` on failure. Accepts full block-state syntax e.g. `minecraft:oak_stairs[facing=east]`. |

## getBlockInfo

`ChatBotActions.getBlockInfo(player)` (`:236-258`) feeds the 4th system message every godBot turn
([llm-pipeline.md](llm-pipeline.md)).

- Center = `Raycaster.getLastPos(player.getUuid())` — the block hit by the player's last `/construction` raycast
  (perm-2 command, `Raycaster.java:141-147`). If null → returns `""` (the usual case for non-admin players).
- `zone = 3`. For each `(i, j)` in `0..2 × 0..2` it scans `k = 2, 1, 0, -1` and offset
  `v = (i-1, k-1, j-1)`, i.e. a 3×3 column footprint from dy=+1 down to dy=-2, and records the **first non-air**
  block per column.
- Output format (bug #18 — it used to be unparseable pseudo-JSON with an unbalanced quote and the block's *item* name):

```
Surrounding block info (offsets from the /construction pivot):
[
{"x":-1,"y":0,"z":-1,"block":"minecraft:grass_block"},
...
]
```

Built by `BlockInfoJson` (escaped, comma-separated; `BlockInfoJsonTest` parses it with Jackson). `block` is the block's
registry id (`Registries.BLOCK.getId`), so water is `minecraft:water`, not the air item. Despite the system-message label ("near the player's
cursor"), it is not the live cursor.

## Avatar helpers

| Method | Lines | Behaviour | Returns |
|---|---|---|---|
| `findAvatar(prayingPlayer)` | `:342-348` | Server from the player (or the static `SERVER`), `getPlayerManager().getPlayer(BridgeConfig.botUsername)` (default `LLMBot`). | `ServerPlayerEntity` or `null` |
| `buffAvatar(prayingPlayer)` | `:355-364` | `bot.setInvulnerable(true)` + `bot.extinguish()`. Called on `Appear` inside `MinecraftGodWorld.appear`'s `MainThread.run`. | `"Avatar rendu invincible."` / `"Avatar introuvable (pas de buff)."` (logs `buffAvatar: bot '<name>' not found (not joined?)`) |
| `restoreAvatar(prayingPlayer)` | `:366-371` | `bot.setInvulnerable(false)`. Called on `Vanish` (`MinecraftGodWorld.vanish`, `restoreAvatar(null)` through `MainThread.run`) and `endPrayerSession`. | `"Avatar redevenu mortel."` / `"Avatar introuvable."` |
| `restoreAvatarOnMain(server)` | `:380-386` | Bug #5: `setInvulnerable(false)` directly, for server-thread callers that just cleared the queue — `/godbody off` (`ChatCommand.java:67`) and `SERVER_STOPPING` (`ServerEntryPoint.java:55`). An avatar offline at that moment keeps its saved flag. | `"Avatar redevenu mortel."` / `"Avatar introuvable."` / `"Serveur indisponible."` |
| `dismissAvatarOnWatchdog(ownerUuid)` | `:392-402` | Off-thread: queues `setInvulnerable(false)` on main thread and calls `GodBody.vanish()` directly. Called by the idle watchdog (`GodSessionManager.java:194`). | void |

`setInvulnerable` sets the entity field that Minecraft serializes as the `Invulnerable` NBT tag. Session/lock
semantics: [god-body.md](god-body.md).

## Trades — `TradeOffers`

### Storage

- `private static final HashMap<UUID, TradeOffer> offers` (`TradeOffers.java:110`) — one pending offer per player,
  **in RAM only**. A new `Trade` call replaces the previous offer. Offers expire `OFFER_TTL_MILLIS` (5 min, `:25`)
  after creation; the expiry is checked lazily on `/accept`. Not thread-safe, but all
  accesses happen on the server thread (`Trade` via `MinecraftGodWorld.offerTrade` → `MainThread.run`, `/accept` via Brigadier).
- `TradeOffer` (`:27-87`): `giveItemName`, `giveAmount`, `takeItemName`, `takeAmount`, `createdAtMillis`, resolved
  `giveItem`, `takeItem`.
- `MAX_TRADE_AMOUNT = 512` (`:22`); `checkAmounts(give, take)` (`:94-96`) delegates to
  `TradeMath.amountError(give, take, 512)` (`TradeMath.java:69-75`), which returns
  `"Trade cancelled. giveAmount and takeAmount must both be between 1 and 512 (got <g> and <t>). Please try again."`
  or `null`.

### Offer creation — `updateOffer(player, giveItemName, giveAmount, takeItemName, takeAmount)` (`:157-173`)

0. The `Trade` tool goes through `GodService.offerTrade` (`GodService.java:74-93`), which calls
   `TradeMath.amountError` first and returns its error to the model; `updateOffer` repeats the check (`:162-165`), so
   no out-of-range offer is ever stored.
1. `verifyItems()` (`:41-54`) resolves both names with `ChatBotActions.getItemFromString`; failure returns
   `"Trade cancelled. <name> was not a correct item. Please try again."` (offer not stored).
2. Stores the offer, returns `null`.
3. Caller `ChatBotActions.sendTradeOffer` (`ChatBotActions.java:64-69`, void) turns an `updateOffer` error into a
   `WorldRefusal`, else privately messages the player
   `"God has offered you a trade: \n You receive <giveAmount> <giveItemName> for <takeAmount> <takeItemName>\n Type /accept within 5 minutes."`;
   `GodService.offerTrade` then returns the model-facing `"God offered a trade to the player: God gives … \nThe player may accept or decline this trade."`
   (or the refusal text).

### `/accept` (`:116-155`)

| | |
|---|---|
| Syntax | `/accept` |
| Permission | none set → level 0 (everyone) |
| Thread | server main thread |

`executeOffer(player)`:
1. No offer → `"You have no trade request in progress, ask God with /pray."`
2. Expired (≥ 5 min old, `TradeMath.isExpired`) → offer removed, `"God's trade offer has expired, ask God again with /pray."`
3. Amounts re-checked with `checkAmounts` (defence in depth: the offer is stored LLM output) → if invalid, offer removed,
   `"God's trade offer was invalid and has been cancelled."` and a `Dropped invalid trade offer …` warn log.
4. `offer.execute(player)` (`:56-86`):
   - Scans `player.getInventory().main` (36 main + hotbar slots; armour/offhand ignored) for stacks that are
     `isOf(takeItem)` — matching by **registry item**, not by translated display name.
   - `TradeMath.planTakes(slots, takeAmount)` plans exactly `takeAmount` across the stacks in slot order; it returns
     `null` when the player holds too few **or `takeAmount < 1`** → `"The trade is cancelled. You only have <n> <takeItemName>, but <takeAmount> are required."`,
     return `false` (offer **kept**, player can retry within the TTL).
   - `decrement`s the planned counts, then `giveItemsOrDrop(player, giveItem, giveAmount)` (`:99-105`): fresh stacks
     in max-stack-size chunks via `PlayerInventory.offerOrDrop`, so nothing above the stack limit is created and
     whatever doesn't fit drops at the player's feet; returns `true`.
5. On success the offer is removed. The God is **not** notified (no LLM turn).

### Coins

There is no coin-specific code. The God can trade/reward Gibber coins by naming `paulsbrawls:coin`
(`Money.java:21`, max stack 99). The system prompt does not mention coins. See
[../gibber/money-system.md](../gibber/money-system.md).

## Commands registered here

| Command | Perm | Lines | Behaviour |
|---|---|---|---|
| `/block <x> <y> <z>` (ints) | 2 | `ChatBotActions.java:172-188` | `placeBlock(player, x, y, z, "minecraft:stone")` — **offsets relative to the player's `/construction` pivot**, no-op if none. |
| `/construction` | 2 | `ChatBotActions.java:190-204` | `Raycaster.setLastPos(player)` (100-block look raycast; stores hit pos or `null`) and `ChatBot.buildBot.clearMemory(player)`. See [building.md](building.md). |
| `/accept` | 0 | `TradeOffers.java:116-126` | See above. |

~~Both `/block` and `/construction` call `getPlayer()` and will fail from the console.~~ **Fixed (bug #18):** both now
use `getPlayerOrThrow()`, so the console gets vanilla's readable player-required error instead of an NPE (they still need a
player).

## Gotchas & known issues

- **Fixed — negative `takeAmount` duplicated items** (VERIFICATION-NOTES bug #3): `amount < takeAmount` was false
  for a negative amount and `setCount(count - negative)` *grew* the stack. Amounts are now rejected outside 1–512 at
  tool execution, in `updateOffer` and on `/accept`, and `planTakes` refuses a non-positive need on its own.
- **Fixed — display-name matching**: the take side now uses `stack.isOf(takeItem)`. Components are still ignored
  for matching, so an enchanted or renamed stack of the right item counts (and can be taken).
- `giveItem` (`ChatBotActions.java:117-119`) passes one `ItemStack(item, amount)` to `giveItemStack`, whose result is
  ignored: whatever doesn't fit a full inventory is lost. Neither `Reward` (now `giveItemStacks` + `offerOrDrop`)
  nor `/accept` uses it; nothing calls it any more (`giveGoodReward` was deleted).
- ~~Unclamped `Punishment.amount` (mass lightning in one tick) and `Reward.amount`.~~ **Fixed (bug #6):** clamped to
  `BridgeConfig.punishmentMax` (3) and `rewardMax` (64) via `GodClamps`, in `GodService` (unit-tested by
  `GodServiceTest` against a recording `GodWorld`).
- A `Trade` offer resolves items with `getItemFromString`, which strips components: an offered
  `minecraft:enchanted_book[…]` is delivered as a plain book (only `Reward` keeps components).
- `changeWeather` duration units (see above). ~~Always-success return~~: an unknown type is now refused (docs/27 phase 2).
- ~~`getBlockInfo` output is malformed pseudo-JSON~~ fixed (bug #18); it is still keyed off `/construction`, not the
  cursor.
- Dead code: `giveItem`, `giveItemWithCommand`, `stripArguments` (broken). (`giveGoodReward`/`giveBadReward` were deleted.)
- Offers expire after 5 minutes (checked on `/accept`, not proactively) and vanish on restart. The God is not told
  when an offer expires.

## Related

- [tools-catalogue.md](tools-catalogue.md) · [llm-pipeline.md](llm-pipeline.md) · [god-body.md](god-body.md)
- [building.md](building.md) · [configuration-and-commands.md](configuration-and-commands.md) · [overview.md](overview.md)
- [../gibber/money-system.md](../gibber/money-system.md)
