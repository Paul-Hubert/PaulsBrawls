# Prompt: audit Squad for its recurring bugs, walk straight onto a line slot, and get ready for richer orders

You work in `C:\Users\Paul\Desktop\pauls-brawls` (branch `rework`, much of it uncommitted: never revert or reset what
you did not write). Squad is the player-owned Mineflayer bots: a Node runtime in `squad/` (one process, `:8772`
production, `:8783` dev) and a thin front in the Fabric mod, `src/main/java/com/paul/brawl/squad/`. Player-facing
strings are French; code, comments and docs English. Three jobs, in this order: **A** an audit for the bug classes that
keep coming back, **B** a direct walk onto a line's exact slot, **C** groundwork so that more advanced orders are short
and safe to write. Do A first: B and C touch the same code, and A's checks are what keep them from adding bugs.

## Read first

- `CLAUDE.md` (Squad bullet, Squad commands), `squad/README.md`.
- `docs/system/squad/overview.md` (as built), `docs/29-squad-design.md` §16 (every live finding so far).
- `docs/34-squad-archer-guard-fixes-prompt.md` « Lessons already paid for », `docs/35-squad-field-fixes-prompt.md` (F1–F7).
- `docs/40-squad-selection.md` (squads, the selector, `line` and `attack`), `docs/41-squad-horses.md` (riding, and
  the three bugs found live on 2026-11-04).
- Code: `squad/src/stock/*.mjs`, `squad/src/api/helpers.ts`, `squad/src/api/squad.ts`, `squad/src/api/scope.ts`,
  `squad/src/orders/{runner,order,guard}.ts`, `squad/src/bots/{pool,mount,hits,hardening}.ts`,
  `squad/reference/squad.d.ts`, `squad/agent/prompts/squad-author.md`; the mod's `Squad.java`, `SquadTriggers.java`,
  `SquadSpawn.java`, `SquadRaid.java`, `SquadGeneral.java`.

## How to work

- Every fix starts with a test that fails on the current code (`squad/tests/`, node:test on FakeBot; JUnit for
  Minecraft-free Java helpers). Run the test against the unfixed code and say so. Gates: `cd squad; npm run check` and
  `./gradlew test`. The job-pool timing tests (`jobs.test.ts`, `pathworkers.test.ts`) fail under load; rerun them
  alone before calling anything a regression.
- **FakeBot is not mineflayer.** Three of the last four field bugs passed every unit test because the fake did what the
  real library does not (it fired `physicsTick` while mounted; it had no player list at join). Anything that depends on
  a library or server event order gets a live check on the dev server: `./gradlew runDevServer` (26.1.2, port 25602,
  RCON 25579, password in `dev-26.1.2/server.properties`), and a probe like `squad/live-tests/probe-horse.ts` (the
  runtime's real pool via `start()`, RCON for ground truth). Never test on production (`run-26.1.2/`, 25565).
- Behaviour and docs change together: the `docs/system/squad/overview.md` section, `squad/README.md`, `squad.d.ts`
  and the author prompt when the script API changes, and a new `docs/43-…` as-built note for what you did.
- A stock command may have at most 400 lines (`check.test.ts`); don't meet it by deleting comments, meet it by C.
- Don't commit. End with a findings table and what is still unverified live.

## A — Audit: the bug classes that recur

For each class: search the whole of `squad/src` (and the mod where named), list every candidate site with
`file:line`, decide bug / not a bug with a one-line reason, and fix the bugs (test first). Report all candidates,
including the ones you cleared.

1. **Loops that await no timer.** `attack()` returns at once when it breaks off (leash, `until`); `epee` slept after
   it, the merged `attack` did not, and a far melee bot spun the event loop until the 3 s starvation canary (30 bots,
   loop p99 3039 ms; `raid` had the same `engage`/`continue` trap). Every `while` in a stock command, helper or the
   General: can one pass complete without awaiting a timer or an event? Consider adding the guarantee once, where
   loops are made (see C), instead of per command.
2. **Server and library event order.** Fabric's `JOIN` fires before the player is in the player list (the login payout
   once; the arrival kits on 2026-11-04: half of each squad had no kit and no horse). `MinecraftServer.execute` on the
   server thread outside a task runs inline, not next tick. mineflayer stops physics on `mount` (now patched).
   Audit every `srv.execute`, every lookup by name or UUID in a join/arrival path, and every place that assumes "next
   tick".
3. **Libraries that silently do nothing.** hawkEye fired nothing without a trajectory; `usingHeldItem` is cleared by
   any entity's status; pathfinder `stop()` leaves latent flags; a packet mineflayer cannot decode left bots deaf. For
   each mineflayer/plugin call the stock commands rely on, is there a path where it neither acts nor errors?
4. **A bot that leaves and comes back.** Dead bots kept looping (F1); a returning bot gets the same guarded object, so
   loops need tokens; listeners are removed on leave (re-add on `joined`); per-bot maps must not leak a stale entry
   (slots, `taken`, `heading`, `struck`, `aside`); handlers keyed by name instead of instance (Eden's R66 storm).
5. **Read-after-write and arrival races.** Block changes seen a tick late (Eden R55); a squad tag read from a cached
   state the runtime has not refreshed; spawn/despawn/respawn of the same name; the selection pointing at a squad
   whose bots are gone.
6. **Ports and merges that drop a line.** `line` merged `mur-de-boucliers` + `ligne-archers`, `attack` merged `epee` +
   `tir` (docs/40). Diff each against the originals (`git show HEAD:squad/src/stock/epee.mjs`, `tir.mjs`,
   `mur-de-boucliers.mjs`, `ligne-archers.mjs`) and account for every behaviour that did not come across.
7. **Copies that diverge.** The stock commands duplicate `ground`, `pointOf`, `pointAt`, `track`, `isFoe`, the
   `taken` maps, `sidestep`, the slot `heading` machinery, `crew`/`launch`. A fix made in one copy is missing in the
   others: list the copies and the differences between them (C removes them).
8. **Mounted bots.** Every helper and command with a mounted body (`squad/src/bots/mount.ts`): no sneak packet ever
   reaches the server (it dismounts), eye height includes the seat, 1.4-wide horses in spacings and slots, a horse that
   dies mid-order, `pvp`'s reach from the saddle.
9. **Squad scoping (docs/40).** Every path that picks bots: start, take-back, `squad.acquire`, `ctx.run`, the
   General, raids. Can an order scoped to `esc-N` get or reclaim a bot outside it? Does a stop reach only its squad?

## B — Walk straight onto a line slot

Today (`squad/src/stock/line.mjs`, `stepTo` in `squad/src/api/helpers.ts`): a bot walks to its slot's **block**
(`GoalBlock`; a path ends on a block's centre), then `stepTo` **sneaks** the last 0–0.7 block to the exact place,
steering on every physics tick, letting go within 0.08 (`STEP_STOP`), 3 s at most. Paul: the bots finish by crouch
walking to their slot. It looks wrong and is slow.

Required:
- From far away, normal pathfinding is fine, but only until the bot is about **2 blocks** from its exact place
  (`GoalNear` on the exact coordinates, not the block's centre).
- From there it walks **directly** to the exact x/z at walking speed, **never sneaking**, steering every physics tick,
  and stops on the place: within 0.15 block, at rest, no overshoot and no back-and-forth. Brake from the body's
  velocity (on ground prismarine-physics keeps 0.546 of the horizontal speed per tick, so after letting go a body
  slides about `v · 0.546 / (1 − 0.546)`): let go of `forward` when the remaining distance reaches that, and correct
  with a short tap if it stopped short.
- The same for a mounted bot (its body walks; `mount.ts` sends it as the horse's move; the horse's speed applies).
- Unchanged: a new formation, a foe to shoot or a hit to answer ends the approach at once; a bot pushed off its slot
  walks back; a slot it cannot reach in time is held loosely (`STUCK_MS`, `LOOSE`); the guards' shield goes down to
  walk and up on arrival; slots keep their exact places (no block centres: docs/35 F2, F4).
- Make it one helper used by every formation (replace `stepTo`'s sneak or add a new helper; keep the API documented
  in `squad.d.ts`), update the line tests (they check the step's controls), and measure it live on the dev server:
  ten guards and ten archers at yaws 0, 45 and 87, on foot and mounted; report each bot's final offset and the time
  from the click to the last bot settled, before and after.

## C — Ready for more advanced orders

Paul will ask for richer orders: formations that move, flanking, a line that charges then re-forms, orders that
combine several squads' roles. Today a new command means copying 300 lines of `line.mjs` or `attack.mjs` and their
traps. Build the groundwork, not the new orders:

1. **Shared formation and fight helpers** in `squad/src/api/` (scope globals, typed in `squad.d.ts`, tested): slot
   assignment by position (ranks, left to right, exact places on the ground), the approach of B, a per-bot crew
   launcher (tokens, relaunch on `joined`, listeners re-added, a guaranteed pause per pass: A1), leash-safe melee (ride
   or walk closer first, never a fight that breaks off before its first swing), target picking with `taken` loads
   and the blocked-target memory, `pointOf`/`ground` over whichever bot knows the chunk. Then rewrite `line`,
   `attack` and `raid` on them, with no behaviour change other than B, each well under 400 lines.
2. **`ctx.run` that composes.** A subroutine's view (`Squad` constructor with `view`, `squad/src/api/squad.ts`)
   copies its bots once, does not refresh its roles when a bot joins, fires `joined` for bots outside its subset, and
   throws when a role's `min` is not met. Make a subroutine run on a live subset of the parent's roles (e.g. a
   `charge` that runs `attack` on `roles.melee` while `line` keeps `roles.archers`), with tests.
3. **The script API for orders that span time and squads**: what an order needs to know about its squad (its tag,
   members), and a clean way for one order to hand bots to the next (the line → attack → line round trip is today
   carried by reclaim and the lease stack; document it as the supported pattern or improve it).
4. Update `squad/agent/prompts/squad-author.md` (and the Claude Code agent copy) so the author agent writes new
   commands with these helpers, and add one non-stock example command as a test fixture that uses them (for example a
   line that charges a target with its melee, then re-forms), to prove the helpers are enough.

## Done when

- A's table: every candidate site, verdict, fix and test; B measured live, before and after; C's helpers in use by
  the three stock commands, `ctx.run` composing, the author prompt updated, the example fixture passing.
- `npm run check` and `./gradlew test` green (the timing tests rerun alone if they fail under load).
- `docs/43-…` written as built, `overview.md`, `README.md` and `squad.d.ts` in step, and a list of what still needs an
  in-game check by Paul.
