---
id: aigod.actions-and-trades
title: AI God — world actions (ChatBotActions) and trades (/accept)
system: aigod
summary: ChatBotActions world effects (items, lightning, weather, spawns, block placement, getBlockInfo, avatar invulnerability) and the TradeOffers pending-offer + /accept flow.
tags: [aigod, chatbotactions, tradeoffers, accept, reward, punishment, smite, weather, spawncreature, getblockinfo, avatar, invulnerable, coin]
sources: [src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/TradeMath.java, src/main/java/com/paul/brawl/ChatBotFunctions.java, src/main/java/com/paul/brawl/ChatPrinter.java, src/main/java/com/paul/brawl/BridgeConfig.java, src/main/java/com/paul/brawl/Money.java, src/main/java/com/paul/brawl/Raycaster.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/main/java/com/paul/brawl/GodSessionManager.java]
verified_at: 4a8081f
---

# AI God — world actions and trades

**TL;DR.** `ChatBotActions` holds the server-side effects behind the God's tools: giving items, lightning
(`smite`), `/weather`, entity spawning, block placement, a block-context probe, and the avatar's invulnerability flip.
All must run on the server thread (tool dispatch wraps them in `GodActionQueue`). `TradeOffers` keeps one pending
offer per player in RAM, executed by `/accept` (perm 0) within 5 minutes; both amounts must be 1–512 and the take side
matches by registry item. No special coin logic (`paulsbrawls:coin` is just another item id).

## Thread contract

Every method that touches the world assumes the server thread. Callers: `ChatBotFunctions.runOnMain`
(`ChatBotFunctions.java:488-498`) for `Reward/Trade/Punishment/ChangeWeather/SpawnCreature`, `GodActionQueue.submit`
for `buffAvatar`/`restoreAvatar`, Brigadier for `/block` & `/construction`, and the build text scanner (see
[building.md](building.md)).

## Server handle

| Member | Lines | Notes |
|---|---|---|
| `private static volatile MinecraftServer SERVER` | `ChatBotActions.java:47` | Set on `SERVER_STARTED`, nulled on `SERVER_STOPPING` (`ServerEntryPoint.java:46-56`). |
| `setServer(server)` / `server()` | `:49-50` | Used by off-thread watchdog paths. |
| `register()` | `:52-54` | Registers `/block` and `/construction` (called from `ChatBot.register`). |

## Item giving

### Item parsing

Two parsers (bug #6 fixed — splitting on `:` used to reject both a bare `diamond` and the component syntax the `Reward`
tool advertises):

- `getItemFromString(String str)` — the **registry item** only (used by `TradeOffers`): `ItemIds.baseId(str)` strips a
  `[components]` / `{nbt}` suffix, lower-cases, defaults the namespace to `minecraft` (unit-tested, `ItemIdsTest`);
  `Identifier.tryParse` → `Registries.ITEM.getOrEmpty(id).orElse(null)`. Blank / invalid → log `Invalid item string`, `null`.
- `parseItemStack(server, str)` — the **full stack**, parsed exactly like `/give`: `ItemStackArgumentType.itemStack(
  CommandRegistryAccess.of(server.getRegistryManager(), enabledFeatures)).parse(…)`, then `createStack(1, false)`.
  So `minecraft:enchanted_book[minecraft:enchantments={levels:{…}}]` keeps its components. Syntax error → log, `null`.
  (The component *contents* follow vanilla 1.21.1 `/give` syntax; the tool's example text is the model's guide.)

### Methods

| Method | Lines | Behaviour | Returns |
|---|---|---|---|
| `giveItemFromString(player, itemName, amount)` | `ChatBotActions` | `Reward`. `amount < 1` → refused; else clamped to `BridgeConfig.rewardMax` (64) via `GodClamps.rewardAmount`; `parseItemStack`; gives max-size stacks with `offerOrDrop` (what does not fit is dropped at the player's feet). | `"You gave the player a reward: <n> <itemName>[ (limité à <n> sur <asked> demandés)]"` / `"Reward cancelled, amount must be at least 1 (got <a>)."` / `"Reward cancelled, item <itemName> does not exist or is malformed, please try again."` |
| `giveItem(player, Item, amount)` | `ChatBotActions` | `player.giveItemStack(new ItemStack(item, amount))`. No clamp, no overflow drop. Only `giveGoodReward` (unused) calls it now. | void |
| `giveItemWithCommand(player, item, amount)` | `:93-103` | Runs `/give <name> <item> <amount>` as server source. **Unused.** | `""` |
| `giveGoodReward(player)` | `:56-58` | 10 × `Money.MONEY` (`paulsbrawls:coin`, `Money.java:19-23`). **Unused.** | void |
| `giveBadReward(player)` | `:60-62` | One `smite`. **Unused.** | void |
| `stripArguments(str, commandName)` | `:110-117` | **Unused and broken**: `split(regex, 1)` always yields one element, so it always returns `null`. | `null` |

> `Reward` no longer uses `giveItemStack`: `PlayerInventory.offerOrDrop` drops the overflow, and a non-positive amount is
> refused before anything is parsed (bug #6).

## Punishment — `smite`

| Method | Lines | Behaviour |
|---|---|---|
| `smite(player, int amount)` | `ChatBotActions` | Strikes `GodClamps.punishments(amount, BridgeConfig.punishmentMax)` times (0..3 by default, bug #6). Returns `"God punished the player <n> times.[ (limité à <n> sur <asked> demandés)]"`. |
| `smite(player)` | `:151-160` | `EntityType.LIGHTNING_BOLT.create(world)`, `refreshPositionAfterTeleport(blockX, blockY, blockZ)` (block corner, not centred), `world.spawnEntity`. Null-safe on player/world. |

All bolts of one call spawn in the same tick at the same position.

## ChangeWeather

`changeWeather(player, weatherType, durationSeconds)`, `ChatBotActions.java:317-327`:

- Null player/server → `"Impossible de changer la météo : joueur ou serveur invalide."`
- Executes `"/weather " + weatherType.toLowerCase() + " " + durationSeconds` via
  `server.getCommandManager().executeWithPrefix(server.getCommandSource(), …)` (server source = full permissions).
- Returns `"La météo a été changée en <weatherType> pour <n> secondes."` if `durationSeconds > 0`, else
  `"… pour une durée indéterminée."` — regardless of whether the command succeeded.
- `weatherType` is not validated (null → NPE → caught upstream as a server-side error string) and is concatenated
  into a command string.

> ⚠ Unverified (no MC sources in checkout): in Minecraft ≥ 1.19.4 the `/weather` duration is a *time* argument where a
> bare integer means **ticks** and the minimum is 1. If so, `durationSeconds=30` yields 1.5 s of weather and `0`
> (documented as "permanent") makes the command fail — while the tool still reports success.

## SpawnCreature — `spawnCreature(player, entityType, count, x, y, z)`

`ChatBotActions.java:336-380`:

1. Player null or world not a `ServerWorld` → `"Impossible de spawner : joueur ou monde invalide."`
2. Blank `entityType` → `"Spawn annulé : entityType vide."`
3. `Identifier.of(entityType.trim())` fails → `"Spawn annulé : identifiant invalide '<entityType>'."`
   (a bare `zombie` defaults to the `minecraft` namespace).
4. Not in `Registries.ENTITY_TYPE` → `"Spawn annulé : type d'entité inconnu '<entityType>'."`
5. `clamped = max(1, min(count, max(1, BridgeConfig.spawnCountMax)))` — default cap 8 (`BridgeConfig.java:54`);
   `count <= 0` still spawns 1.
6. `basePos = player.getBlockPos().add(…)` with each offset clamped to `±BridgeConfig.spawnOffsetMax` (16) by
   `GodClamps.spawnOffset` (bug #6 — they used to be unclamped).
7. For `i in 0..clamped-1`: position `basePos + ((i % 3) - 1, 0, ((i / 3) % 3) - 1)` (3×3 fan, repeats after 9),
   `type.create(world)`, `refreshPositionAndAngles(x+0.5, y, z+0.5, playerYaw + 180, 0)`; if
   `!BridgeConfig.creatureGriefingAllowed` (default `false`) and it is a `MobEntity`, `setCanPickUpLoot(false)`;
   `world.spawnEntity` → counts successes.
8. Returns `"God a fait apparaître <spawned> <entityType>[s] près du joueur[ (griefing désactivé)]."`.

Sharp edges: "griefing disabled" only stops loot pickup (creepers still explode, endermen still take blocks); entities
are created with `EntityType.create` without spawn initialization (no random equipment/variants); no check that the
position is free.

## Block placement

Used by `/block`, the build bots' textual calls, and `BuildSubAgent` (semantics in [building.md](building.md)).

| Method | Lines | Behaviour |
|---|---|---|
| `placeBlock(player, x, y, z, blockType)` | `:206-213` | Pivot = `Raycaster.getLastPos(uuid)`; no-op if null; `placeBlockAt`. |
| `placeLine(player, x,y,z, x2,y2,z2, blockType)` | `:197-204` | Same pivot lookup; `placeLineAt`. |
| `placeBlocks(player, int[] x, int[] y, int[] z, blockType)` | `:215-222` | Same pivot lookup; `placeBlocksAt`. |
| `placeBlockAt(player, pivot, x, y, z, blockType)` | `:224-228` | `changeBlockAtPos(pivot + (x,y,z))`. |
| `placeLineAt(...)` | `:230-242` | DDA line: `maxLen = max(1, max(|dx|,|dy|,|dz|))`, `i = 0..maxLen` inclusive, integer division per axis. |
| `placeBlocksAt(...)` | `:244-249` | Zips the three arrays up to the shortest length. |
| `changeBlockAtPos(player, blockType, pos)` | `:285-290` | `parseBlockState` then `world.setBlockState(pos, state)` (default flags; no drops, no permission check). |
| `parseBlockState(player, blockType)` (private) | `:292-314` | `BlockArgumentParser.block(registryWrapper(BLOCK), blockType, false)`; on syntax error, retries with the part before `[` (state dropped); logs warnings; `null` on failure. Accepts full block-state syntax e.g. `minecraft:oak_stairs[facing=east]`. |

## getBlockInfo

`ChatBotActions.getBlockInfo(player)` (`:252-281`) feeds the 4th system message every godBot turn
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
| `findAvatar(prayingPlayer)` | `:383-389` | Server from the player (or the static `SERVER`), `getPlayerManager().getPlayer(BridgeConfig.botUsername)` (default `LLMBot`). | `ServerPlayerEntity` or `null` |
| `buffAvatar(prayingPlayer)` | `:396-405` | `bot.setInvulnerable(true)` + `bot.extinguish()`. Called on `Appear` via `GodActionQueue`. | `"Avatar rendu invincible."` / `"Avatar introuvable (pas de buff)."` (logs `buffAvatar: bot '<name>' not found (not joined?)`) |
| `restoreAvatar(prayingPlayer)` | `:407-412` | `bot.setInvulnerable(false)`. Called on `Vanish` and `endPrayerSession`. | `"Avatar redevenu mortel."` / `"Avatar introuvable."` |
| `dismissAvatarOnWatchdog(ownerUuid)` | `:418-428` | Off-thread: queues `setInvulnerable(false)` on main thread and calls `GodBody.vanish()` directly. Called by the idle watchdog (`GodSessionManager.java:131`). | void |

`setInvulnerable` sets the entity field that Minecraft serializes as the `Invulnerable` NBT tag. Session/lock
semantics: [god-body.md](god-body.md).

## Trades — `TradeOffers`

### Storage

- `private static final HashMap<UUID, TradeOffer> offers` (`TradeOffers.java:114`) — one pending offer per player,
  **in RAM only**. A new `Trade` call replaces the previous offer. Offers expire `OFFER_TTL_MILLIS` (5 min, `:25`)
  after creation; the expiry is checked lazily on `/accept`. Not thread-safe, but all
  accesses happen on the server thread (`Trade` via `runOnMain`, `/accept` via Brigadier).
- `TradeOffer` (`:27-87`): `giveItemName`, `giveAmount`, `takeItemName`, `takeAmount`, `createdAtMillis`, resolved
  `giveItem`, `takeItem`.
- `MAX_TRADE_AMOUNT = 512` (`:22`); `checkAmounts(give, take)` (`:94-100`) returns
  `"Trade cancelled. giveAmount and takeAmount must both be between 1 and 512 (got <g> and <t>). Please try again."`
  or `null`.

### Offer creation — `updateOffer(player, giveItemName, giveAmount, takeItemName, takeAmount)` (`:161-177`)

0. The `Trade` tool itself calls `checkAmounts` first (`ChatBotFunctions.java:62-63`) and returns its error to the
   model; `updateOffer` repeats the check (`:166-169`), so no out-of-range offer is ever stored.
1. `verifyItems()` (`:41-54`) resolves both names with `ChatBotActions.getItemFromString`; failure returns
   `"Trade cancelled. <name> was not a correct item. Please try again."` (offer not stored).
2. Stores the offer, returns `null`.
3. Caller `ChatBotActions.sendTradeOffer` (`ChatBotActions.java:64-76`) then privately messages the player
   `"God has offered you a trade: \n You receive <giveAmount> <giveItemName> for <takeAmount> <takeItemName>\n Type /accept within 5 minutes."` and
   returns the model-facing `"God offered a trade to the player: God gives … \nThe player may accept or decline this trade."`.

### `/accept` (`:120-159`)

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
   - `decrement`s the planned counts, then `giveItemsOrDrop(player, giveItem, giveAmount)` (`:103-110`): fresh stacks
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
| `/block <x> <y> <z>` (ints) | 2 | `ChatBotActions.java:164-179` | `placeBlock(player, x, y, z, "minecraft:stone")` — **offsets relative to the player's `/construction` pivot**, no-op if none. |
| `/construction` | 2 | `ChatBotActions.java:181-193` | `Raycaster.setLastPos(player)` (100-block look raycast; stores hit pos or `null`) and `ChatBot.buildBot.clearMemory(player)`. See [building.md](building.md). |
| `/accept` | 0 | `TradeOffers.java:120-130` | See above. |

Both `/block` and `/construction` call `getPlayer()` and will fail from the console.

## Gotchas & known issues

- **Fixed — negative `takeAmount` duplicated items** (VERIFICATION-NOTES bug #3): `amount < takeAmount` was false
  for a negative amount and `setCount(count - negative)` *grew* the stack. Amounts are now rejected outside 1–512 at
  tool execution, in `updateOffer` and on `/accept`, and `planTakes` refuses a non-positive need on its own.
- **Fixed — display-name matching**: the take side now uses `stack.isOf(takeItem)`. Components are still ignored
  for matching, so an enchanted or renamed stack of the right item counts (and can be taken).
- `giveItem` (`ChatBotActions.java:106-108`, still used by `Reward`) passes one `ItemStack(item, amount)` to
  `giveItemStack`, whose result is ignored: whatever doesn't fit a full inventory is lost. `/accept` no longer uses it.
- Unclamped `Punishment.amount` (mass lightning in one tick) and `Reward.amount`.
- `changeWeather` duration units and always-success return (see above).
- ~~`getBlockInfo` output is malformed pseudo-JSON~~ fixed (bug #18); it is still keyed off `/construction`, not the
  cursor.
- Dead code: `giveGoodReward`, `giveBadReward`, `giveItemWithCommand`, `stripArguments` (broken).
- Offers expire after 5 minutes (checked on `/accept`, not proactively) and vanish on restart. The God is not told
  when an offer expires.

## Related

- [tools-catalogue.md](tools-catalogue.md) · [llm-pipeline.md](llm-pipeline.md) · [god-body.md](god-body.md)
- [building.md](building.md) · [configuration-and-commands.md](configuration-and-commands.md) · [overview.md](overview.md)
- [../gibber/money-system.md](../gibber/money-system.md)
