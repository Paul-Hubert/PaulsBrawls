# Prompt: reform the General (prompts, tools, mechanics)

You are working in the pauls-brawls repo, on the **General** (docs/38; `squad/src/general/`, `squad/src/http/general-mcp.ts`,
`squad/agent/general/CLAUDE.md`, the stock orders in `squad/src/stock/`). Read docs/38, docs/29 §5.4, docs/40, docs/44 and
the `general` tests first. Work only in `squad/` and `docs/`; run `npm run check` in `squad/` before you finish.

## Why (a real defeat, 2026-11-05)

A General (20 bots: 5 each of guard, archer, horseman, horsearcher) fought the 20 bots of player PUALHubert twice and lost
both times. **PUALHubert was in creative and hurt no one: every kill was a bot's.** Do not design anything around "a
flying player". The facts:

1. **The General never moved its units.** After the opening it gave `line` to all four squads at one point, so the army sat
   in one clump. `line` is a hold: the horsemen (unshielded melee) stand on the wall's flanks and never charge. The
   cavalry did nothing for the whole fight, though the enemy's archers and horse archers sat exposed and static for 10+
   minutes.
2. **The model reacted in tens of seconds, the fight in seconds.** One `wait_events` call (2 s gather + a model turn of
   10-30 s + tool calls) per decision. Whole squads died between two decisions (a wipe of 20 bots took ~40 s).
3. **Horse archers given `attack` on a target 100+ blocks away stood still and shot grass** ("no clear line of fire:
   grass_block is in the way"), because `attack` does not close the distance for archers. Nothing told the General that.
4. **Reinforcing into an unwatched fight:** reinforcements arrived at spawn, the General slept, and they died as they
   arrived. The cause of that last wipe is unknown: the sitrep lost the enemy ("LOST") before it, and the events say who
   died but not who killed or from where.
5. **Damage was invisible.** hp-bands and casualties say a squad is losing, not to what: no attacker, no direction, no
   weapon. The General guessed (wrongly) at a cause.
6. **Contact was thin.** Enemy clusters showed as "static", then "LOST" 15 s after leaving sight, with no memory of last
   heading, so the General could not plan an approach or a retreat.

What worked: a wall held out of the enemy's archer reach, with the archers' long `range` on the line, killed 5 lancers and
~5 archers at 100+ blocks for the loss of ~2 bots.

## Goals

Make the General (a) **react in seconds**, (b) **use all its kits for their purpose**, (c) **see why it is losing**.
Propose, then implement, changes in these three areas. Keep the existing rules (one writer per state, no new machinery
without a second consumer, behaviour and docs change in the same commit, tests for every rule).

### A. Prompt (`squad/agent/general/CLAUDE.md`)

- Replace "form a `line`" as the default with **combined-arms doctrine**: two groups at least, a holding wall with its
  archers, and a **mobile force** (horsemen, horse archers) that always has an order other than `line`. Say plainly that
  `line` never moves horsemen and never charges.
- Say: horse archers must be sent with `raid`/`attack` **with a position or target within their range**, not a far
  target; archers in `attack` do not advance.
- Rules of tempo: act within one turn of any `contact`; never end a turn with a squad idle or a reinforcement unordered;
  after `reinforce`, order the arrivals in the same turn; never `sleep`; one `wait_events` with a short timeout while a
  fight is on (e.g. 8 s), a long one only when nothing is in sight.
- Scout first (one horse archer or horseman with `raid` toward the axis, retreat on contact), don't advance a wall into an
  unseen enemy.
- A pre-battle checklist and a post-contact checklist, short, not prose.

### B. Tools (`general-mcp.ts`, `general.ts`)

Design and add what is missing; suggested, judge for yourself:

- **Standing orders** (a rule the runtime runs without the model): per squad, e.g. `on contact within N: attack it`,
  `on hp < X: fall back to spawn`, `on casualty: reinforce`, `on idle: advance`. The General sets them once and the
  runtime reacts in ticks, not model turns. This is the main fix for reaction time.
- **Batch/preset orders**: one call that gives several squads their orders ("wall + cavalry flank + horse archer harass"),
  so a plan is one tool call, not six.
- **`attack`/`raid` for ranged units that closes distance to their weapon range**, or a clear refusal that says
  "target out of range, use raid".
- **Attacker attribution in events**: on `hp-band`/`casualty` say what hit (the nearest enemy, a projectile's owner and
  direction, the weapon), and a `under-fire` event with the bearing of the shooter. Add `enemy-approach` (a cluster inside N
  blocks and closing).
- **Memory of enemies**: `LOST` clusters keep last position, heading, speed and age and are listed as such;
  `squad_detail` shows each bot's current action (the order's log tail is not enough).
- **Safe reinforcement**: `reinforce` takes a `rally` point and an optional order to give on arrival; refuses (or warns)
  while enemies are within N of spawn.
- **A `sleep`-free cadence**: let `wait_events` take `min_gap_s`/a tick mode, and make its sitrep a diff against the last
  one (shorter, so a turn is faster).

### C. Mechanics (`squad/src/stock/`, `orders/`)

- A **mobile order** for cavalry: charge a group, then re-form out of reach and charge again, with a `retreat when hp < X`
  default; check it against the 26.x spear rules in docs/44.
- A **`flank`** order: go around a point to a bearing relative to the enemy's heading, then attack the rear or the archers.
- **`line` with a reserve**: part of the squad stays loose and counter-attacks what reaches the wall.
- **`line` that falls back** ("fighting retreat" toward `at.pos` when hp < X), so a losing wall is not just stood in.
- Spread: orders should keep bots from standing in one pile at spawn; add a `spread` default at arrival.

## Method

1. Write the audit first (what each item above is today, citing `path:line`), as `docs/system/squad/general-reform-audit.md`.
2. Propose the design to the owner (one page) and wait for the OK on the standing-orders design before building it.
3. Implement in small commits, each with tests (fakes, as the existing `general.test.ts` does) and the docs updated.
4. Add a **replayable benchmark**: a scripted scenario on fakes (20 vs 20, static enemy ranged units 100 blocks away) that
   scores the doctrine: time from `contact` to first order, bots idle for more than 5 s, kills per loss. The prompt and
   tools are judged by it, not by feel.
5. Update `squad/agent/general/CLAUDE.md` last, from what the tools now do.

Report in one short message per step. Do not touch Eden or `minecraft-mcp-server/`.
