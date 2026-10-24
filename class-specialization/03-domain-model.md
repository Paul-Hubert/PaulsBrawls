# 03 — Domain model

All types under `com.paul.brawl.classes` (server/shared). Sketches are illustrative, not final signatures.

## `PlayerClass` (enum) — the seven classes

The single source of "which classes exist." Stable string `id` (used in NBT + packets + lang), display
key, icon id. **Seven classes** — there is no Explorateur (removed; see [10 DP-4](10-decisions-risks.md)).

```java
enum PlayerClass {
    MINER("mineur"), LUMBERJACK("bucheron"), FARMER("agriculteur"), BREEDER("eleveur"),
    ARTISAN("artisan"), BUILDER("constructeur"), ENCHANTER("enchanteur");
    final String id;                 // persisted; never change once shipped
    // displayKey() -> "paulsbrawls.class.<id>.name"; icon() -> Identifier
    static PlayerClass byId(String id); // null-safe lookup for deserialization
}
```

> **Invariant:** `id` strings are a persisted contract. Renaming one silently orphans saved profiles.

## `ClassDefinition` (interface) — the per-class behavior bundle

```java
interface ClassDefinition {
    PlayerClass type();
    Text displayName();          // FR
    Identifier icon();           // menu / toast icon
    MasteryCurve curve();        // xp -> level -> tier            (04)
    MasteryEffect effect();      // how the passive bonus applies  (06)
    SkillTree skillTree();       // node graph (data)              (04)
    // XP *sources* are registered separately (05) so the engine stays event-agnostic.
}
```

XP sources are intentionally **not** on the definition — they are wired in the action-detection layer so
the engine never needs to know about Minecraft events. The definition is pure "what this class is and
what its progression does."

## `ClassRegistry`

```java
final class ClassRegistry {
    private final Map<PlayerClass, ClassDefinition> defs = new EnumMap<>(PlayerClass.class);
    void register(ClassDefinition d);
    ClassDefinition get(PlayerClass c);
    Collection<ClassDefinition> all();
}
```

Populated once in `ClassSystem.register()` with all eight definitions — **explicit registration, no
reflection or classpath scanning** (matches the mod's `register()` idiom and Eden's "no plugin loaders"
rule). A unit test asserts every `PlayerClass` has a registered definition and all ids are unique.

## `ClassProfile` — per-player state

```java
final class ClassProfile {
    PlayerClass primary;
    PlayerClass secondary;
    Map<PlayerClass, MasteryTrack> mastery;  // exactly the two chosen classes (OD-3)
    Map<PlayerClass, SkillTrack>  skills;     // exactly the two chosen classes
    Slot slotOf(PlayerClass c);               // PRIMARY | SECONDARY | NONE
}
```

`slotOf` drives the secondary-rate multiplier (OD-2) and the "do you own this class?" gate every action
detector checks. A class not in `{primary, secondary}` returns `NONE` and earns no XP (OD-3) — but
`NONE` still receives that profession's **malus** in the effect layer (DP-1, [06](06-effects.md)); only
*progression* is gated by `slotOf`, not the effect.

## `MasteryTrack` / `SkillTrack`

```java
final class MasteryTrack { long xp; }              // level & tier are DERIVED from xp (04), never stored
final class SkillTrack   { int unspentPoints; Set<String> unlocked; } // unlocked = node ids
```

- **One writer per state:** `MasteryTrack.xp` is written only by `Progression.award`. `SkillTrack`'s
  `unspentPoints` is incremented only by the tier-crossing branch of `award`, and decremented only by the
  `AllocateSkillNode` handler. `unlocked` grows only on a validated allocation.
- `level`/`tier` are computed on read via the class's `MasteryCurve`, so XP is the only stored truth and
  curve re-tuning doesn't require a data migration.

See [07-persistence.md](07-persistence.md) for the NBT encoding of these types.
