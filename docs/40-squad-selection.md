# 40 — Squads, the selector, `line` and `attack` (as built, 2026-11-04)

Paul's request: each squad spawn is a separate squad; an item bound to a special command selects, on right-click, the
squad of the bot under the crosshair, with a message; the next orders go to that squad. A right-click on no bot
deselects, and a bound item's order then fails with a short « no squad selected ». `ligne-archers` and
`mur-de-boucliers` become one `line` command, `epee` and `tir` one `attack`.

## 1. A squad is a roster tag

- Every `/bots squad spawn` is one squad. `SquadSpawn.spawn` picks its tag, `esc-N`
  (`SquadSelection.nextTag`: one past the highest `esc-N` in the cached roster and the last one this server gave, so
  two spawns in a row differ before the state shows the first), and each recruit gets `+esc-N` with its kit tag on
  arrival. The answers name it: « Escouade 3 : 5 archer(s) pour Paul… », « Escouade 3 prête (…) ».
- The tag lives in the runtime's roster like any tag (`/bots tag` can change it; `/bots equip`'s kit changes keep
  it), so it survives restarts, deaths and `/bots squad respawn`.
- Bots spawned otherwise (`/bots spawn`, raid, General) have no squad and cannot be selected (« X n'est dans aucune
  escouade »). Bots spawned before this change neither: spawn them again with `/bots squad spawn`.

## 2. The selector (mod)

- `/bots orders bind select` (tab-completed first) binds the held item to the reserved order `select`
  (`SquadSelection.SELECT`), locally: nothing is asked of the runtime. Lore « Sélecteur d'escouade ».
- A right-click with it (`SquadTriggers.onUse`, any item, a bow too, sneaking or not; its arrows are no trigger)
  casts the player's look (`SquadLook.cast`, as far as they see). The crosshair's entity:
  - one of the player's roster bots with an `esc-N` tag: that squad is selected, « Escouade 3 sélectionnée :
    Archer01, Garde01 (2 bots). »;
  - another player's bot: « X n'est pas à toi. » (nothing changes);
  - one of theirs with no squad: « X n'est dans aucune escouade (…) »;
  - anything else or nothing: deselect, « Escouade désélectionnée. » (« Aucune escouade sélectionnée. » when none was).
- The selection is per player, in memory (`SquadSelection`), forgotten at disconnect and at a server restart.

## 3. Orders go to the selected squad

- Every bound item's click (start, re-aim, sneak + right-click stop) carries `squad: "esc-N"`
  (`SquadTriggerJson.body`); with nothing selected it is not sent, and the player reads « Aucune escouade
  sélectionnée. » (once per 2 s, the limiter's rule). A bow's arrow-hit goes to the squad selected at its release.
- `/bots order` carries the selection too; with none, all the player's bots as before (typed orders keep working
  without a selector).
- Runtime (`orders/runner.ts`): `OrderRequest.squad` (a tag; the HTTP routes drop a malformed one, `squadOf`).
  - Only the commander's bots carrying that tag are candidates (`candidates(uuid, filters, squad)`), at the start, at
    a click's take-back and for `squad.acquire`. None of them: « Aucun de tes bots dans l'escouade sélectionnée ».
  - The binding key is (commander, command, squad): squad 1's `line` and squad 2's `line` are two orders, each re-aimed
    and stopped by its own squad's clicks. `Order.squad` records it.
- Tests: `squad/tests/triggers.test.ts` (scoping, two squads, stop), `tests/http.test.ts` (the field through the
  routes), `SquadSelectionTest`, `SquadTriggerJsonTest`.

## 4. `line` and `attack`

`src/stock/line.mjs` and `src/stock/attack.mjs`; the four old files are deleted (and the old two-line stock `attack`
replaced). The General offers `raid`, `attack`, `line` and, since docs/45, `flank` (`general.ts` `OFFERED`).

- **`line`** = the shield wall and the archer line in one order. Roles `guards` (a shield) and `archers` (a bow, no
  shield), neither required (no bot at all: an error). One point (as before: the arrow's hit, the crosshair, else 8
  blocks ahead); the wall on it, the archers' ranks `back` (4) blocks behind it. Each role behaves as its old command
  did (slots, last step, the guards' blow back, the archers' targets and sidesteps). A squad of guards alone is a
  wall; of archers alone, the old archer line. Params: `distance`, `spacing` (guards, 1), `archerSpacing` (2), `back`,
  `range`, `ranks`, `reach`. Until stopped. 398 lines (the 400-line cap of a command holds for stock files too).
- **`attack`** = `epee`'s target fight with `tir`'s volley, **bounded** (`maxMinutes` 10): a target: archers shoot
  from where they stand, two melee bots on it, the others on what is near it, until it is dead or gone or `seconds`
  (60); the ground: each archer fires `volley` (3) arrows over a disc of `spread` (3), then shoots threats within
  `radius` of the point, the melee bots take a ring of 3 around the point and fight there; it ends once the volley is
  fired, the melee bots are by the point and nothing has been near it for 1.5 s, or after `seconds`. The sky: « Aucune
  cible. » (a later click: said, the attack goes on); a friend: refused. Archers never walk unless `approach` > 0 (docs/45: they close in to that distance; the General's default 40); otherwise (a sidestep after "no
  clear line of fire" only). Because it ends, bots it took from a `line` go back to their slots (as `tir`'s did);
  `epee`'s fall-back to defending the commander is gone.

Mounted bots (horses) in these commands: [docs/41](41-squad-horses.md).

## 5. Not done

- **Live tests** (`squad/live-tests/items.ts`, `range.ts`, `run.ts`) still name the four old commands, and the
  scenarios driven through the mod would now need a selection: not ported, not run.
- Not checked in game: the selector's raycast on a real client, the messages, two squads side by side.
- The selected squad is shown only in chat (no glow or HUD).
