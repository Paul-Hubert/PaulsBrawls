# 08 — Networking, selection flow & client UI

## Networking

All payloads are `CustomPayload` records with `PacketCodec`s, exactly like
[../src/main/java/com/paul/brawl/ImagePayload.java](../src/main/java/com/paul/brawl/ImagePayload.java).
Registered + handled in `ClassNetworking` (server) and `ClassClient` (client). Namespace
`Identifier.of("paulsbrawls", "class/…")`.

| Dir | Payload | When | Fields |
|---|---|---|---|
| S2C | `OpenClassSelection` | first join, no profile | — |
| S2C | `ClassProfileSync` | join, after any change | compact full-profile snapshot |
| S2C | `MasteryTierUp` | tier crossed | classId, tierIndex, palierNameKey, icon |
| C2S | `SelectClasses` | from selection screen | primary, secondary |
| C2S | `AllocateSkillNode` | from skill-tree screen | classId, nodeId |

**Server is authoritative.** C2S packets are *requests*: the server validates (distinct classes; legal
node; prereqs; enough points) and replies with an updated `ClassProfileSync`. The client never mutates
authoritative state — it renders the last sync and shows optimistic affordances only.

Rapid XP from repeated discrete actions (mining a vein, harvesting a field) is **not** synced on every
single action; the client bar interpolates and resyncs on level/tier change (same batching discipline used
elsewhere in the mod).

## First-join selection flow (OD-4)

```
JOIN ─▶ profile exists? ──yes──▶ S2C ClassProfileSync ──▶ play
          │ no
          ▼
   S2C OpenClassSelection ─▶ client opens ClassSelectionScreen (non-dismissable)
          ▼
   player picks primary + secondary (must differ)
          ▼
   C2S SelectClasses{primary, secondary} ─▶ server validates ─▶ createProfile
          ▼
   persist + S2C ClassProfileSync ─▶ play
```

- The JOIN listener is **this feature's own** (additive; see [02](02-architecture.md)).
- **Gate:** server treats "no profile" as no class bonuses and re-sends `OpenClassSelection` every join
  until a valid profile exists; the client screen is non-dismissable. No movement/lobby freeze (OD-4).
- **Disconnect mid-selection:** nothing was written → re-prompted next join. Idempotent.
- **Validation:** primary ≠ secondary, both legal `PlayerClass`. Invalid request → ignored + re-prompt.

## Client UI

Under `com.paul.brawl.classes.client`. The mod already ships a client source set
([../src/client/java/com/paul/brawl/ClientEntryPoint.java](../src/client/java/com/paul/brawl/ClientEntryPoint.java)),
so **custom `Screen`s** are the right tool (richer than a server chest-GUI; we control the client jar).

| Component | Type | Role |
|---|---|---|
| `ClassSelectionScreen` | `Screen` | first-join pick of primary + secondary; sends `SelectClasses`; cannot be dismissed |
| `MasteryMenuScreen` | `Screen` | per-class level, XP bar, current tier/palier, live effect value |
| `SkillTreeScreen` | `Screen` | node graph + prereq lines; click to allocate → `AllocateSkillNode` |
| `MasteryTierToast` | `Toast` | the **pop-up** — icon + palier name, via vanilla `ToastManager`, triggered by `MasteryTierUp` |
| `ClientClassState` | singleton | caches the last `ClassProfileSync`; every screen/HUD reads from it |

- The tier-up **pop-up** the spec calls for = a custom `Toast`: non-blocking, vanilla-styled, no HUD mixin.
- Menus open via the `/class` command and/or a keybind (`KeyBindingHelper`); both open the screen locally
  against `ClientClassState` and request a fresh sync.
- Assets (class + tier icons, lang) live under
  `../src/main/resources/assets/paulsbrawls/` alongside the existing `coin` assets; lang keys are
  namespaced `paulsbrawls.class.*` in both `en_us.json` and `fr_fr.json`.
