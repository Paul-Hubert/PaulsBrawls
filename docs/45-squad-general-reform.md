# 45 — Reforming the General: standing orders, sight of damage, kits used for their purpose

Status: **approved by the owner (2026-11-05), being built**; §7 records what is built. Brief: [general-reform-prompt.md](general-reform-prompt.md).
Audit of today's code: [system/squad/general-reform-audit.md](system/squad/general-reform-audit.md). Scope: `squad/`
and `docs/` only.

## 1. Standing orders (the main fix: reactions in ticks, not turns)

A **standing order** is a rule on one squad that the runtime fires without the model: `when TRIGGER → do ACTION`.

- **Tool** `standing(squad, rules[])` replaces the squad's rules (`[]` clears them). Shown in `squad_detail` and as
  a `⚑n` count on the squad's sitrep line.
- **Triggers** (a closed set, one registry row each, evaluated by the existing 1 s sampler, 250 ms while any
  cluster is within 64 blocks):
  `contact within=N` (a cluster within N of the squad's centre), `approach within=N` (one within N and closing),
  `hp below=X` (squad mean %), `losses atLeast=N` (deaths since the rule last fired), `idle for=S` (no running
  order), `ended` (its order ended: `done`/`failed`).
- **Actions:** any `order` (`command`, `args`, `at`), where `at` may also say `{target: "trigger"}` (the cluster that
  fired it), `{pos: "rally"}`, `{pos: "back N"}` (N blocks from the trigger cluster, away from it) or `{pos: "here"}`;
  plus `reinforce n` and `advance`.
- **Rules of firing:** one rule fires per squad per sample (first match in list order); each rule has a
  `cooldown` (default 10 s) and fires on the trigger's **edge** (`hp below` once per crossing, `contact` once per new
  cluster), so a rule cannot thrash. The model's own `order` wins: it resets the squad's cooldowns, and a rule does
  not fire within `respect` s (default 5) of a model order to that squad.
- **One writer:** a rule starts its order through the same `Generals.start` the model's `order` uses (the old order
  stopped quietly). The advance's leg chaining becomes the first rule kind (`ended → advance`), so the two share one
  path instead of two.
- **Visible:** every firing is an event `standing` ("squad C: contact X2 at 41b → attack X2"), waking by default.
- **Budget:** model orders keep 20/min; runtime-fired orders (rules, advance legs) get their own 60/min per General
  (today the legs eat the model's 20).
- **Kit defaults** (applied at `spawn_squad`, changed or cleared with `standing`): horsemen `approach/contact
  within=48 → attack trigger`, `hp below=40 → line at back 24`, `ended → attack nearest within 48 else line at rally`;
  horse archers `contact within=64 → raid trigger radius=40`, `hp below=50 → raid back 32`; archers/guards none
  (they hold a `line`); every kit `idle for=8 → line here facing the nearest cluster` once a cluster is visible.

## 2. Tools

- **Batch:** `orders([{squad, command, args, at, standing?}])`: validated all first, then started; a plan is one call
  and one rate-limit slot per squad. The doctrine shows three plans as ready batches (no preset machinery).
- **Ranged reach:** `attack` gets `approach` (0–64; the General's default 40, the player's 0): an archer farther than
  that from its foe walks/rides toward it until within, then shoots; a foe the aim solver refuses is marked blocked
  for 5 s (as in `line`) and the archer steps **forward**, not only aside. `order attack` with archers and a target
  beyond 80 blocks and `approach=0` is refused: « target 112 blocks away, out of bow range: use raid, or approach ».
- **Attribution:** `hits.ts` emits `hurtBy (attacker, {kind: melee|arrow|other, weapon, from})` for every
  `damage_event` (cause ≠ direct = a projectile, its shooter). The General aggregates per squad per sample:
  `casualty` and `hp-band` add « last hit by NAME (bow, arrow from NE 70b, cluster X3) »; a new `under-fire` event
  (a squad hit by ≥3 arrows in 5 s: bearing, distance, shooter's cluster); `enemy-approach` (a cluster within 48 of a
  squad, closing ≥ 1 b/s).
- **Enemy memory:** a lost cluster keeps its last position, heading, speed and age: « X2 6 LOST 23s, last @E40 N3 →W
  2.1b/s ». It stays in the map (lower-case letter).
- **squad_detail per bot action:** derived from the bot, no new script API: « riding to E30 », « shooting X2 #41 »,
  « charging », « shield up on slot », « idle »; plus the last log line that names the bot.
- **Safe reinforcement:** `reinforce(squad, n, rally?, then?)` and `spawn_squad(…, rally?, then?)`: the arrivals
  go to `rally` (default: 12 blocks behind the army's centre on the axis, never past the spawn) and get `then` (an
  order), else join the squad's running order (restarted with them). Refused while a cluster is within 32 of the
  spawn unless `force: true`. `arrived` wakes by default.
- **Cadence:** `wait_events(timeout_s, min_gap_s?)`: the answer's sitrep is a **diff** against the last one sent
  (changed squad and cluster lines only, `--- unchanged: A B X1`); `sitrep()` stays whole. Default timeout 8 s while
  a cluster is visible, 45 s otherwise. Coalescing stays 2 s, 0.5 s for `under-fire`/`casualty`.

## 3. Mechanics (stock orders)

- **Cavalry:** `attack`'s waves get `retreat` (hp %, default 40): a rider under it leaves the wave for `back`
  beyond, the squad re-forms there; the rule of §1 re-sends it. No new `charge` command: `attack` already charges in
  waves (docs/44), and its 26.x spear rules (2–4.5 blocks, the charge's use held) are kept as they are.
- **`flank`** (new stock file): from where the squad stands, ride round the target cluster to the bearing `side`
  (left/right/rear, relative to the cluster's heading, else to the line from the army to it) at `radius` out, then
  `attack` it from there. Built on `lance`/`approach` helpers; ≤ 400 lines.
- **`line` reserve:** `reserve=N` keeps the N melee bots loose `back` behind the centre; one leaves to fight what
  comes within `reach+8` of the wall, then returns (the attack-and-return already used for lent bots).
- **`line` fighting retreat:** `fallback=X` (hp %, 0 off): below it, the line re-forms `step` (8) blocks back toward
  its own side, one step per crossing, the guards shield-up walking backward.
- **Spread:** arrivals at the spawn and a `line`/`attack` with no slot hold places ≥ 2 apart (`lineSlots` rows of 5
  across the axis), not one pile.

## 4. Benchmark (`squad/tests/general-bench.test.ts`, on fakes, in `npm run check`)

20 v 20: the General's army (5 per kit) against a scripted enemy (10 archers static 100 blocks out on the axis,
10 melee advancing), a scripted "General" policy standing in for the model (the doctrine's checklists as code: what a
turn would do, with a 15 s turn latency). Scores: seconds from first `contact` to first order per squad, bot-seconds
idle > 5 s, kills per loss (a coarse damage model on the fakes: arrows hit within range and line of fire). Run
before and after each step; the numbers are recorded here.

## 5. Order of work (one commit each, tests and docs with it)

1. Attribution + `under-fire`/`enemy-approach` + lost-cluster memory + per-bot action. 2. Diff sitrep + cadence.
3. Batch `orders`. 4. Standing orders (§1) with the kit defaults. 5. `attack approach` + blocked marks + far-target
refusal. 6. Safe reinforcement. 7. Cavalry `retreat`, `line` `reserve`/`fallback`, spread. 8. `flank`. 9. The
benchmark (started at step 1, extended at each). 10. `agent/general/CLAUDE.md` last.

## 6. For the owner

- **OK on §1?** Especially: the kit defaults (on unless cleared), model orders winning for 5 s, and the separate
  60/min budget for runtime-fired orders.
- The work builds on uncommitted files (docs/40–44, `line.mjs`, `lance.ts`, the merged `attack`). Commit them first
  as their own commit, or should mine include them?

## 7. As built

1. **Attribution and sight** (step 1). `squad/src/bots/hits.ts` emits `hurtBy` for every `damage_event` with a
   source (`hurtOf`: melee when the cause is the direct source, `arrow` for a projectile, its shooter as `attacker`
   when seen, `from` the shooter's place or 16 blocks back along the arrow's flight). The General keeps 10 s of hits
   (`Generals.hurt`); `casualty` names the killer (its last hit), `hp-band` sums the hits by kind, bearing and
   cluster (« 3 hits in 10s: 3 arrows from NE ~70b (X1) », else « no hit seen »); `under-fire` (≥ 3 arrows in 5 s,
   10 s apart per squad) and `enemy-approach` (within 48, closing ≥ 1 b/s, again only after going beyond 64) are new
   waking events. A lost cluster keeps `lastVelocity`: « X2 1 LOST 15s ago, last @E36 y64 →W 1.6b/s … »; the map
   draws it `o`. `squad_detail` gives per bot its order and role, what it does (mounted, fighting X, drawing its bow,
   shield up, moving to E30 (12b), standing), its hits in 10 s and the last log line naming it. Tests:
   `tests/hits.test.ts` (hurtBy), `tests/general.test.ts` (attribution).
