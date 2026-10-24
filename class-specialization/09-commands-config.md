# 09 — Commands & config

## Commands

`ClassCommand.register()` — Brigadier, same idiom as
[../src/main/java/com/paul/brawl/GibCommand.java](../src/main/java/com/paul/brawl/GibCommand.java).

| Command | Perm | Effect |
|---|---|---|
| `/class` | 0 | open the mastery menu (chat-printout fallback if no client mod) |
| `/class skills` | 0 | open the skill-tree menu |
| `/class info [player]` | 0 / 2 for others | print a profile (primary/secondary, per-class level/tier/points) |
| `/class set <player> <primary> <secondary>` | 2 | admin override of a player's classes |
| `/class addxp <player> <class> <amount>` | 2 | debug: grant mastery XP |
| `/class addpoints <player> <class> <amount>` | 2 | debug: grant skill points |
| `/class reset <player>` | 2 | wipe the profile → re-prompt selection (OD-5 respec path) |

`class` arguments use a custom Brigadier argument (or a `word` validated against `PlayerClass.byId`) with
suggestions for the 7 ids.

## Config / balancing knobs

All magnitudes are data, not architecture. v1 may start with constants in a `ClassConfig` holder and graduate
to a persisted file (`class_config.properties` or JSON in the server dir, mirroring how the God features
persist `*_config.properties`). Keys:

| Key | Meaning | Default (suggested) |
|---|---|---|
| `secondaryRate` | XP + **benefit**-side multiplier for the secondary slot (OD-2; malus is not slot-scaled) | `0.5` |
| `pointsPerTier` | skill points granted per Mastery tier-up (OD-1) | `1` |
| `levelsPerTier` | how many levels make a palier | `10` |
| `curve.*` | Mastery `xp → level` parameters (base, growth) | tune |
| `xp.<class>` (7 keys) | base XP per action, per class | tune |
| `effect.<class>.perLevel` | **benefit** magnitude per Mastery level (chooser) | tune |
| `malus.<class>` (7 keys) | **default penalty** for non-choosers (DP-1) — e.g. `malus.mineur` mining-speed factor, `malus.agriculteur` crop-yield factor, `malus.enchanteur` XP-cost multiplier | tune (heavy) |
| `craftFail.<artisan\|constructeur>` | share of materials destroyed (malus) / recovered (benefit), symmetric (DP-2) | tune |
| `maxLevel` (optional) | level cap, if any | none |

> There is **no** `explorer.*` key — Explorateur was removed (DP-4). The `malus.*` family is the new
> balance lever introduced by subtractive specialization; tune it carefully (see the risk register in
> [10](10-decisions-risks.md)).

> **Decommission/separation note:** the config object is owned solely by this feature; it does **not**
> read or write any Gibber/God/Eden config. Keep all keys under a `class.` prefix if sharing a properties
> file becomes desirable later — but a dedicated file is preferred (separation).

## Lang keys (sample)

```
paulsbrawls.class.mineur.name              = Mineur
paulsbrawls.class.constructeur.name        = Constructeur
paulsbrawls.class.tier.0                   = Apprenti
paulsbrawls.class.select.title             = Choisis ta classe
paulsbrawls.class.select.primary           = Classe principale
paulsbrawls.class.select.secondary         = Classe secondaire
paulsbrawls.class.tierup.toast             = Palier atteint : %s
paulsbrawls.class.menu.level               = Niveau %d
```
Both `en_us.json` and `fr_fr.json` carry the full set (FR is the shipped language).
