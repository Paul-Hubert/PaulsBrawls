# 00 — User-facing feature specification

A formal description of everything a **player** experiences in the Class Specialization feature. This
document is written from the player's point of view and contains no implementation detail — it is the
product specification the architecture docs (01–10) exist to satisfy. In-game text is **French**; French
labels are given in parentheses where they are the actual on-screen strings.

---

## 1. Purpose

The feature gives every player a long-term identity built around *how they like to play*. Specialization is
**subtractive**: by default every player is **bad at every profession** — mining is painfully slow, harvests
and animal drops are abysmal, crafting wastes materials, and enchanting is punishingly expensive. A player
commits to **two** professions; doing so **removes the penalty** for those two and turns it into a benefit
that grows the more the player practises. A player therefore feels their two chosen professions as a sharp,
widening advantage over everything else they do.

Each chosen class advances along two parallel tracks: a passive **Mastery** that strengthens its benefit
automatically, and an active **Skill** tree the player shapes by spending points.

## 2. Terminology

| Term (EN) | Term (FR) | Definition |
|---|---|---|
| Class | Classe | One of seven professions a player can specialise in. |
| Primary class | Classe principale | The player's main profession; progresses and rewards at full rate. |
| Secondary class | Classe secondaire | The player's second profession; progresses and rewards at a reduced rate. |
| Malus (default penalty) | Malus | The standing penalty every player suffers on a profession they have **not** chosen. |
| Mastery | Maîtrise | A passive track per chosen class: doing the class's actions raises it and strengthens that class's benefit. |
| Mastery level | Niveau de maîtrise | The numeric level of a Mastery track, raised by class-action XP. |
| Tier (milestone) | Palier | A named, celebrated grouping of Mastery levels. Reaching one is announced in-game. |
| Skill | Compétence | An unlockable ability in a class's skill tree. |
| Skill point | Point de compétence | The currency spent to unlock skills. Earned by reaching Mastery tiers. |
| Skill tree | Arbre de compétences | The per-class graph of skills a player unlocks with skill points. |

---

## 3. Feature requirements

### FR-1 — First-connection class selection
- **FR-1.1** On a player's **first connection**, the game presents a **class-selection screen** (« Choisis
  ta classe ») before normal play begins.
- **FR-1.2** The player chooses **one primary class** (« Classe principale ») and **one secondary class**
  (« Classe secondaire ») from the seven classes.
- **FR-1.3** The primary and secondary class **must be different**; the screen does not accept two identical
  choices.
- **FR-1.4** The selection screen **cannot be dismissed** without making a valid choice. A player who leaves
  before choosing is presented the screen again on their next connection.
- **FR-1.5** Once chosen, the two classes define the player's progression for this world. Players cannot
  change them themselves in this version (see FR-11 and §4).
- **FR-1.6** A returning player who has already chosen is **not** shown the screen; their progression loads
  silently and play begins immediately.

### FR-2 — Subtractive specialization (the default penalty)
- **FR-2.1** Every player suffers a **standing penalty (malus)** on **every profession they have not chosen**
  — for both of the actions and benefits in FR-3. The malus applies regardless of progression.
- **FR-2.2** Choosing a class as primary or secondary **removes its malus** and replaces it with a positive
  benefit (FR-3) that scales with that class's Mastery level.
- **FR-2.3** A non-specialist therefore performs that profession's basic activities markedly **worse** than a
  specialist — by design, the gap is large and widens as the specialist gains Mastery.

### FR-3 — The class roster
Seven classes are available. Each defines the **qualifying actions** that earn Mastery XP *for a player who
chose it*, the **default malus** every other player suffers, and the **specialist benefit** that grows with
the chosen player's Mastery level (reduced for a secondary class).

| Class (FR) | Qualifying actions (chooser earns XP) | Default malus (non-chooser) | Specialist benefit (chooser, scales with level) |
|---|---|---|---|
| **Mineur** | Mining ore blocks | Mining is **very slow**. | Mining speed greatly increased. |
| **Bûcheron** | Cutting wood (logs) | Wood-cutting is **very slow**. | Wood-cutting speed greatly increased. |
| **Agriculteur** | Harvesting mature crops | Crop yields are **abysmal** (heavily reduced). | Crop yield increased (more resources per harvest, %). |
| **Éleveur** | Killing and breeding animals | Animal drops are **abysmal** (heavily reduced). | Animal yield increased (more drops, %). |
| **Artisan** | Crafting tools, weapons, and armour | Crafts can **fail**, **destroying** a share of the materials (the rest is returned, no item). | Crafts **recover** a share of the materials (a refund, %), symmetric to the penalty. |
| **Constructeur** | Crafting construction blocks *(placeable building blocks; see FR-4)* | A share of the materials is **deleted** after the craft. | A share of the materials is **restored** after the craft (%), symmetric to the penalty. |
| **Enchanteur** | Enchanting items and books (enchanting table & anvil) | Anvil and enchanting-table **XP costs are massively increased**. | Enchanting XP cost reduced / partially refunded (%). |

- **FR-3.1** Qualifying actions earn Mastery XP **only** for a player who chose that class. Performing the
  action without the class earns no XP (and still incurs the malus).
- **FR-3.2** The Artisan and Constructeur effects are **symmetric**: a non-specialist *loses* a share of
  materials on the relevant craft; a specialist *recovers* a share. The two are mirror images of the same
  percentage.
- **FR-3.3** All benefits and maluses apply automatically and continuously; the player does not activate them.

### FR-4 — Constructeur scope & anti-duplication
- **FR-4.1** The Constructeur mechanic (malus and benefit) applies to crafting **placeable construction
  blocks** (e.g. planks, bricks, stone variants, stairs, slabs, glass, wool, concrete, terracotta).
- **FR-4.2** It **excludes** any block that can be **uncrafted back into its materials** — the compressed
  mineral storage blocks (iron, gold, diamond, emerald, lapis, redstone, coal, netherite, …). Refunding
  materials on a reversible craft would allow free duplication, so those blocks are exempt from both the
  malus and the benefit.

### FR-5 — Mastery progression
- **FR-5.1** Each of a player's two chosen classes has a **single Mastery XP bar**. Performing that class's
  qualifying actions fills the bar.
- **FR-5.2** Filling the bar raises the **Mastery level**, which strengthens that class's specialist benefit
  (FR-3). The benefit scales smoothly with level.
- **FR-5.3** Levels are grouped into named **tiers (paliers)**. Reaching a new tier is announced (FR-9) and
  grants skill points (FR-6).
- **FR-5.4** Mastery only ever increases; it is never lost through normal play.

### FR-6 — Skill progression
- **FR-6.1** Reaching a new Mastery **tier** grants the player **skill points** for that class.
- **FR-6.2** Skill points are spent in that class's **skill tree** to unlock **skills** (class-specific
  abilities).
- **FR-6.3** Skills may require prerequisite skills and a point cost; the tree unlocks progressively from its
  entry nodes outward.
- **FR-6.4** Skill points and unlocked skills are **per class** — points earned in one class are spent only
  in that class's tree.
- **FR-6.5** Unlocking a skill takes effect immediately. Unlocks are permanent in this version (no
  player-initiated reset — see §4).

### FR-7 — Primary vs secondary
- **FR-7.1** The **primary** class progresses and rewards at full strength.
- **FR-7.2** The **secondary** class progresses and rewards at a **reduced rate** (it earns XP more slowly
  and its benefit is proportionally smaller — though still far better than the un-chosen malus).
- **FR-7.3** Both classes otherwise behave identically — both have a Mastery bar, tiers, skill points, and a
  skill tree.

### FR-8 — The Mastery menu (« menu »)
- **FR-8.1** A player can open a **Mastery menu** at any time to view their progression.
- **FR-8.2** For each of the player's two classes the menu shows: the class identity, current Mastery
  **level**, the **XP bar** toward the next level, the current **tier (palier)** name, and the current value
  of the class's benefit.
- **FR-8.3** The menu is opened via the player command (FR-10) and/or a key binding.

### FR-9 — Tier-up notification (pop-up)
- **FR-9.1** When a player crosses into a new Mastery **tier**, an in-game **pop-up** appears.
- **FR-9.2** The pop-up shows the tier's **icon** and its **name (palier)** (e.g. « Palier atteint : … »).
- **FR-9.3** The pop-up is non-blocking — it informs the player without interrupting play.

### FR-10 — Player commands
The player has access to the following (permission-free) commands:

| Command | Effect |
|---|---|
| `/class` | Open the Mastery menu (FR-8). |
| `/class skills` | Open the skill-tree menu. |
| `/class info` | Show a text summary of the player's classes, levels, tiers, and skill points. |

(Administrative commands exist for server operators — see [09-commands-config.md](09-commands-config.md) —
but are not part of the standard player experience.)

### FR-11 — Persistence & continuity
- **FR-11.1** A player's class choices, Mastery levels, tiers, skill points, and unlocked skills **persist**
  across disconnects and server restarts.
- **FR-11.2** Progression resumes exactly where the player left off; no progress is lost by logging out.
- **FR-11.3** Mastery does **not** advance while the player is offline (only real in-game actions count).

---

## 4. Not included in this version

These are deliberately deferred so expectations are clear:

- **Player-initiated respec.** Players cannot reselect their classes or refund/reallocate skill points
  themselves; only a server operator can reset a player's profile. A costed player-facing respec is a future
  addition.
- **Progressing classes the player did not choose.** Only the chosen primary and secondary classes
  progress; for every other class the player simply suffers the standing malus.
- **Cross-world progression.** Progression is per world/server, not shared across servers.

## 5. Language

All player-facing text — the selection screen, menus, the tier-up pop-up, and command output — is in
**French**, consistent with the rest of the mod.
