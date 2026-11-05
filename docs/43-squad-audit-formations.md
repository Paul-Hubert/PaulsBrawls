# 43 — Squad: the recurring-bug audit, the direct walk onto a slot, the formation helpers (as built, 2026-11-04)

The job was [docs/42](42-squad-audit-prompt.md): **A** audit the bug classes that keep coming back, **B** walk
straight onto a line's slot instead of crouch-walking the last step, **C** groundwork so that richer orders are short
and safe to write. Nothing is committed.

## A — The audit

Every candidate site, with its verdict. "Fixed" rows have a test that failed on the code before the fix (run and seen
failing first).

### A1 — Loops that await no timer

| Site | Verdict | Fix, test |
|---|---|---|
| Every script `await` (`script/compile.ts` `__aw`) | **Bug, the class itself.** A loop awaiting only resolved promises (an `attack()` that breaks off at once) ran in microtasks until the 3 s starvation canary. | An `await` goes through a macrotask (`setImmediate`) once the 100 ms heartbeat is more than `YIELD_MS` (150) late: no script loop can hold the event loop longer. `compile.test.ts` « a loop that awaits only resolved promises lets timers run » (no timer fired during a 1.2 s loop before). |
| `follow()` (`api/helpers.ts`) on a destroyed entity | **Bug.** `isValid === false` broke out before the first sleep: `follow`, `defend`'s `home`, `raid`'s `keepUp` spun on a stale `players[name].entity`. | It waits `untilMs` like a null entity. `follow.test.ts` « an entity that is no longer valid… ». |
| `attack.mjs` per-bot loops | Bug, already patched (docs/41 §4) with a 5 ms time backstop. | Now `squad.crew` (every pass padded to 50 ms, at least a macrotask) and `melee()` (closes in instead of starting a fight that breaks off). Test « attack: melee bots far from the point ride there… » still passes. |
| `raid.mjs` soldier loop | Same as attack (5 ms backstop). | `squad.crew` + `melee()` + the `follow` fix. `raid.test.ts`. |
| `line.mjs` per-bot loops | Not a bug: every path sleeps, except one pass after a hit (`strikeBack` returning early) or a step that `until()` ends at once. | `squad.crew` pads them anyway. |
| `defend.mjs` guard loop | Not a bug once `follow` is fixed (an `attack` on a dead target resolves at once, but the next pick finds nothing and `home()` follows). | — |
| `follow.mjs` | Not a bug once `follow` is fixed. | — |
| Helpers: `attack` (200 ms), `shoot` (50 ms poll), `smeltItem`, `exploreUntil`, `follow`'s inner loop, `stepTo` (50 ms) | Not bugs: each pass sleeps. | — |
| `squad.tasks` (`nextTurn`), `parallelLive`, `pool.drain` (finite queue) | Not bugs. | — |
| The General (`general/general.ts`) | Not a bug: no script loop; a `setInterval` and awaited HTTP/MCP calls. | — |

### A2 — Server and library event order

| Site | Verdict |
|---|---|
| `Squad.arrive` / `runArrivals` (kits and horses at arrival) | Fixed on 2026-11-04 (docs/41 §3): `then` runs once the bot is in the player list. Checked: every arrival path (spawn, respawn, raid, General) goes through it. |
| `Squad.expectArrival` with a bot that joined first (`unexpected`) | Not a bug: it goes through `arrive` too. |
| `Squad.tell` (`srv.execute` from the SSE thread) | Not a bug: off the server thread `execute` queues; a player not yet listed gets the line from `pending` in `onJoin`, which writes to its connection directly. |
| `refreshState` → `syncWhitelist`, `SquadGeneral.onSpawn/onDespawn`, every `thenAccept(… srv.execute …)` | Not bugs: called from HTTP/SSE threads, so queued. |
| `paced()` running `give` inline | Not a bug: called on the server thread from `runArrivals`, after the bot is listed; a delayed one goes through `delayedExecutor` then `execute`. |
| Lookups by name in `equip`, `resetToKit`, despawn | Not bugs: they run after arrival or on commands, not in `JOIN`. |
| `RevenueManager` `JOIN` | Fixed earlier (docs/39): `handler.getPlayer()`. |
| mineflayer stopping physics on `mount` | Fixed earlier (patch, docs/41). `installRiding` handles a bot already seated. |
| The selector reading the mod's cached roster right after a spawn | Not fixed (minor): the tag reaches the cache with the next `state` event, sub-second; a click in that window says « n'est dans aucune escouade ». |

### A3 — Libraries that silently do nothing

| Site | Verdict |
|---|---|
| `pvp` giving up out of view distance | Handled: `attack()` breaks off when `pvp.target` is null. |
| `bot.attack` out of reach (nothing happens) | Guarded by `inReach` in `line`; was measured from the wrong eyes for a rider (A8, fixed). |
| pathfinder `noPath` on an unreachable slot | Handled: `approach` times out; `line` holds loosely after 10 s (`STUCK_MS`). |
| pathfinder `stop()` latent flags | Handled: `stop()` then `setGoal(null)` everywhere (`stopMoving`, the abort sequence). |
| `usingHeldItem` cleared by any entity status | Handled (`raiseShield`'s own record). |
| `shoot` firing nothing | Handled: « no arrow left the bow » and « no clear line of fire » are errors. |
| `entityHurt` missing shield blocks | Handled (`hits.ts`). |
| Undecodable packets | Handled (`protocol.ts`). |
| A finished subroutine's `ctx.commander.on('trigger')` listener | **Bug** (found by the C2 work): it kept getting the order's clicks (a finished `attack` would retarget and say « Aucune cible. »). Fixed: `subCommander`. `compose.test.ts` « no click reaches an ended subroutine ». |

### A4 — A bot that leaves and comes back

| Site | Verdict |
|---|---|
| Dead bots looping (F1) | Handled: `checkLease` first in every helper. |
| Listeners on a returning bot | Handled: removed on leave; `line` re-adds `meleeHit` in `squad.crew`'s `setup`. |
| Loop tokens | Handled by `squad.crew` (one token per launch). Residual, not fixed: a bot that leaves and comes back inside one pass's sleep gets the same guard object, so the old pass can issue one call before it sees its token. Lending inside an order (C3) uses per-holder guards and has no such window. |
| Per-bot maps (`heading`, `struck`, `aside`, `walkOn`, blocked targets, `spots`, `taken`) | Not bugs: a stale slot heading is replaced when `reached`, the others are time-bounded or released in `finally`. |
| Pool handlers keyed by name (Eden's R66) | Not a bug: every handler checks `rec.bot === bot`. |
| A subroutine view's `joined` for bots outside it, roles never refreshed | **Bug** (C2): fixed by views with their own events (below). `compose.test.ts`. |

### A5 — Read-after-write and arrival races

| Site | Verdict |
|---|---|
| Block changes a tick late (Eden R55) | Not applicable: no stock command reads back a block it changed. |
| Spawn/despawn/respawn of a name | Not a bug: an order's guard checks `deps.bot(name) === real`, so a respawned bot (a new instance) is not driven by an old order. |
| The selection pointing at a squad whose bots are gone | Handled: « Aucun de tes bots dans l'escouade sélectionnée ». |
| Squad tag from the cached state | See A2 (sub-second, not fixed). |

### A6 — Ports and merges that dropped a line

`line` against `mur-de-boucliers` + `ligne-archers`, `attack` against `epee` + `tir` (`git show HEAD:…`):

| Behaviour | Where it went |
|---|---|
| `AHEAD`: the wall 5 blocks ahead, the archer line 10, when the point is too far or the sky | **Changed, not restored**: one point 8 ahead for both (docs/40's single point). An archer line with no wall now stands 4 ahead instead of 6. |
| `guards`/`archers` `min: 1` | Dropped on purpose (docs/40: neither role is required). |
| `epee`'s fall-back to defending the commander, its archers' ring of 6 at a held point | Dropped on purpose (docs/40: `attack` ends; archers never walk). |
| `tir`'s `seconds` 8 (max 50) | Now `epee`'s 60 (max 600) for both kinds (docs/40). |
| `tir`'s silent retarget onto « no archer sees it » | Now said: « Cible hors de vue de mes bots. ». |
| `tir` awaiting its loops before returning | Not needed: the order's end aborts them. |
| Everything else (slots, the last step, the blow back, `_spear` added, targets, sidesteps, blocked targets, walk-on, the volley, the ring of 3) | Came across. |

### A7 — Copies that diverged (removed by C)

| Copy | Where | Differences |
|---|---|---|
| `ground`/`anyBot` | line, attack | line skipped a leaving bot by hand; attack via `anyBot`. Now `anyBot`, `onGround`. |
| `pointOf` / `pointAt` | line / attack | Now `pointOf` and `pointedTarget(squad.bots, …)`. |
| `isFoe` | line, attack, raid | Identical. Now `isEnemy`. |
| `taken`/`load`/`take` | line (one map, no cap), attack and raid (per role, cap) | Now `targets()`. |
| `pick` | line (4 tiers + blocked memory), attack (2 tiers from the point), raid (2 tiers, the nearer of player and mob) | Now `targets().pick` with tiers and `prefer`. **Only line remembers a target a block stopped a shot at**; attack and raid re-pick it after a sidestep. Kept as it was (no behaviour change); `block()` is there for them. |
| `sidestep` | line (1–2 random, clears its heading), attack (1–2), raid (fixed 2, 400 ms) | Now `sidestep(bot, from, { min, max })`. |
| `crew`/`launch` | line (token + listener), attack (token + 5 ms backstop), raid (live `parallel` + 5 ms backstop) | Now `squad.crew`. |
| the slot `heading` machinery, `step`/`walk` | line | Now `approach` (B) and a short `go` in line. |

### A8 — Mounted bots

| Site | Verdict |
|---|---|
| `line`'s `canStrike` with a fixed 1.62 eye height | **Bug**: a rider's eyes are 0.84 higher (mount.ts), so it swung at what was out of its reach and stepped toward what was within it. Fixed: `inReach` uses `entity.eyeHeight`. `item-orders.test.ts` « a rider's reach is measured from its eyes in the saddle ». |
| Sneak packets | Handled (mount.ts filters them); B no longer sneaks at all. |
| Aim from the saddle | Handled (`draw.ts` uses `eyeHeight`). |
| Spacing for 1.4-wide horses | `FLANK` 2, `archerSpacing` 2, rank depth 2: fine. `attack`'s ring of 3 around a point overlaps past 13 horsemen (not fixed). |
| A horse dying mid-order | Handled: `dismount` restores eyes and speed; `stepTo` takes its acceleration from the speed attribute and corrects it from each tick. |
| `pvp`'s reach (3.5, feet to feet) from the saddle | Not changed; the server's reach check is lenient. Unverified live. |

### A9 — Squad scoping (docs/40)

| Path | Verdict |
|---|---|
| Start, take-back (`order.squad`), `squad.acquire` (`squadDeps.candidates`) | Scoped to the tag. |
| Reclaim | The plan runs over the scoped candidates only: an `esc-1` order never reclaims an `esc-2` bot. |
| `ctx.run` | Within the order's own bots (now lent, C3). |
| The General | `filters` = the squad's members. |
| Raids | The raid owner's bots (one army). |
| Stop | A bound item's stop reaches only its squad's order. `/bots stop NAME` (typed) stops that command in every squad of the player: by design, not changed. |

## B — The direct walk onto a slot

`approach(bot, place, …)` and `stepTo(bot, place, …)` (`squad/src/api/formation.ts`), used by `line` and available to
every command:

- Far away: the pathfinder, `GoalNear` on the slot's exact coordinates (range 2), until the body is within 2 blocks.
- Then the bot walks there itself, at walking speed, **never sneaking**, steered on every physics tick, and stops on
  the place. Each tick it predicts where the body would come to rest if let go now (prismarine-physics keeps 0.546 of
  the horizontal velocity per tick on the ground, so a body let go slides `velocity / (1 − 0.546)` on: mineflayer's
  `entity.velocity` is after that tick's friction). It lets go of `forward` when that rest point is within 0.04 of the
  place; otherwise it holds `forward` one more tick toward the error. A held tick moves the rest point by the walking
  acceleration × 2.2 (0.22 block on foot, 0.37 on a horse of speed 0.225); an error smaller than that is closed by two
  ticks at an angle either side of it, whose sideways parts cancel. So a horse stops within 0.15 too, which a plain
  "let go at the slide distance, tap if short" cannot do (one tap is 0.37). The acceleration comes from the speed
  attribute (with its modifiers) and is corrected from what each walked tick actually did.
- Done at rest within 0.15. A new formation, a foe to shoot or a hit to answer ends it at once (`until`, checked
  every 50–100 ms); a direct walk that cannot get there in 3 s gives up (`line`: holds where it got); a slot not
  reached in 10 s is held loosely (`STUCK_MS`, `LOOSE`); the guards' shield goes down to walk and up on arrival; a bot
  pushed off walks back (directly within 2 blocks).
- Tests: `squad/tests/approach.test.ts` (FakeBot now has prismarine's ground physics: acceleration, velocity,
  friction): within 0.15, at rest, no overshoot, no back-and-forth, never sneaking, from 0.12 to 2.63 blocks, on a
  horse, arriving at a sprint, a faster body than its attribute says, `until`, timeout, take-over; `approach` from 12
  blocks and a loose hold. The `line` tests in `item-orders.test.ts` now check the walk's controls (forward, never
  sneak).

**Measured live** (dev server 26.1.2, `squad/live-tests/probe-line.ts`: ten guards and ten archers starting in a 5×4
block behind the captain, the point 14 blocks ahead; horses of speed 0.225; the time from the click to the last bot's
last movement, and each bot's final offset from its exact slot, read over RCON):

| Run | yaw | before: last bot settled | before: within 0.15, worst | after: last bot settled | after: within 0.15, worst |
|---|---|---|---|---|---|
| on foot | 0 | 4.4 s | 20/20, 0.05 | **2.9 s** | 20/20, 0.01 |
| on foot | 45 | 5.7 s | 20/20, 0.12 | **3.5 s** | 20/20, 0.03 |
| on foot | 87 | 4.4 s | 20/20, 0.08 | **2.7 s** | 20/20, 0.05 |
| mounted | 0 | 3.6 s | 20/20, 0.11 | 3.9 s | 20/20, 0.02 |
| mounted | 45 | 3.7 s | 20/20, 0.08 | 3.5 s | 20/20, 0.01 |
| mounted | 87 | 3.6 s | 20/20, 0.08 | 3.9 s | 20/20, 0.04 |

On foot the line now forms 1.5–2.2 s sooner (the sneak was 0.3 of walking speed over the last 0–0.7 block, plus the
walk to a block's centre first). Mounted, the old step was already fast (a sneaking horse body still moves at
0.3 × the horse's speed, and the packets were filtered) and the new walk is about as fast (±0.3 s, within the run to
run noise of the pathfinder's part), with every offset smaller. Every bot of every run ended within 0.15. The per-bot
offsets are in the probe's output (`LABEL=before|after npx tsx live-tests/probe-line.ts`).

## C — Groundwork for richer orders

1. **Formation and fight helpers** (`squad/src/api/formation.ts`, scope globals, typed in `reference/squad.d.ts`):
   `approach`, `stepTo`, `anyBot`, `onGround`, `pointOf`, `assignSlots`, `lineUp`, `isEnemy`, `nearestFoe`,
   `targets()`, `inReach`, `melee`, `sidestep`; `pointedTarget` also takes `squad.bots`; and `squad.crew(fn, { roles,
   while, setup, minPassMs })`, one loop per bot (a token per launch, relaunched on `joined` with `setup` again for
   its listeners, every pass padded to 50 ms and at least a macrotask). `line` (397 → 261 lines), `attack` (367 → 268)
   and `raid` (303 → 262) are written on them, with no behaviour change but B and the A8 reach.
2. **`ctx.run` that composes** (`api/squad.ts` `Squad.view`, `orders/order.ts` `lend`/`unlend`/`guardFor`,
   `orders/runner.ts` `runSub`): a subroutine runs on a view of its caller's squad, whose bots are **lent** to it while
   it runs. `Order.lentTo` keeps a stack of holders per member; each holder has its own guarded bot, and a guard
   whose holder is not on top throws `BotLeftError('lent')`, so the caller can no longer move a lent bot (its
   listeners on it are removed, the abort sequence stops what it was doing). A lent bot leaves the caller's arrays
   (`left`, reason `lent`); the view puts it in the first of its manifest's roles it matches with room; a role's
   unmet `min` is logged, no longer thrown. Given one of the caller's live arrays (`squad.roles.melee`), the view is
   live: a bot joining it later (back from a reclaim) is lent too. The view's `on`, `parallel`, `tasks`, `crew`,
   `sleep`, `untilStopped` are its own. It ends when the subroutine returns or throws, or from outside: `until()`
   (every 100 ms) or `signal` (`ctx.run` then resolves undefined); its bots go back to the holder under them
   (`joined`, with the role they had), its sleeps reject, its commander listeners are removed.
3. **The script API for orders that span time and squads**: `squad.tag` (the `esc-N` the order is scoped to, or null),
   `squad.bots`/`roles` (its members, live), and the supported way to hand bots on is now `ctx.run` with lending, inside
   one order. The old round trip across two orders (an `attack` reclaiming a `line`'s bots through the lease stack,
   then giving them back) still works and is unchanged.
4. **The author prompt** (`squad/agent/prompts/squad-author.md` and the Claude Code copy) tells the agent to write
   formations and fights with these helpers, one loop per bot with `squad.crew`, and subroutines with lending. The
   example `squad/tests/fixtures/commands/charge.mjs` (a line written with `lineUp` + `approach` + `squad.crew`, whose
   melee charge with the stock `attack` as a subroutine on `squad.roles.melee`, then re-form) passes `check_script`
   (the typecheck included) and runs in `squad/tests/compose.test.ts`.

## Gates

- `cd squad; npm run check`: lint, tsc, depcruise, 354 tests, all pass.
- `./gradlew test`: up to date on both versions (no Java file changed: the A2 audit of the mod found nothing to fix);
  its last run, 1143 tests per version, 0 failures, 22 skipped (the E2E tests that need `OPENCODE_BIN`/`CLAUDE_BIN`).
- The job-pool timing tests did not fail this time. The baseline run before any change had one load-timing failure
  (`gather.test.ts`: a 401 ms timer gap against a 400 ms bound).

## Still to check in game (Paul)

- B on uneven ground: a slot a block up (the walk jumps onto it), a slot on a slab, ice (the inertia is 0.546's,
  not ice's).
- B with the pathfinder's sprint into the direct walk on a busy server (late ticks in bursts).
- Mounted guards and horse archers in `line` with real horses of mixed speeds; the server's « moved wrongly » on uneven
  ground during the direct walk.
- `attack` and `raid` after the rewrite (same behaviour expected; their unit tests pass): a real charge of horsemen.
- `ctx.run` lending with a real player's command (the `charge` example as a bound command).
- A rider's blow back in `line` (the reach from the saddle, A8), and `pvp` from the saddle.
- The live tests (`squad/live-tests/items.ts`, `range.ts`) still name the four commands `line` and `attack` replaced
  (docs/40 §5): not ported, not run.
