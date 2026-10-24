# Class Specialization — documentation home

A self-contained Fabric feature for `paulsbrawls`: every player chooses a **primary** and a **secondary**
class (of **seven**) on first join, then advances each along **two** progression tracks — **Mastery**
(passive, action-driven) and **Skill** (a point-spent ability tree).

Specialization is **subtractive**: by default every player is **penalised at every profession** (very slow
mining, abysmal yields, wasteful crafting, expensive enchanting); choosing a class **removes its malus** and
turns it into a benefit that scales with Mastery. Effects are therefore **global and two-sided** — see
[00-features.md](00-features.md) and [DP-1 in 10](10-decisions-risks.md).

This folder is the **single source of truth** for the feature. It is deliberately separate from Eden's
`docs/` (which CLAUDE.md reserves for Eden) and from the v1 / God plans at the repo root. Implementation
code will live under `../src/main/java/com/paul/brawl/classes/` and `../src/client/java/com/paul/brawl/classes/`.

> **Target:** Minecraft **1.21.1**, Fabric, Java 21 — same toolchain as the rest of the mod
> ([../build.gradle](../build.gradle), [../src/main/resources/fabric.mod.json](../src/main/resources/fabric.mod.json)).
> **Status:** design complete, all decisions resolved, **not yet built**. Next step: M0 (see [TASKS.md](TASKS.md)).

## Reading order

| # | Doc | What it covers |
|---|---|---|
| — | [README.md](README.md) | This index + status + decision summary |
| 00 | [00-features.md](00-features.md) | **Formal user-facing feature spec** — what the player experiences (start here for the product view) |
| 01 | [01-overview.md](01-overview.md) | What the feature is, the 7 classes, subtractive specialization, the two progression systems, scope/non-goals |
| 02 | [02-architecture.md](02-architecture.md) | The organizing idea (registry, not branches), layer diagram, **separation contract** |
| 03 | [03-domain-model.md](03-domain-model.md) | `PlayerClass`, `ClassDefinition`, `ClassRegistry`, `ClassProfile`, the two tracks |
| 04 | [04-progression.md](04-progression.md) | Mastery curve, tiers/paliers, the **one XP bar**, skill points, skill-tree model, primary/secondary rate |
| 05 | [05-action-detection.md](05-action-detection.md) | Per-class XP sources — which use a Fabric event, which need a mixin |
| 06 | [06-effects.md](06-effects.md) | The three effect-application strategies (attribute / mixin / transaction transform) |
| 07 | [07-persistence.md](07-persistence.md) | `ClassPersistentState` NBT shape, debounced writes, no offline backlog |
| 08 | [08-networking-ui.md](08-networking-ui.md) | C2S/S2C payloads, first-join selection flow, client screens + tier-up toast |
| 09 | [09-commands-config.md](09-commands-config.md) | `/class …` commands, config keys / balancing knobs |
| 10 | [10-decisions-risks.md](10-decisions-risks.md) | Resolved decision log (OD-1…OD-5) + risk register |
| — | [TASKS.md](TASKS.md) | **Everything to do** — full work breakdown by milestone, file inventory, acceptance criteria |

## Decisions (all resolved)

| # | Decision | Resolution |
|---|---|---|
| OD-1 | Skill-point source | **One XP bar per class** → Mastery; each Mastery tier-up grants `N` skill points. No second XP track. |
| OD-2 | Primary vs secondary | Primary ×1.0; secondary ×`secondaryRate` (configurable, default ~0.5), applied in `award()` + effects. |
| OD-3 | Progression breadth | Only the chosen **primary + secondary** classes have tracks / accrue XP. |
| OD-4 | Selection gate | Re-prompt + **non-dismissable** selection screen; no profile ⇒ no bonuses. No movement/lobby freeze. |
| OD-5 | Respec | **Admin-only** `/class reset` for v1; player respec deferred. |

Plus four locked **design principles** — DP-1 subtractive specialization (global two-sided effects),
DP-2 Artisan/Constructeur symmetry, DP-3 no reversible-craft refunds (anti-dupe), DP-4 seven classes
(Explorateur removed). Details + rationale in [10-decisions-risks.md](10-decisions-risks.md).

## Separation in one line

Everything lives under `com.paul.brawl.classes(.client)` with its own NBT key, networking namespace, mixin
config, and lang prefix. **Exactly three additive lines** touch existing code (one in `ServerEntryPoint`,
one in `ClientEntryPoint`, one in `fabric.mod.json`). No reference to Gibber, CTF, AI-God, Eden, or
`minecraft-mcp-server`. See [02-architecture.md §Separation contract](02-architecture.md).
