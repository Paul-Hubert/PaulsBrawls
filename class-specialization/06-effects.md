# 06 — Effect-application layer

Effects are **two-sided and global**. For a given profession and player there are two cases:

- **Non-chooser** → apply the profession's **malus** (a fixed baseline penalty).
- **Chooser** → remove the malus and apply a **benefit** that scales with that class's Mastery level
  (primary full, secondary ×`secondaryRate`).

So *every* player is affected by *every* profession — penalised at the five they didn't choose, rewarded at
the two they did. Progression (XP/levels) is still chooser-only ([04](04-progression.md)); only the effect
is global.

```java
interface MasteryEffect {
    // recompute a standing capability for this player (chooser: bonus(level); non-chooser: malus)
    default void refresh(ServerPlayerEntity p) {}
    // adjust a discrete transaction (drops/refund/cost); chooser → benefit, non-chooser → malus
    default <T> T transform(EffectContext ctx, T base) { return base; }
}
```

`SkillEffect` (skill-tree nodes) has the same shape, so passive nodes reuse these strategies.

## Two strategies cover the seven classes

| Strategy | Used by | How |
|---|---|---|
| **Mixin-scaled capability** | Mineur, Bûcheron | A mixin on `PlayerEntity#getBlockBreakingSpeed` multiplies by a factor: **<1 (malus)** for non-choosers, **>1 and scaling** for the chooser, gated to ore/log targets. Applies to **all** players, so it is the baseline-slow-mining mechanic and the fast-mining reward in one place. |
| **Transaction transform** | Agriculteur, Éleveur, Artisan, Constructeur, Enchanteur | The hook ([05](05-action-detection.md)) calls `effect.transform(...)`: multiply drops/loot (malus<1 / bonus>1), destroy-or-refund a share of craft materials (Artisan & Constructeur, symmetric), or multiply enchant/anvil XP cost (malus>1 / bonus<1). |

> **No attribute-modifier strategy.** The earlier draft used a movement-speed attribute for Explorateur;
> that class was removed, so no Mastery effect uses attribute modifiers now. (They remain available to
> future skill-tree nodes if a node wants a clean vanilla stat bump.)

> **Version caveat (verify before M3):** 1.21.1 has **no** block-break-speed *attribute* (the player-mining
> attributes land post-1.21.1), so Mineur/Bûcheron use the `getBlockBreakingSpeed` mixin. If the pinned
> version exposes such an attribute, prefer it (cleaner, no hot-path code).

## `EffectApplier`

The single place that, on level change or join, recomputes a player's standing factors and pushes a sync
packet. Because the malus applies to everyone, `refreshAll` runs for **every** joining player — not only those
who chose a capability class.

```java
final class EffectApplier {
    void refresh(ServerPlayerEntity p, PlayerClass cls);  // recompute one profession's standing factor
    void refreshAll(ServerPlayerEntity p);                // on join — covers all 7 professions (malus + bonus)
}
```

## `ClassProfileCache` — the hot-path lookup

The mixin-backed classes read their factor on the per-block `getBlockBreakingSpeed` path, which must not
touch NBT. `ClassProfileCache` keeps a `UUID → EffectFactors` map warm for **every online player** (each
profession resolved to its malus or scaled bonus), updated by `EffectApplier`. O(1), no allocation, no I/O.

```java
final class ClassProfileCache {
    void update(UUID id, EffectFactors f);   // on join + on level change
    EffectFactors get(UUID id);              // mixin reads this; absent ⇒ all-malus factors (fail closed)
    void evict(UUID id);                      // on disconnect
}
// EffectFactors carries: miningSpeed, choppingSpeed, cropYield, animalYield,
//                        artisanRefund, constructeurRefund, enchantCost — each a malus or a bonus.
```

> **Fail-closed default:** a player with no cached factors (e.g. not yet selected) resolves to **all-malus**,
> never to neutral — an unselected player is penalised, not advantaged.

## Transaction transforms — where each lands

| Class | Transform (non-chooser → chooser) | Applied in |
|---|---|---|
| Agriculteur | crop drops ×malus → ×bonus | crop-break hook |
| Éleveur | animal loot ×malus → ×bonus | death hook |
| Artisan | craft destroys a share → refunds a share (tools/weapons/armour) | craft mixin |
| Constructeur | craft destroys a share → refunds a share (construction blocks, **excl. reversible mineral blocks**) | craft mixin (building-block filter) |
| Enchanteur | enchant/anvil XP cost ×(>1 malus) → ×(<1 bonus) | enchant + anvil mixins |

`EffectContext` carries what the transform needs (player, whether chooser + slot/level, the
block/item/recipe in question) so the strategy stays free of Minecraft event plumbing. The Constructeur
filter — "is this a placeable construction block that is *not* reversible into its materials?" — is the
single anti-duplication gate ([05](05-action-detection.md), [00-features.md FR-4](00-features.md)).
