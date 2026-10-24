# 04 — Progression: Mastery, tiers, skill points, skill trees

## One XP bar per class (OD-1)

A class has **one** XP pool, fed by its actions, that drives the **Mastery** track. There is **no second
XP source**. Skill points come from Mastery tier-ups.

```
class action ──▶ XP (single bar) ──▶ Mastery level ──▶ tier crossed
                                                            │
                                                            └─▶ +N skill points ──▶ spend in skill tree
```

## Mastery curve & tiers

`MasteryCurve` is two pure functions (trivially unit-testable, no game state):

```java
interface MasteryCurve {
    int levelForXp(long xp);     // monotonic; e.g. geometric/polynomial — CONFIG
    int tierForLevel(int level); // groups levels into named paliers, e.g. every 10 levels
}
```

A **tier (palier)** is a named milestone with an icon, used for the pop-up and the menu header:

```java
record Tier(int index, String nameKey, Identifier icon) {}  // nameKey -> "paulsbrawls.class.tier.<n>"
```

`level` and `tier` are **derived from `xp`** on read — never stored ([03](03-domain-model.md),
[07](07-persistence.md)) — so the curve can be re-tuned without migrating saves.

## `Progression.award` — the single mutation path

```java
void award(ServerPlayerEntity p, PlayerClass cls, long baseXp) {
    Slot slot = profile.slotOf(cls);
    if (slot == Slot.NONE) return;                          // OD-3: only chosen classes accrue
    long xp = Math.round(baseXp * rateFor(slot));            // OD-2: primary 1.0, secondary secondaryRate
    MasteryTrack t = profile.mastery.get(cls);
    int beforeTier = curve.tierForLevel(curve.levelForXp(t.xp));
    t.xp += xp;
    int afterTier  = curve.tierForLevel(curve.levelForXp(t.xp));
    if (afterLevel != beforeLevel) effectApplier.refresh(p, cls);   // 06
    if (afterTier  != beforeTier) {
        profile.skills.get(cls).unspentPoints += pointsPerTier * (afterTier - beforeTier); // OD-1
        net.sendTierUp(p, cls, afterTier);                  // 08 — the pop-up
    }
    state.markDirtyDebounced();                             // 07
    net.syncProfile(p);                                     // 08 (debounced for hot accrual)
}
```

`award` is the **sole writer** of `MasteryTrack.xp` and the sole grantor of skill points. `rateFor`,
`pointsPerTier`, and the curve parameters are config ([09](09-commands-config.md)).

## Primary vs secondary (OD-2)

`rateFor(PRIMARY) = 1.0`, `rateFor(SECONDARY) = secondaryRate` (config, default ~0.5). The same multiplier
applies to the **benefit** side of effects (e.g. a secondary Farmer gets a smaller yield bonus) so the
secondary slot is uniformly weaker without any structural branching. The **malus** side is *not*
slot-scaled — every non-chooser suffers the same flat penalty regardless of their other classes (DP-1,
[06](06-effects.md)).

> **Scope reminder:** `award` (XP/levels) runs **only for the two chosen classes** (OD-3). The malus, by
> contrast, is applied by the effect layer to *every* player for *every* un-chosen profession — that path
> does not go through `award`.

## Skill tree (data)

The skill tree is a **DAG of nodes** — pure data per class, no engine change to grow it:

```java
record SkillNode(String id, int cost, List<String> prerequisites, SkillEffect effect) {}
final class SkillTree { Collection<SkillNode> nodes(); SkillNode node(String id); }
```

Allocation is **server-validated** ([08](08-networking-ui.md)):
1. node exists in the class's tree, and
2. every prerequisite is already in `SkillTrack.unlocked`, and
3. `unspentPoints >= cost`, and
4. the node isn't already unlocked.

On success: `unspentPoints -= cost`, `unlocked.add(id)`, apply `effect`, resync.

`SkillEffect` mirrors `MasteryEffect` ([06](06-effects.md)): passive nodes adjust attributes/factors;
"active" nodes register a trigger. Trees start small (a few nodes per class) and grow as data.
