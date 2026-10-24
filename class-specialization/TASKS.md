# TASKS — everything to do

The full work breakdown for the Class Specialization feature. Organized into milestones **M0–M5**; each
milestone is independently testable and leaves the mod runnable. Design rationale for any task is in the
numbered docs ([README.md](README.md) has the map). Checkboxes track progress — update them in the same
commit as the code (docs and behavior change together).

**Legend:** `[ ]` todo · `[~]` in progress · `[x]` done. Task ids are `M<n>-<k>`.

---

## Milestone summary

| M | Theme | Outcome | Gate |
|---|---|---|---|
| **M0** | Skeleton & model | Package, registry, profile, persistence, `/class info`; first real Java tests | Server boots; profile persists across restart; `./gradlew test` green |
| **M1** | Selection flow | First-join selection screen → profile created + synced | Fresh player must pick; returning player syncs silently |
| **M2** | Mastery accrual | All 7 classes' detectors → XP → level → tier; tier-up toast; points granted | Class actions raise the bar; toast on tier; points accrue |
| **M3** | Effects (malus + benefit) | Two-sided, global effects: malus for non-choosers, scaling benefit for choosers (mixin + transform) | A chooser gets the benefit; a non-chooser suffers the malus, in-world |
| **M4** | Skill trees | Allocate points → unlock nodes → node effects | Tier-up grants points; allocation unlocks + applies |
| **M5** | Polish | Mastery menu, full FR/EN lang, icons, config file, admin cmds | Full UX, configurable, FR strings |

---

## M0 — Skeleton & model

- [ ] **M0-1** Create package `com.paul.brawl.classes` and `ClassSystem.java` with `static void register()` (the feature's server composition root). For M0 it wires persistence + command only.
- [ ] **M0-2** Wire-in: add `ClassSystem.register();` to [../src/main/java/com/paul/brawl/ServerEntryPoint.java](../src/main/java/com/paul/brawl/ServerEntryPoint.java) `onInitializeServer()` (1 line, additive).
- [ ] **M0-3** `PlayerClass` enum — 8 constants with stable `id`, `displayKey()`, `icon()`, `byId(String)`. ([03](03-domain-model.md))
- [ ] **M0-4** `ClassDefinition` interface + `ClassRegistry` (`EnumMap`, `register/get/all`). ([03](03-domain-model.md))
- [ ] **M0-5** Seven stub `ClassDefinition`s (name + icon; `curve`/`effect`/`skillTree` return safe no-op defaults for now) registered in `ClassSystem`. (No Explorateur — DP-4.)
- [ ] **M0-6** `ClassProfile` (`primary`, `secondary`, the two track maps, `slotOf`), `MasteryTrack`, `SkillTrack`. ([03](03-domain-model.md))
- [ ] **M0-7** `ClassPersistentState extends PersistentState` — `STATE_KEY="paulsbrawls_classes"`, `getState`, `profileOf`, `createProfile`, NBT read/write per [07](07-persistence.md), tolerant deserialization, `markDirtyDebounced()`.
- [ ] **M0-8** `ClassCommand.register()` with `/class info [player]` printing the profile.
- [ ] **M0-9** Stub lang keys (`paulsbrawls.class.<id>.name`) in `en_us.json` + `fr_fr.json`.
- [ ] **M0-10** **First Java tests** (`src/test/java/...`): NBT round-trip (profile → NBT → profile equals), registry completeness (every `PlayerClass` registered, ids unique), `byId` null-safety.

**M0 acceptance:** `./gradlew build` compiles; `./gradlew runServer` boots; `/class set` (debug) + restart shows the profile survives via `/class info`; `./gradlew test` is green (these are the repo's first real Java tests).

---

## M1 — First-join selection flow

- [ ] **M1-1** `ClassClient.java` (client composition root) + add `ClassClient.register();` to [../src/client/java/com/paul/brawl/ClientEntryPoint.java](../src/client/java/com/paul/brawl/ClientEntryPoint.java) (1 line).
- [ ] **M1-2** Payload records + codecs: `OpenClassSelection` (S2C), `SelectClasses` (C2S), `ClassProfileSync` (S2C). Namespace `class/…`. ([08](08-networking-ui.md))
- [ ] **M1-3** `ClassNetworking` (server): register payload types; `SelectClasses` handler validates distinct/legal classes, `createProfile`, persist, reply `ClassProfileSync`. Fail closed + re-prompt on invalid.
- [ ] **M1-4** Client handlers: on `OpenClassSelection` open screen; on `ClassProfileSync` update `ClientClassState`.
- [ ] **M1-5** `ClientClassState` singleton (cached last sync).
- [ ] **M1-6** `ClassSelectionScreen` — non-dismissable, pick primary + secondary (must differ), send `SelectClasses`.
- [ ] **M1-7** Own `ServerPlayConnectionEvents.JOIN` listener in `ClassSystem`: profile present → sync; absent → `OpenClassSelection`.
- [ ] **M1-8** Tests: selection validation (distinct + legal) as pure logic; payload codec round-trip where feasible.

**M1 acceptance:** a fresh player is forced into the selection screen, picks two distinct classes, profile is created + persisted; a returning player joins straight into play with a silent sync; disconnecting mid-selection re-prompts next join.

---

## M2 — Mastery accrual

- [ ] **M2-1** `MasteryCurve` (`levelForXp`, `tierForLevel`) + `Tier` record; config-backed parameters. ([04](04-progression.md))
- [ ] **M2-2** `Progression.award(player, class, xp)` — slot gate (OD-3), `secondaryRate` (OD-2), xp add, level/tier recompute, **grant `pointsPerTier` on tier-up** (OD-1), fire `MasteryTierUp`, `markDirtyDebounced`, debounced sync.
- [ ] **M2-3** `ActionDetectors.register()` + the per-class detectors ([05](05-action-detection.md)). Each hook awards XP **only to a chooser**; the same hook is the attach point for M3's malus/benefit:
  - [ ] **M2-3a** Mineur — `PlayerBlockBreakEvents.AFTER` + ore tag (XP at break; speed effect is the M3 mixin).
  - [ ] **M2-3b** Bûcheron — same event + `BlockTags.LOGS` (XP at break; speed effect is the M3 mixin).
  - [ ] **M2-3c** Agriculteur — same event + mature-`CropBlock` check.
  - [ ] **M2-3d** Éleveur (kill) — `ServerLivingEntityEvents.AFTER_DEATH`, player attacker + animal victim.
  - [ ] **M2-3e** Éleveur (breed) — mixin `AnimalEntity#breed`.
  - [ ] **M2-3f** Artisan — mixin `CraftingResultSlot#onTakeItem`, tool/weapon/armour filter.
  - [ ] **M2-3g** Constructeur — **same craft mixin**, construction-block filter (placeable; **excl. reversible mineral blocks**, DP-3).
  - [ ] **M2-3h** Enchanteur — mixins `EnchantmentScreenHandler#onButtonClick` + `AnvilScreenHandler` (cost site).
- [ ] **M2-4** Mixin infrastructure: `paulsbrawls.classes.mixins.json` + add it to the `mixins` array in [../src/main/resources/fabric.mod.json](../src/main/resources/fabric.mod.json) (1 line); mixins under `com.paul.brawl.classes.mixin`.
- [ ] **M2-5** `MasteryTierUp` payload (S2C) + client `MasteryTierToast` (vanilla `ToastManager`, icon + palier name).
- [ ] **M2-6** Tests: curve math (monotonic, boundaries), `tierForLevel`, `secondaryRate` arithmetic, pure detector filters (is-ore / is-log / is-mature) and the **construction-block reversibility filter** (a mineral storage block is excluded) where extractable.

**M2 acceptance:** mining ore (as a Mineur) raises that class's bar; crossing a tier shows the toast and increments skill points (visible via `/class info`); a secondary class earns at the reduced rate. (Malus/benefit *effects* land in M3.)

---

## M3 — Effects (malus + benefit)

Effects are **two-sided and global** (DP-1): a non-chooser gets the malus, a chooser gets a benefit scaling
with Mastery level (secondary ×`secondaryRate`). Progression stays chooser-only.

- [ ] **M3-1** `MasteryEffect` interface (`refresh` + `transform`) + `EffectContext`; encodes both the malus (non-chooser) and the scaling benefit (chooser). ([06](06-effects.md))
- [ ] **M3-2** `EffectApplier` (`refresh(player, class)`, `refreshAll(player)`); call from `award` on level change **and from JOIN for every player** (the malus applies to all 7 professions, not just chosen ones).
- [ ] **M3-3** `ClassProfileCache` (UUID → `EffectFactors` for all 7 professions), updated on join + level change, evicted on disconnect; **absent ⇒ all-malus** (fail closed).
- [ ] **M3-4** Mixin strategy — Mineur/Bûcheron `PlayerEntity#getBlockBreakingSpeed` multiply: factor **<1 (malus)** for non-choosers, **>1 scaling** for the chooser; gated to ore/log; factor from cache; applies to **all** players. **Verify** version attribute set first (risk register).
- [ ] **M3-5** Transaction transforms (each two-sided): Agriculteur crop-yield ×, Éleveur loot ×, Artisan material destroy↔refund, Constructeur material destroy↔refund, Enchanteur enchant+anvil XP-cost × (malus>1 / bonus<1).
- [ ] **M3-6** Construction-block filter — the single "placeable construction block, *not* reversible into its materials?" gate shared by detector + transform (anti-dupe, DP-3).
- [ ] **M3-7** Attach each `MasteryEffect` to its `ClassDefinition` (replace the M0 no-op defaults).
- [ ] **M3-8** Manual verification matrix — per class check **both** sides: a chooser gets the benefit; a non-chooser suffers the malus (slow mining/chopping, abysmal crop/animal yields, destroyed craft materials, massively inflated enchant/anvil cost).

**M3 acceptance:** for each profession a chooser's benefit scales with level and a non-chooser visibly suffers the malus; both re-apply correctly after relog; a player with no profile is all-malus (fail closed).

---

## M4 — Skill trees

- [ ] **M4-1** `SkillTree`, `SkillNode` (`id`, `cost`, `prerequisites`, `effect`), `SkillEffect` (same shape as `MasteryEffect`). ([04](04-progression.md))
- [ ] **M4-2** Author a small initial tree per class (data; a few nodes each).
- [ ] **M4-3** `AllocateSkillNode` payload (C2S) + server handler: validate exists/prereq/cost/not-owned → decrement points, add node, apply effect, resync.
- [ ] **M4-4** `SkillTreeScreen` — render nodes + prereq lines, show points, click to allocate.
- [ ] **M4-5** Node effects applied on unlock (passive via `EffectApplier`/cache; active nodes register a trigger).
- [ ] **M4-6** `/class skills` opens the screen.
- [ ] **M4-7** Tests: prereq + cost + already-unlocked validation (pure).

**M4 acceptance:** tier-ups grant points; spending them in the tree unlocks nodes and their effects take hold; illegal allocations are rejected server-side.

---

## M5 — Polish

- [ ] **M5-1** `MasteryMenuScreen` — per-class level, XP bar, tier/palier, live effect value; reachable via `/class` + keybind (`KeyBindingHelper`).
- [ ] **M5-2** Full lang pass — every `paulsbrawls.class.*` key in `fr_fr.json` (primary) and `en_us.json`.
- [ ] **M5-3** Assets — class icons + tier/palier icons under `assets/paulsbrawls/textures/…`.
- [ ] **M5-4** `ClassConfig` — load/save knobs from [09](09-commands-config.md) (constants → `class_config` file in the server dir); read by curve/award/effects.
- [ ] **M5-5** Admin commands — `/class set`, `/class addxp`, `/class addpoints`, `/class reset` (the OD-5 respec path).
- [ ] **M5-6** Balancing pass — tune XP values, curve, effect magnitudes, `secondaryRate`, `pointsPerTier`.

**M5 acceptance:** a player can open a polished FR menu, see all progression, allocate skills, and admins can tune/repair via commands and config.

---

## Cross-cutting (do alongside, not after)

- [ ] **X-1 Separation audit** — confirm the only edits outside `com.paul.brawl.classes(.client)` are the three additive lines (`ServerEntryPoint`, `ClientEntryPoint`, `fabric.mod.json`). No import of Gibber/CTF/God/Eden/`minecraft-mcp-server`. ([02](02-architecture.md))
- [ ] **X-2 Docs in lockstep** — every behavior change updates the relevant numbered doc + this checklist in the same commit.
- [ ] **X-3 Test growth** — keep pure logic (curve, tiers, validation, NBT round-trip) under `./gradlew test`; it runs in CI already.
- [ ] **X-4 No console spam** — use the slf4j `LoggerFactory` pattern (per-class logger) as elsewhere in the mod; no `System.out`.

---

## Complete file inventory

New files, all under the feature's two package roots unless noted. `(+mixin)` = also listed in
`paulsbrawls.classes.mixins.json`.

### `src/main/java/com/paul/brawl/classes/` (server / shared)
| File | Milestone | Purpose |
|---|---|---|
| `ClassSystem.java` | M0 | server composition root (`register()`), registry population, JOIN listener |
| `PlayerClass.java` | M0 | the 8-class enum |
| `ClassDefinition.java` | M0 | per-class bundle interface |
| `ClassRegistry.java` | M0 | registry of definitions |
| `defs/*Definition.java` (×7) | M0/M3/M4 | the seven concrete definitions (effect + tree attached over M3/M4) |
| `ClassProfile.java` | M0 | per-player aggregate + `slotOf` |
| `MasteryTrack.java` / `SkillTrack.java` | M0 | the two tracks |
| `ClassPersistentState.java` | M0 | NBT persistence |
| `ClassCommand.java` | M0/M5 | `/class …` |
| `progression/MasteryCurve.java`, `Tier.java`, `Progression.java` | M2 | leveling engine |
| `action/ActionDetectors.java` + per-class detectors | M2 | XP sources |
| `effect/MasteryEffect.java`, `EffectApplier.java`, `EffectContext.java`, `ClassProfileCache.java` | M3 | effect layer (two-sided: malus + benefit) |
| `effect/ConstructionBlocks.java` | M3 | the anti-dupe "is this a Constructeur block?" filter (DP-3) |
| `skill/SkillTree.java`, `SkillNode.java`, `SkillEffect.java` | M4 | skill trees |
| `net/ClassNetworking.java` + payload records | M1/M2/M4 | server networking |
| `config/ClassConfig.java` | M5 | balancing knobs (incl. `malus.*`) |
| `mixin/*.java` (breed, craft, enchant, anvilCost, blockBreakSpeed) `(+mixin)` | M2/M3 | the detect/effect mixins (no place mixin — Constructeur is craft-based) |

### `src/client/java/com/paul/brawl/classes/client/`
| File | Milestone | Purpose |
|---|---|---|
| `ClassClient.java` | M1 | client composition root |
| `ClientClassState.java` | M1 | cached profile |
| `screen/ClassSelectionScreen.java` | M1 | first-join pick |
| `screen/MasteryMenuScreen.java` | M5 | mastery menu |
| `screen/SkillTreeScreen.java` | M4 | skill tree menu |
| `toast/MasteryTierToast.java` | M2 | tier-up pop-up |
| `net/ClientClassNetworking.java` | M1 | client handlers + keybind |

### `src/main/resources/`
| File | Milestone | Purpose |
|---|---|---|
| `paulsbrawls.classes.mixins.json` | M2 | separate mixin config (referenced from `fabric.mod.json`) |
| `assets/paulsbrawls/lang/{fr_fr,en_us}.json` (edit) | M0→M5 | `paulsbrawls.class.*` keys |
| `assets/paulsbrawls/textures/gui/class/*` | M5 | class + tier icons |

### Edited existing files (additive only)
| File | Edit |
|---|---|
| [../src/main/java/com/paul/brawl/ServerEntryPoint.java](../src/main/java/com/paul/brawl/ServerEntryPoint.java) | `+ ClassSystem.register();` |
| [../src/client/java/com/paul/brawl/ClientEntryPoint.java](../src/client/java/com/paul/brawl/ClientEntryPoint.java) | `+ ClassClient.register();` |
| [../src/main/resources/fabric.mod.json](../src/main/resources/fabric.mod.json) | `+ "paulsbrawls.classes.mixins.json"` in `mixins` |

---

## Definition of done (whole feature)

1. Fresh player must pick a primary + secondary (of 7) before playing; choice persists across restart.
2. All 7 classes accrue Mastery XP from their action, level up, cross named tiers with a pop-up, and grant skill points.
3. **Subtractive specialization is live:** a non-chooser visibly suffers each profession's malus; a chooser's benefit replaces it and scales with Mastery. Effects fail closed (no profile ⇒ all-malus).
4. Artisan/Constructeur are symmetric, and Constructeur excludes reversible mineral blocks (no duplication, DP-3).
5. Each class's effect and at least its initial skill-tree nodes are live and observable in-world.
6. Primary/secondary asymmetry, curve, malus sizes, and magnitudes are config-driven.
7. French UI throughout (selection, menus, toast).
8. Separation audit (X-1) passes: three additive lines, no cross-feature imports.
9. Pure-logic tests green under `./gradlew test`.
