---
id: ctf.capture-the-flag
title: Capture the Flag - FlagManager
system: ctf
summary: Exact rules of the CTF feature - which banners count as a Flag, drop-on-damage mechanics, elytra ban, per-tick glowing, and edge cases. FlagManager.java plus the FlagGlow helper.
tags: [ctf, capture-the-flag, flag, banner, elytra, glowing, damage, FlagManager, events]
sources: [src/main/java/com/paul/brawl/FlagManager.java, src/main/java/com/paul/brawl/FlagGlow.java, src/test/java/com/paul/brawl/FlagGlowTest.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/main/java/com/paul/brawl/VillageHttpListener.java, README.md]
verified_at: 98cb908
---

# Capture the Flag - FlagManager

**TL;DR** — A "Flag" is any banner item anywhere in a player's inventory — main, armour (head) or offhand — whose
displayed name contains the case-sensitive substring `Flag`. While a player carries one: they glow (re-evaluated
every world tick; the mod only ever clears a glow it set), elytra flight is refused, and when they take damage
every such banner is made unbreakable and thrown out of their inventory (bug #11 fixed both the slot scan and the
glow clobbering). There is no team, score, base or capture logic — those
are left to players/command blocks. Everything lives in `FlagManager.java` (with the Minecraft-free decisions in
`FlagGlow.java`) and is registered from
`ServerEntryPoint.java:30` (dedicated server only).

## Registration (`FlagManager.register()`, `FlagManager.java:25-33`)

| Order | Method | Fabric event | Line |
|---|---|---|---|
| 1 | `banElytra()` | `EntityElytraEvents.ALLOW` | `:36-45` |
| 2 | `dropOnHit()` | `ServerLivingEntityEvents.ALLOW_DAMAGE` | `:48-56` |
| 3 | `glowFlagholders()` | `ServerTickEvents.START_WORLD_TICK` + `ServerPlayConnectionEvents.DISCONNECT` + `ServerLifecycleEvents.SERVER_STOPPING` | `:59-67` |

No commands, config or persistence. The only state is the in-memory `FlagGlow` set of players whose glow the mod
turned on (forgotten on disconnect).

## What counts as a Flag — `findFlags(player)` / `checkInventory(player)` (`FlagManager.java:70-92`)

```java
for (var slots : List.of(inv.main, inv.armor, inv.offHand))
    for (var stack : slots)
        if (!stack.isEmpty() && stack.getItem() instanceof BannerItem
                && FlagGlow.isFlagName(stack.getName().getString())) out.add(stack);
```

`checkInventory` returns the first of `findFlags`, or `null`.

| Rule | Exact behaviour |
|---|---|
| Item type | `instanceof net.minecraft.item.BannerItem` — any banner colour/pattern (not shields, not placed banner blocks) |
| Name test | `FlagGlow.isFlagName` = `name.contains("Flag")` (`FlagGlow.java:35-37`) — **case-sensitive substring** (unit-tested): `Flag`, `Red Flag`, `Flags`, `MyFlagX` match; `flag`, `FLAG`, `Drapeau` do not |
| Name source | `getName()` = custom name (anvil/`custom_name` component) if set, otherwise the default item name resolved on the server; vanilla banner default names do not contain `Flag` |
| Slots scanned | `main` (hotbar + 27 storage), then `armor` (a banner can be worn on the head), then `offHand` (bug #11 — only `main` used to be scanned) |
| Result | `findFlags`: every matching stack in that order; `checkInventory`: the first, or `null` |
| Entities | Only `ServerPlayerEntity` (real players and Mineflayer bots); mobs carrying banners are ignored |

## Drop on damage — `dropOnHit()` / `dropItem()`

On every `ALLOW_DAMAGE` callback for a `ServerPlayerEntity`, for **each** stack in `findFlags(player)`:

1. A null/empty stack is skipped.
2. `item.set(DataComponentTypes.UNBREAKABLE, new UnbreakableComponent(true))` (`:99`) — marks the banner
   unbreakable (banners have no durability; this mainly tags it and shows an "Unbreakable" tooltip line).
3. `player.dropItem(item.copyAndEmpty(), true, false)` (`:100`) — empties the slot and spawns the item
   entity with `throwRandomly = true` (scattered like a death drop) and `retainOwnership = false` (anyone,
   including the victim, can pick it up immediately per vanilla rules).
4. Returns `true` — **the damage itself is never cancelled** (`:54`).

Properties of this rule:

- Any damage source triggers it: melee, projectiles, fall, fire, drowning, starvation, `/damage`, etc.
  The attacker is not inspected.
- **Every** Flag stack drops on one damage event (it used to be one per hit).
- The whole stack drops (banners stack to 16).
- It runs in `ALLOW_DAMAGE`, i.e. before the damage is applied, so a hit that kills still drops the Flag
  through this path first.

> ⚠ Unverified: which damage checks (invulnerability, creative mode, damage cooldown) Fabric API
> 0.116.7 performs before invoking `ALLOW_DAMAGE` — that is Fabric's mixin, not repo code.

## Elytra ban — `banElytra()` (`FlagManager.java:36-45`)

`EntityElytraEvents.ALLOW` handler: if the entity is a `ServerPlayerEntity` and `checkInventory` finds a
Flag, return `false` (flight not allowed); otherwise `true`. Fabric API consults `ALLOW` when elytra flight
starts and while it continues, so picking up a Flag mid-glide should end the glide.

> ⚠ Unverified: the exact call sites of `EntityElytraEvents.ALLOW` in Fabric API (start vs. per-tick).
> The handler is only registered on the dedicated server; the client never runs it, so a flag-carrying
> client may briefly predict flight before the server corrects it.

## Glowing — `glowFlagholders()` / `updateGlow()`

On `START_WORLD_TICK` (called once per loaded world/dimension per server tick — the lambda parameter is
named `server` but is a `ServerWorld`), for each player in that world:
`FlagGlow.update(uuid, hasFlag, player.isGlowing())` (`FlagGlow.java:19-27`) decides and `updateGlow`
(`FlagManager.java:105-111`) applies it (unit-tested, `FlagGlowTest`):

| Has a Flag | Glowing now | Mod set it? | Action |
|---|---|---|---|
| yes | no | — | `setGlowing(true)`, remember the player |
| yes | yes | yes | nothing |
| yes | yes | no (another source) | nothing — the foreign glow is not adopted |
| no | — | yes | `setGlowing(false)`, forget the player |
| no | — | no | nothing |

- Leaving: vanilla saves the glowing flag with the player (`Glowing` NBT), so on `DISCONNECT` (before the player is
  saved) and on `SERVER_STOPPING` (before `saveAllPlayerData`) the mod clears a glow it owns. Otherwise a Flag carrier
  who logged out came back glowing with no owner, and the glow could never be cleared (review fix). A hard crash skips
  both hooks; the glow then persists from the last autosave.
- Cost: one 41-slot scan per player per tick.
- Bug #11: the glow used to be **forced every tick** (`setGlowing(false)` on every player without a Flag), clobbering
  `/data merge entity … {Glowing:1b}` and similar. Now only a glow the mod set is ever cleared.
  > ⚠ Unverified: whether the vanilla *Glowing status effect* shares the entity flag in 1.21.1 (if it does, a player
  > who was already glowing from it when picking up a Flag is left alone, which is the intended behaviour).
- Glow uses the player's scoreboard team colour (vanilla outline behaviour), which is how teams can be
  distinguished.

## Interactions with other systems

- **Village settlement** (`VillageHttpListener`) moves the real stacks, so a traded Flag banner keeps its
  custom name and stays a Flag (only main/hotbar slots are tradeable). See
  [../eden/java-integration.md](../eden/java-integration.md).
- Mineflayer bots (God avatar, Eden villagers) are `ServerPlayerEntity`s and obey all three rules.
- Nothing else in `src/` references `FlagManager` (only `ServerEntryPoint` and a javadoc link in `FlagGlow`).

## How to modify

| Want | Change |
|---|---|
| Case-insensitive / exact name | Edit `FlagGlow.isFlagName` (`FlagGlow.java:35-37`; update `FlagGlowTest`) |
| Drop only on PvP hits | In `dropOnHit`, check `source.getAttacker() instanceof PlayerEntity` before dropping |
| Drop one Flag per hit | Use `checkInventory` instead of looping over `findFlags` in `dropOnHit` |

## Gotchas & known issues

- ~~Flag in offhand or on the head bypasses glow, elytra ban and drop~~ **Fixed (bug #11).**
- Case-sensitive substring match — "flag" is not a Flag; "Flagpole" is.
- Environmental damage (fall, cactus, hunger) makes you drop the Flag too (unchanged; listed in bug #11, not a
  slot/glow defect).
- ~~One stack per hit~~ every Flag stack drops.
- ~~Per-tick `setGlowing(false)` clobbers glowing set by other means~~ **Fixed (bug #11).**
- Only the decisions are unit-tested; the event wiring needs an in-game check.
- Integrated (single-player/LAN) servers do not run `ServerEntryPoint`, so CTF is inactive there.

## Related

- [../platform/entrypoints-and-wiring.md](../platform/entrypoints-and-wiring.md)
- [../eden/java-integration.md](../eden/java-integration.md)
- [../00-overview.md](../00-overview.md)
