# 41 — Mounted bots in `raid`, `attack` and `line` (as built, 2026-11-04)

Paul: « raid, attack and line should work with horse bots ». The mounted kits (`horseman`: spear; `horsearcher`: bow)
seat a bot on a tamed, saddled horse (`Squad.mount`). Before this, nothing moved the horse: the server moves a horse
its player rides only from that player's `vehicle_move` packets (vanilla's client runs the horse's physics), and
mineflayer sends none. A mounted bot sat still whatever its order.

## 1. Riding (`squad/src/bots/mount.ts`, installed on every bot after spawn)

- **The body walks, the horse follows.** While the bot rides a horse-like mount (`horse`, `donkey`, `mule`,
  `skeleton_horse`, `zombie_horse`), mineflayer's physics keeps moving its body as on foot, with the pathfinder's
  controls; every `physicsTick` the body's position goes to the server as the horse's move (`vehicle_move`, its yaw
  the rider's). So every command, goal, helper and look works unchanged. The body starts where the horse stands.
- **The server keeps the claim** (it moves the horse with the horse's collisions) unless the horse would end inside a
  block; then it sends the horse's position back, and the body goes there.
- **Eyes and speed.** The body's feet are the horse's, so its `eyeHeight` is the player's + the seat (0.84375 = the
  horse's passenger attachment 1.44375 − a player's vehicle attachment 0.6): aim, `lookAt` and reach use the rider's
  real eyes. Its speed attribute is the horse's (from the server's attributes, else 0.225) ÷ 1.3, so the pathfinder's
  sprint goes at the horse's speed. Both re-asserted every tick; restored on foot.
- **Sneaking dismounts a rider**, so while riding the sneak packets (`player_input` shift, `entity_action` 0) are not
  sent: the control stays local, and a `line`'s slow last step (`stepTo`) still works.
- Off the horse (it died, a dismount) nothing is left of this.
- **mineflayer patch** (`squad/patches/mineflayer+4.39.0.patch`, found live 2026-11-04: « line doesn't move horses »).
  Upstream's physics plugin stops physics on `mount` (`shouldUsePhysics = false`, `lib/plugins/physics.js`) until
  the server's next teleport: no `physicsTick`, so the body never walked, no `vehicle_move` went out (and no look
  either). The patch keeps physics on while riding. The unit tests had emitted `physicsTick` by hand and missed it;
  `tests/patches.test.ts` « patch 4 » now runs mineflayer's own plugin through a mount, and
  `live-tests/probe-horse.ts` rides a horse on the dev server (14.9 blocks in 2 s; 0 before the patch).
- Tests: `squad/tests/mount.test.ts`.

## 2. The commands

- **`raid`, `attack`**: no change needed. Their roles already took every bot: horse archers are `archers` (a bow),
  horsemen `melee` (no bow).
- **`line`**: a third role, `melee` (neither shield nor bow: horsemen). They hold the wall's flanks, `FLANK` (2)
  blocks beyond each end and 2 apart (a horse is 1.4 wide), alternately left and right; with no guards they form the
  line on the point themselves. They hold their slot facing the view and, hit in melee, hit back once like a guard,
  with no shield. Horse archers are archers (spacing 2 already). Weapons for the blow back include `_spear`. Test:
  « line with horsemen » in `squad/tests/item-orders.test.ts`. The General's briefing names the role.

## 3. Bots with no horse (and no kit), fixed 2026-11-04

After `/bots squad spawn` about every other bot had neither kit nor horse (« X n'est pas connecté : impossible de
l'équiper » in the server log; raiders too). Fabric's `JOIN` fires before the server adds the player to its list, and
`Squad.arrive` ran the arrival's callback with `srv.execute`, which on the server thread outside a task runs it at
once: `equip` looked the bot up by name and found nobody. Only bots the kit pacer delayed (another kit within
`kitStaggerMs`) got theirs. Now `arrive` queues the callback, and `Squad.runArrivals` (`END_SERVER_TICK`) runs it once
the bot is in the player list (a bot not listed within 100 ticks is dropped, with a warning). Spawn, respawn, raid and
General arrivals all go through it. Checked by compiling and the JUnit suite only: not yet in game.

## 4. The event loop starved by `attack` (and `raid`), fixed 2026-11-04

Found live: `attack` on horsemen, « event loop overloaded … loop p99 3039 ms, slowest bot 1.3 ticks/s » (30 bots).
The `attack()` helper breaks off before its first swing, awaiting no timer, when the bot is more than `radius` + 4 from
its leash's centre. `epee` slept after a break-off; the merged `attack` (docs/40) did not, so a melee bot far from the
point or the target (a horseman riding there) looped on microtasks until the 3 s starvation canary. `raid` had the
same trap (`engage` then `continue`, a guard far from its formation anchor).
- `attack`: a melee bot farther than `radius` + 3 from the centre rides closer first; after a break-off it pauses
  `LOOK_MS`; and any look that awaited no timer (under 5 ms) is followed by a pause (a backstop).
- `raid`: `fight` does not start one from farther than `radius` + 3 of the anchor and reports a break-off, so the
  soldier keeps up instead; a fight under 5 ms is followed by a pause.
- Test: « attack: melee bots far from the point ride there… » in `squad/tests/item-orders.test.ts` (it timed out on
  the unfixed command: the riders never reached the zombie).

## 5. Limits, unverified

- The production runtime must be restarted to load the patch (it is read once, at start).
- A horse is 1.4 wide and the pathfinder plans for a 0.6-wide body: through a door or a 1-wide gap the server stops
  the horse and the bot's pathfinder sees no progress.
- Horses jump as the body does (a 1.25-block jump); their own jump strength is not used.
- **Not checked live**: the server's « moved wrongly » tolerance on uneven ground, a horse's step-up versus the body's
  jump, the aim from the saddle, a spear's blow, fights at speed, a `line` of horsemen end to end. Only riding straight
  on flat ground ran against a server (`live-tests/probe-horse.ts`).
