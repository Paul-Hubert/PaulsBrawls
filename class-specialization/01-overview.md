# 01 — Overview & scope

## The feature in one paragraph

Specialization is **subtractive**. By default every player is **penalised at every profession** — mining is
very slow, harvests and animal drops are abysmal, crafting destroys materials, enchanting is punishingly
expensive. On first connection a player picks a **primary** and a **secondary** class; doing so **removes
the penalty** for those two professions and turns each into a benefit that **grows from a single XP pool**
earned by performing that class's actions. Each chosen class then advances along **two progression systems**:

1. **Mastery (Niveau de Maîtrise)** — passive. Doing the class action raises a single XP bar → a
   **level** → grouped into named **tiers (paliers)**. The level scales that class's specialist benefit.
   Crossing a tier fires an in-game pop-up (icon + palier name).
2. **Skill (Niveau de Compétence)** — a per-class **skill tree**. Mastery tier-ups grant **skill points**;
   spending them unlocks class-specific abilities.

A player's two chosen professions therefore feel like a sharp, widening advantage over everything else they do.

## The seven classes

| Class (FR) | id | XP action (chooser) | Default malus (non-chooser) | Specialist benefit (chooser) |
|---|---|---|---|---|
| Mineur | `mineur` | break ore blocks | mining very slow | + block-break speed on ores |
| Bûcheron | `bucheron` | break logs | chopping very slow | + block-break speed on wood |
| Agriculteur | `agriculteur` | harvest mature crops | crop yield abysmal (−%) | + harvest yield (%) |
| Éleveur | `eleveur` | kill / breed animals | animal drops abysmal (−%) | + animal drop yield (%) |
| Artisan | `artisan` | craft tools / weapons / armour | craft can fail, materials destroyed (−%) | + material refund on craft (%) |
| Constructeur | `constructeur` | craft construction blocks *(placeable; excl. reversible mineral blocks)* | materials destroyed on craft (−%) | + material refund on craft (%) |
| Enchanteur | `enchanteur` | enchant items & books (table + anvil) | enchant/anvil XP cost massively increased | − enchant XP cost / refund (%) |

The mapping `class → action → malus/benefit` is the spec. The **magnitudes** (malus size, XP per action,
% per level, points per tier) are config, not architecture — see [09-commands-config.md](09-commands-config.md).

> **Note — Explorateur was removed.** An earlier draft included an eighth "Explorateur" class (distance /
> structure discovery → speed). It is **not** part of the feature. Seven classes only.

> **Note — Constructeur and Artisan are symmetric.** Both are crafting-material mechanics: a non-specialist
> *loses* a share of materials on the relevant craft; a specialist *recovers* a share. Artisan covers
> tools/weapons/armour; Constructeur covers placeable construction blocks **excluding** any block that can be
> uncrafted back into its materials (iron/diamond/emerald/… storage blocks) — refunding a reversible craft
> would be free duplication. See [00-features.md FR-4](00-features.md).

## The two-sided effect model

Unlike a pure bonus system, **effects apply to every player**:
- A profession you **did not choose** → its **malus** applies (flat baseline penalty).
- A profession you **chose** → the malus is removed and a **benefit** applies, scaling with that class's
  Mastery level (primary full, secondary reduced).

**Progression** (XP, levels, tiers, points), by contrast, exists **only for the two chosen classes** — the
other five never accrue, they only impose their malus. See [06-effects.md](06-effects.md).

## Scope

**In scope (v1)**
- First-join selection of primary + secondary (the 7 classes above).
- The default malus on every un-chosen profession.
- Mastery track per chosen class: action → XP → level → tier → scaling specialist benefit.
- Skill track per chosen class: tier-ups grant points → allocate nodes → unlock abilities.
- Persistence across relog/restart.
- UI: selection screen, mastery menu, skill-tree menu, tier-up pop-up. **French** player-facing strings.
- Admin/debug commands.

**Out of scope (non-goals)**
- Any coupling to Gibber, Capture-the-Flag, AI-God, or Eden/Village (see [02-architecture.md](02-architecture.md)).
- Cross-server / database persistence — world `PersistentState` suffices.
- Player-facing respec, all-class progression, economy payouts (deliberate later hooks, not dependencies).
- Class-vs-class PvP balancing.

## Player-facing language

French, matching the mod convention (see the existing FR strings in
[../src/client/java/com/paul/brawl/Screenshotter.java](../src/client/java/com/paul/brawl/Screenshotter.java)).
Lang keys are namespaced `paulsbrawls.class.*` in both `en_us.json` and `fr_fr.json`.
