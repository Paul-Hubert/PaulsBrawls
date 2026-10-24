# 10 — Decision log, design principles & risk register

## Design principles (locked)

| # | Principle | Consequence |
|---|---|---|
| DP-1 | **Subtractive specialization.** Every player suffers a standing **malus** on every profession they did not choose; choosing a class removes its malus and grants a benefit that scales with Mastery. | Effects are **global and two-sided** ([06](06-effects.md)); only the two chosen classes earn XP/levels. Effects must fail **closed** (no profile ⇒ all-malus). |
| DP-2 | **Artisan / Constructeur symmetry.** The craft penalty (destroy a share of materials) and benefit (recover a share) are mirror images of one percentage. | One config value drives both directions ([05](05-action-detection.md)). |
| DP-3 | **No reversible-craft refunds.** Constructeur applies only to construction blocks that cannot be uncrafted back into their materials. | Iron/diamond/emerald/… storage blocks are excluded from both malus and benefit — anti-duplication ([00-features.md FR-4](00-features.md)). |
| DP-4 | **Seven classes.** Explorateur (distance/structure → speed) was removed. | No movement-attribute effect, no distance/structure detectors, no per-tick accrual. |

## Decision log (all resolved)

| # | Decision | Resolution | Where it lives |
|---|---|---|---|
| OD-1 | Skill-point source | **One XP bar per class** → Mastery; each tier-up grants `pointsPerTier`. No second XP track. `MasteryTrack.xp` is the only XP field; tier-crossing in `Progression.award` is the sole writer of `SkillTrack.unspentPoints`. | [04](04-progression.md) |
| OD-2 | Primary vs secondary | Primary ×1.0; secondary ×`secondaryRate` (config, default 0.5) on XP **and** on the benefit side of effects (the malus is the same for everyone). | [04](04-progression.md) |
| OD-3 | Progression breadth | Only the chosen **primary + secondary** accrue XP/levels. The other five never progress — they only impose their malus (DP-1). | [03](03-domain-model.md), [06](06-effects.md) |
| OD-4 | Selection gate | Re-prompt + **non-dismissable** screen; "no profile" ⇒ all-malus + re-send `OpenClassSelection` each join. No movement/lobby freeze. | [08](08-networking-ui.md) |
| OD-5 | Respec | **Admin-only** `/class reset` for v1; player-facing respec deferred. | [09](09-commands-config.md) |

These are settled. Each remains a one-liner to revisit later; none blocks M0–M5.

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| **Default malus is a global balance lever** (DP-1) — everyone is bad at the basics | Heavy-handed maluses can make early game miserable | Maluses are config ([09](09-commands-config.md)); tune conservatively and playtest; the malus is a *standing* factor, easy to dial. |
| **Constructeur duplication** via reversible mineral-block crafts | Free material/item duplication | Exclude any block reversible into its materials from both malus and benefit; the block filter is the single gate (DP-3, [05](05-action-detection.md)). |
| Block-break-speed has no attribute on 1.21.1; the mixin now affects **all** players | Per-block overhead on every player's mining | Confirm the version's attribute set before M3; read the factor from `ClassProfileCache` (UUID→factors), not NBT — O(1), no allocation ([06](06-effects.md)). |
| Breeding / crafting / enchanting / anvil have no clean Fabric event | Mixins → tighter coupling to MC internals | Keep each mixin tiny (detect/transform only); all game logic stays in plain classes behind the feature's own mixin config ([05](05-action-detection.md)). |
| Fail-open effects | An unselected or edge-case player could dodge the malus | Effects resolve to **all-malus** when no profile/factors are present — fail closed, never neutral ([06](06-effects.md)). |
| Symmetric craft-fail feels random/punishing | Players lose materials unexpectedly | Clear feedback (sound/message) on a destroyed-materials craft; magnitude is config (DP-2). |
| `PlayerClass.id` rename | Orphans saved profiles | Ids are a persisted contract — never rename once shipped ([03](03-domain-model.md)). |
