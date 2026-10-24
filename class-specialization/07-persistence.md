# 07 — Persistence

`ClassPersistentState extends PersistentState` — same Minecraft API as
[../src/main/java/com/paul/brawl/PlayerPersistentState.java](../src/main/java/com/paul/brawl/PlayerPersistentState.java),
but a **separate state object** with its own key so it never collides with Gibber's data.

```java
class ClassPersistentState extends PersistentState {
    static final String STATE_KEY = "paulsbrawls_classes";   // NOT "gibbers_state"
    private final Map<UUID, ClassProfile> profiles = new HashMap<>();
    static ClassPersistentState getState(MinecraftServer s);  // getOrCreate via TYPE + STATE_KEY
    ClassProfile profileOf(UUID id);                          // may be null = not selected yet
    ClassProfile createProfile(UUID id, PlayerClass primary, PlayerClass secondary);
    void markDirtyDebounced();                                // see below
}
```

## NBT shape

```
paulsbrawls_classes
└── players (compound: UUID-string → compound)
    └── <uuid>
        ├── primary:   "mineur"
        ├── secondary: "constructeur"
        └── tracks (compound: classId → compound)
            └── <classId>
                ├── masteryXp: long
                ├── points:    int
                └── unlocked:  [ "node_a", "node_b", … ]   (NBT string list)
```

- **Only `masteryXp` (+ skill `points` and `unlocked`) is stored.** `level`/`tier` are derived from
  `masteryXp` on load via the class's `MasteryCurve` ([04](04-progression.md)) — single source of truth,
  no migration on curve re-tuning.
- Deserialization is tolerant: unknown `classId`/node ids and unparsable UUIDs are skipped (mirrors the
  `try/catch` loop in `PlayerPersistentState.fromNbt`), so a removed class never crashes load — e.g. any
  legacy `explorateur` track from an early build is silently dropped on load (DP-4, [10](10-decisions-risks.md)).
- `PlayerClass.byId(...)` resolves the persisted id; a renamed id orphans the entry (don't rename ids —
  see [03](03-domain-model.md)).

## Write discipline

- Rapid discrete actions (mining a vein, harvesting a field) can call `award` many times per second and must
  **not** flush each time. `markDirtyDebounced()` calls `markDirty()` at most once per save window;
  Minecraft's `PersistentStateManager` already batches the actual disk write on world save, so this only
  avoids redundant dirty churn.
- All other mutations (XP from discrete actions, tier-up point grants, node allocation, selection) call
  `markDirtyDebounced()` after mutating in-memory state.

## Offline behavior

Unlike Gibber's salary backlog, class XP has **no offline accrual** — you can't mine while logged out — so
there is no catch-up logic. On join: load the profile if present; otherwise trigger the selection flow
([08](08-networking-ui.md)). On disconnect: evict the player from `ClassProfileCache` ([06](06-effects.md)).

## Alternative considered

Fabric's **Attachment API** (`AttachmentRegistry`) for per-player data was rejected for consistency — the
mod standardizes on `PersistentState`, and a single state object keeps all class data co-located and easy
to inspect/dump. Revisit only if per-entity attachment becomes necessary elsewhere.
