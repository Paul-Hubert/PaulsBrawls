# The General: audit before the reform (2026-11-05)

What each finding of the 2026-11-05 defeat (20 v 20 against PUALHubert's bots, lost twice; brief:
[docs/general-reform-prompt.md](../../general-reform-prompt.md)) is in the code today. Paths are relative to `squad/`
unless they start with `docs/`. Line numbers are those of the working tree on 2026-11-05 (docs/40, 41, 43, 44 and
`src/stock/line.mjs`, `src/api/lance.ts` are not committed yet).

## 1. The army sat in one clump; the cavalry never charged

| What | Where |
|---|---|
| The doctrine's default reaction to `contact` is "form a `line` (a shield wall, archers behind it)" and lists `attack`/`raid` as alternatives. Two of its four "typical plans" put everything in a `line`. Nothing says a mobile force must keep a moving order. | `agent/general/CLAUDE.md:22-24`, `:87-94` |
| In `line`, a bot with neither shield nor bow (a horseman, a spearman) takes the `melee` role, gets a flank slot 2 blocks beyond the wall's end, and runs the **guard** loop: walk to the slot, face the line, hit back once only when hit in melee. It never moves toward an enemy and never lances. | `src/stock/line.mjs:34` (role), `:88-91` (flank slots), `:74`, `:308` (melee bots run `guard`), `:168-184`, `:310-311` (hit back only after `meleeHit`) |
| The briefing does say horsemen stand "on the wall flanks", but not that they then never charge. | `src/general/general.ts:360` |
| Charging exists only inside `attack`, while a group is pointed at: `lanceWaves` (form, charge through, re-form beyond, charge back). It has no health threshold: riders charge until the group is gone or `seconds`. | `src/stock/attack.mjs:273-293`, `:313-317`; `src/api/lance.ts:219-300` |
| `attack` is bounded (`maxMinutes` 10, `seconds` 60 by default) and ends silently into idleness, so a cavalry squad that was given one `attack` stands still after it unless the model gives the next order. | `src/stock/attack.mjs:41-42`, `:331`; `src/general/general.ts:656-670` (an `order-end` event, nothing else) |
| No idle check per squad: `idle` fires only when **every** squad is idle **and** no enemy is visible, once, after 20 s. A squad idle during a fight is invisible to the General. | `src/general/general.ts:47`, `:800-812` |

## 2. Reaction in tens of seconds, the fight in seconds

| What | Where |
|---|---|
| Every reaction is a model turn: nothing in the runtime reacts to `contact`, health or deaths except the advance's leg chaining (which only continues a march). | `src/general/general.ts:786-798` |
| `wait_events` waits up to `timeout_s` (default **45**, max 50) and, once woken, another **2 s** (`COALESCE_MS`) for the burst. | `src/http/general-mcp.ts:83`, `:88`; `src/general/events.ts:32`, `:80` |
| Each answer carries the **full** sitrep (header, mission, every squad, every cluster), not a diff, so every wake costs a full read. | `src/general/general.ts:458-468`, `:370-387` |
| The doctrine has no tempo rule: no timeout guidance, no "order in the same turn", nothing against `sleep`. (The instance has only `mcp__general` tools, so a `sleep` would be a stalled turn, not a Bash call.) | `agent/general/CLAUDE.md:16-26` |
| One plan of four squads is four `order` calls; there is no batch. Orders are capped at **20 a minute per General**, and the advance's own legs count against it. | `src/general/general.ts:45`, `:622-626`, `:672-692` (`leg` → `start`) |
| The sampler that sees everything runs once a second. | `src/general/general.ts:186` |

## 3. Horse archers in `attack` shot grass at 100+ blocks

| What | Where |
|---|---|
| `attack` archers "never walk, except a step aside after no clear line of fire". The foe is chosen around the **target** (`group` radius), with **no limit on the distance from the archer**, so an archer 100 blocks away keeps drawing at it. | `src/stock/attack.mjs:14-15`, `:138-147` (groupPick), `:199-227` |
| A blocked shot only sidesteps and retries the same foe. Unlike `line`, `attack` never marks a foe as blocked (`targets().block`), so it loops on the same impossible shot. | `src/stock/attack.mjs:221-222`; compare `src/stock/line.mjs:52`, `:242`, `:270`; `src/api/formation.ts:382-388`, `:411-415` |
| The text "no clear line of fire: grass_block is in the way" comes from the aim solver (both arcs blocked by terrain), which is what a low-angle shot over 100 blocks of rolling ground gives. | `src/api/helpers.ts:922`, `:992-994` |
| Nothing tells the General: the briefing says archers "shoot from where they stand", but neither the briefing nor `order` refuses or warns on a far target, and the shots' failures are only in the order's log (visible through `squad_detail`). | `src/general/general.ts:359`, `:547-554` |
| `raid` does close distance (the group marches on the point; archers shoot within `radius` ≤ 48 of the leader), so `raid` is the right order for horse archers at range, but no text says so. | `src/stock/raid.mjs:86`, `:123-141` (`engage`), `:156-219` (`lead`) |

## 4. Reinforcements died as they arrived

| What | Where |
|---|---|
| `reinforce` brings the dead back **at the spawn point** (by design, docs/38 §2), with no rally point, no order on arrival and no check for enemies near the spawn. | `src/general/general.ts:514-531` |
| A revived bot is not in any order: a death removes the bot from its order, and nothing adds it back on revival. It arrives idle. | `src/orders/order.ts:369-370`; `src/general/general.ts:525` |
| `arrived` is the one kind that does **not** wake `wait_events` by default, so a sleeping General is not woken when its reinforcements stand idle at spawn. | `src/general/events.ts:21-22` |
| A cluster near the spawn appears only as an ordinary `contact`; no event says "near the spawn". | `src/general/general.ts:782` |

## 5. Damage is invisible

| What | Where |
|---|---|
| `casualty` says who died and how many are left: not by whom, from where or with what. ("killed by what" is listed as not built.) | `src/general/general.ts:829-841`; `docs/38-squad-general-plan.md` §10 |
| `hp-band` says a squad's mean health crossed 75/50/25 %, nothing else. | `src/general/general.ts:815-827` |
| The protocol has the attacker: every `damage_event` carries `sourceCauseId` (the shooter) and `sourceDirectId` (the arrow). `hits.ts` keeps only the melee case (cause = direct, within 5 blocks) and drops projectiles. Nothing else listens. | `src/bots/hits.ts:50-56`, `src/bots/pool.ts:473` |
| No `under-fire` or `enemy-approach` event exists. | `src/general/events.ts:5-18` |

## 6. Contact was thin

| What | Where |
|---|---|
| A cluster unseen for 15 s is `lost`: its velocity is set to null, and its line shows `LOST` **instead of** a heading. Its last position stays (`center`), and it is forgotten after 2 min. | `src/general/perception.ts:121-122`, `:194-197`; `src/general/general.ts:1076` |
| A cluster moving under 0.5 b/s shows `static`; the velocity is the centre's drift over 3 s, so a cluster whose members come and go reads as a jump, not a heading. | `src/general/general.ts:1071-1072`; `src/general/perception.ts:124`, `:215-223` |
| The sitrep shows a squad's nearest cluster only within 32 blocks. | `src/general/general.ts:1033-1040` |
| `squad_detail` shows per bot: kit, hp, position, held item, and `order command:role`, then the order's last 6 log lines (all bots mixed). It does not show what each bot is doing (moving to, shooting at, charging, holding). | `src/general/general.ts:389-416` |
| The map overlays only visible clusters, not lost ones. | `src/general/general.ts:428` |

## 7. What worked, and why

The wall held out of the enemy archers' reach while its own archers used `line`'s `range` (120): `line` archers pick
any threat within `range` of themselves, front first, and mark blocked targets for 5 s.
`src/stock/line.mjs:25`, `:49`, `:187-194`, `:242`, `:270`.

## 8. Constraints the reform keeps

- **One writer per state:** a squad's running order is written only through `Generals.start` (`general.ts:622-654`),
  which stops the previous one quietly. Any runtime reaction must go through it too.
- **A second consumer before new machinery:** the advance is already a rule the runtime runs without the model
  (`general.ts:786-798`, `ended` at `:656-670`). Standing orders are its second consumer.
- **Nothing hot is journaled (R44):** perception and events are in memory (`events.ts:1-3`).
- **Stock files ≤ 400 lines:** `attack.mjs` 346, `line.mjs` 316, `raid.mjs` 262; new behaviour of size goes into
  `src/api/` helpers (as `lance.ts` did) or a new stock file.
- **The player's commands are shared:** `attack`, `line` and `raid` are also bound to items and clicked by players
  (docs/29 §5.4, docs/40). A change for the General must keep the player's defaults.
