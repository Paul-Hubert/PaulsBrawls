# 02 — Architecture

## The organizing idea — *a class is a registry row, not a branch*

There is **one class-agnostic engine** (XP accrual, leveling, persistence, sync, UI) and **seven
data+behavior bundles** plugged into it. Adding or rebalancing a class must never mean editing the
engine — it is a new `ClassDefinition` in `ClassRegistry`, plus at most one action detector, one effect,
and one skill-tree data file.

This mirrors the simplicity rule the Eden subsystem lives by — *additions are registry rows, never
branches* — but is implemented in the plain Fabric/Java idiom already used across the mod: a feature is a
class with a static `register()` that wires its own events, persistence, and commands (see
[../src/main/java/com/paul/brawl/FlagManager.java](../src/main/java/com/paul/brawl/FlagManager.java),
[../src/main/java/com/paul/brawl/Money.java](../src/main/java/com/paul/brawl/Money.java),
[../src/main/java/com/paul/brawl/GibCommand.java](../src/main/java/com/paul/brawl/GibCommand.java)).

## Layer diagram

```
                  ┌─────────────────────────────────────────────────────┐
   game events ──▶│  Action-detection layer  (per-class XP sources)      │  → 05-action-detection.md
                  └───────────────┬─────────────────────────────────────┘
                                  │  Progression.award(player, class, xp)
                  ┌───────────────▼─────────────────────────────────────┐
   ClassRegistry  │  Progression engine  (Mastery curve, tiers,         │  → 04-progression.md
   (7 defs) ─────▶│   skill-point grant, ClassProfile mutation)         │
                  └───────────────┬─────────────────────────────────────┘
            persist │             │ on level/tier change          │ effect refresh
        ┌───────────▼──┐   ┌──────▼───────────┐          ┌────────▼───────────────┐
        │ ClassPersist │   │ S2C sync + popup │          │ Effect-application layer │
        │  -entState   │   │ (CustomPayload)  │          │ (attrs / drops / mixin)  │
        └──────────────┘   └──────────────────┘          └──────────────────────────┘
          07-persistence     08-networking-ui              06-effects.md
```

The five moving parts:

| Part | Role | Doc |
|---|---|---|
| **ClassRegistry + ClassDefinition** | the 7 bundles; the only place "which classes exist" lives | [03](03-domain-model.md) |
| **Action-detection layer** | translate a game event into "player P did class action A" → `award` + apply effect | [05](05-action-detection.md) |
| **Progression engine** | XP → level → tier; grant skill points; mutate `ClassProfile`; fire sync/popup | [04](04-progression.md) |
| **Effect-application layer** | apply each profession's malus (non-chooser) or scaling benefit (chooser) — global, two-sided (2 strategies) | [06](06-effects.md) |
| **Persistence + Networking + UI** | store the profile, sync it, render menus + the tier-up toast | [07](07-persistence.md), [08](08-networking-ui.md) |

## Separation contract (the hard requirement)

The feature lives entirely under **`com.paul.brawl.classes`** (server/shared) and
**`com.paul.brawl.classes.client`** (client). It shares **nothing mutable** with other features.

| Concern | This feature | Shared with others? |
|---|---|---|
| Java package | `com.paul.brawl.classes(.*)` | No — own subtree |
| Persistence | `ClassPersistentState`, NBT key `paulsbrawls_classes` | No — *not* the `gibbers_state` map |
| Networking IDs | `Identifier.of("paulsbrawls", "class/…")` | No — own namespace prefix |
| Lang keys | `paulsbrawls.class.*` | No |
| Mixins | own `paulsbrawls.classes.mixins.json` | No — separate config file |
| Commands | `/class …` | No |

**Total touch-points with existing code — exactly three lines, all additive:**

1. One line in [../src/main/java/com/paul/brawl/ServerEntryPoint.java](../src/main/java/com/paul/brawl/ServerEntryPoint.java) (`onInitializeServer`): `ClassSystem.register();`
2. One line in [../src/client/java/com/paul/brawl/ClientEntryPoint.java](../src/client/java/com/paul/brawl/ClientEntryPoint.java) (`onInitializeClient`): `ClassClient.register();`
3. One entry added to the `mixins` array in [../src/main/resources/fabric.mod.json](../src/main/resources/fabric.mod.json): `"paulsbrawls.classes.mixins.json"`.

It registers its **own** `ServerPlayConnectionEvents.JOIN` listener (Fabric events are multicast, so it
does **not** modify the existing op-on-join handler). It does **not** import or reference `ChatBot`,
`GodBody`, `Village*`, `Eden`, or anything under `../eden/` or `../minecraft-mcp-server/`. The feature can
be deleted by reverting those three lines and removing the package — nothing else breaks.

## Threading

All authoritative logic runs on the **server main thread** inside Fabric event callbacks / command
handlers (no async LLM-style hops like the God code). With Explorateur removed there is **no per-tick
accrual** — every effect fires on a discrete interaction (block break, kill, craft, enchant). The mixin
hot-path (`getBlockBreakingSpeed`, which now runs for **every** player to apply the mining/chopping malus
or bonus) reads from an in-memory `ClassProfileCache`, never NBT ([06-effects.md](06-effects.md)).
