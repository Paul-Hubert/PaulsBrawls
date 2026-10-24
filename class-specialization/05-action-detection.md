# 05 — Action-detection layer (XP sources + effect hooks)

Each class declares **how the world tells it an action happened**. These are the only Minecraft-specific
hooks. A single hook does **two** things:

1. **Earn XP** — if the acting player **chose** this class (`profile.slotOf(cls) != NONE`), call
   `Progression.award(player, cls, xp)`.
2. **Apply the effect** — for **every** player, apply this profession's malus (non-chooser) or benefit
   (chooser, scaled by Mastery level) via `effect.transform(...)` / the capability mixin ([06](06-effects.md)).

So XP accrual is **chooser-only**, but the malus/benefit is **always-on for everyone** — that is the
subtractive-specialization model ([01](01-overview.md)).

`ActionDetectors.register()` wires all of them. Mixins live under `com.paul.brawl.classes.mixin`, behind the
feature's own `paulsbrawls.classes.mixins.json`.

| Class | Signal | Mechanism | XP to chooser | Effect to everyone |
|---|---|---|---|---|
| Mineur | ore broken | `PlayerBlockBreakEvents.AFTER`, ore tag | yes | break-speed factor (mixin, [06](06-effects.md)) |
| Bûcheron | log broken | `PlayerBlockBreakEvents.AFTER`, `BlockTags.LOGS` | yes | break-speed factor (mixin) |
| Agriculteur | mature crop broken | `PlayerBlockBreakEvents.AFTER`, mature `CropBlock` | yes | crop-drop multiplier (malus<1 / bonus>1) |
| Éleveur | animal killed | `ServerLivingEntityEvents.AFTER_DEATH`, player attacker + animal | yes | loot multiplier (malus<1 / bonus>1) |
| Éleveur | animals bred | **mixin** `AnimalEntity#breed` | yes (XP only) | — |
| Artisan | tool/weapon/armour crafted | **mixin** `CraftingResultSlot#onTakeItem` | yes | material refund (chooser) / destroy (non-chooser) |
| Constructeur | construction block crafted | same craft mixin, **building-block filter** (excl. reversible mineral blocks) | yes | material refund (chooser) / destroy (non-chooser) |
| Enchanteur | item/book enchanted | **mixin** `EnchantmentScreenHandler#onButtonClick` **and** `AnvilScreenHandler` cost | yes | XP-cost multiplier (malus>1 / bonus<1) |

The capability factors (mining/chopping break speed) are not applied here but on the per-block
`getBlockBreakingSpeed` path; this table lists where they are *configured* and where XP/transaction effects fire.

## Why detection and effect are co-located

For every class, the effect is a transformation of (or is gated to) the very transaction the detector
observes — drops on a crop break, loot on a kill, materials on a craft, XP cost on an enchant. So the same
hook both awards XP (if chooser) and calls `effect.transform(...)` (for everyone). The two
**continuous-capability** classes (Mineur, Bûcheron) are the exception: their effect alters a standing
capability (break speed) read on the mining path, so it is applied in a mixin rather than at the break event
— the break event only awards XP ([06](06-effects.md)).

## Anti-abuse notes

- **Constructeur duplication (load-bearing):** the material-refund benefit is applied **only** to
  construction blocks that **cannot be uncrafted back into their materials**. Reversible compressed-mineral
  storage blocks (iron, gold, diamond, emerald, lapis, redstone, coal, netherite, …) are **excluded** from
  both malus and benefit — otherwise a refund on a reversible craft is free duplication. The block filter is
  the single source of truth for "is this a Constructeur block?" ([00-features.md FR-4](00-features.md)).
- **Crop replant loop:** Agriculteur awards/affects only on **mature** crop break, so immediate replant→break
  gives nothing until regrowth.
- **Craft-fail symmetry:** the Artisan/Constructeur penalty (destroy a share of materials) and benefit
  (recover a share) are mirror images of one percentage; capture the share in code, let config set its size.
- Every detector reads the loaded profile; an unselected player (no profile) earns no XP but **still suffers
  every malus** (fails closed toward the penalty, not toward a free pass).
