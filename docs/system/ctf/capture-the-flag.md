---
id: ctf.capture-the-flag
title: Capture the Flag - FlagManager
system: ctf
summary: Exact rules of the CTF feature - which banners count as a Flag, drop-on-damage mechanics, elytra ban, per-tick glowing, and edge cases. All in FlagManager.java.
tags: [ctf, capture-the-flag, flag, banner, elytra, glowing, damage, FlagManager, events]
sources: [src/main/java/com/paul/brawl/FlagManager.java, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/main/java/com/paul/brawl/VillageHttpListener.java, README.md]
verified_at: 4a8081f
---

# Capture the Flag - FlagManager

**TL;DR** — A "Flag" is any banner item in a player's 36-slot main inventory whose displayed name
contains the case-sensitive substring `Flag`. While a player carries one: they glow (re-evaluated every
world tick), elytra flight is refused, and the first time they take damage the first such banner is made
unbreakable and thrown out of their inventory. There is no team, score, base or capture logic — those
are left to players/command blocks. Everything lives in `FlagManager.java` and is registered from
`ServerEntryPoint.java:30` (dedicated server only).

## Registration (`FlagManager.register()`, `FlagManager.java:18-26`)

| Order | Method | Fabric event | Line |
|---|---|---|---|
| 1 | `banElytra()` | `EntityElytraEvents.ALLOW` | `:29-38` |
| 2 | `dropOnHit()` | `ServerLivingEntityEvents.ALLOW_DAMAGE` | `:41-49` |
| 3 | `glowFlagholders()` | `ServerTickEvents.START_WORLD_TICK` | `:52-59` |

No commands, config, persistence or state are involved.

## What counts as a Flag — `checkInventory(player)` (`FlagManager.java:61-72`)

```java
for (var stack : player.getInventory().main) {
    if (!stack.isEmpty() && stack.getItem() instanceof BannerItem) {
        if (stack.getName().getString().contains("Flag")) return stack;
    }
}
return null;
```

| Rule | Exact behaviour |
|---|---|
| Item type | `instanceof net.minecraft.item.BannerItem` — any banner colour/pattern (not shields, not placed banner blocks) |
| Name test | `stack.getName().getString().contains("Flag")` — **case-sensitive substring**: `Flag`, `Red Flag`, `Flags`, `MyFlagX` match; `flag`, `FLAG`, `Drapeau` do not |
| Name source | `getName()` = custom name (anvil/`custom_name` component) if set, otherwise the default item name resolved on the server; vanilla banner default names do not contain `Flag` |
| Slots scanned | `PlayerInventory.main` only (hotbar + 27 storage slots). **Offhand and armor/head slots are not scanned** — a Flag held in the offhand or worn on the head is invisible to every rule |
| Result | The **first** matching stack in slot order, or `null` |
| Entities | Only `ServerPlayerEntity` (real players and Mineflayer bots); mobs carrying banners are ignored |

## Drop on damage — `dropOnHit()` / `dropItem()` (`FlagManager.java:41-49`, `:74-82`)

On every `ALLOW_DAMAGE` callback for a `ServerPlayerEntity`:

1. `item = checkInventory(player)`; if null/empty, nothing happens.
2. `item.set(DataComponentTypes.UNBREAKABLE, new UnbreakableComponent(true))` (`:79`) — marks the banner
   unbreakable (banners have no durability; this mainly tags it and shows an "Unbreakable" tooltip line).
3. `player.dropItem(item.copyAndEmpty(), true, false)` (`:80`) — empties the slot and spawns the item
   entity with `throwRandomly = true` (scattered like a death drop) and `retainOwnership = false` (anyone,
   including the victim, can pick it up immediately per vanilla rules).
4. Returns `true` — **the damage itself is never cancelled** (`:47`).

Properties of this rule:

- Any damage source triggers it: melee, projectiles, fall, fire, drowning, starvation, `/damage`, etc.
  The attacker is not inspected.
- Only **one** Flag stack drops per damage event; a player carrying two Flag stacks loses the second on
  the next hit.
- The whole stack drops (banners stack to 16).
- It runs in `ALLOW_DAMAGE`, i.e. before the damage is applied, so a hit that kills still drops the Flag
  through this path first.

> ⚠ Unverified: which damage checks (invulnerability, creative mode, damage cooldown) Fabric API
> 0.116.7 performs before invoking `ALLOW_DAMAGE` — that is Fabric's mixin, not repo code.

## Elytra ban — `banElytra()` (`FlagManager.java:29-38`)

`EntityElytraEvents.ALLOW` handler: if the entity is a `ServerPlayerEntity` and `checkInventory` finds a
Flag, return `false` (flight not allowed); otherwise `true`. Fabric API consults `ALLOW` when elytra flight
starts and while it continues, so picking up a Flag mid-glide should end the glide.

> ⚠ Unverified: the exact call sites of `EntityElytraEvents.ALLOW` in Fabric API (start vs. per-tick).
> The handler is only registered on the dedicated server; the client never runs it, so a flag-carrying
> client may briefly predict flight before the server corrects it.

## Glowing — `glowFlagholders()` (`FlagManager.java:52-59`, `:84-86`)

On `START_WORLD_TICK` (called once per loaded world/dimension per server tick — the lambda parameter is
named `server` but is a `ServerWorld`), for each player in that world:
`player.setGlowing(checkInventory(player) != null)`.

- Cost: one 36-slot scan per player per tick.
- The glowing flag is **forced every tick**: players without a Flag are set to `setGlowing(false)` 20
  times a second, which overrides any other source that uses the same entity glowing flag (e.g.
  `/data merge entity … {Glowing:1b}` on a player).
  > ⚠ Unverified: whether the vanilla *Glowing status effect* (spectral arrows, `/effect`) shares this
  > flag in 1.21.1 and is therefore also suppressed.
- Glow uses the player's scoreboard team colour (vanilla outline behaviour), which is how teams can be
  distinguished.

## Interactions with other systems

- **Village settlement** (`VillageHttpListener`) moves the real stacks, so a traded Flag banner keeps its
  custom name and stays a Flag (only main/hotbar slots are tradeable). See
  [../eden/java-integration.md](../eden/java-integration.md).
- Mineflayer bots (God avatar, Eden villagers) are `ServerPlayerEntity`s and obey all three rules.
- Nothing else in `src/` references `FlagManager`.

## How to modify

| Want | Change |
|---|---|
| Case-insensitive / exact name | Edit the predicate at `FlagManager.java:65` |
| Include offhand/armor | Iterate `player.getInventory().offHand` / `.armor` (or all `size()` slots) in `checkInventory` |
| Drop only on PvP hits | In `dropOnHit`, check `source.getAttacker() instanceof PlayerEntity` before dropping |
| Drop every Flag stack | Loop until `checkInventory` returns null |

## Gotchas & known issues

- Flag in offhand or on the head bypasses glow, elytra ban and drop (main inventory only).
- Case-sensitive substring match — "flag" is not a Flag; "Flagpole" is.
- Environmental damage (fall, cactus, hunger) makes you drop the Flag too.
- One stack per hit.
- The comment above `glowFlagholders` says "ban elytra" (copy-paste, `FlagManager.java:51`).
- Per-tick `setGlowing(false)` clobbers glowing set by other means on players.
- Integrated (single-player/LAN) servers do not run `ServerEntryPoint`, so CTF is inactive there.

## Related

- [../platform/entrypoints-and-wiring.md](../platform/entrypoints-and-wiring.md)
- [../eden/java-integration.md](../eden/java-integration.md)
- [../00-overview.md](../00-overview.md)
