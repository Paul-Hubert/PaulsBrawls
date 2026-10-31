# Prompt: fixing the archer and guard commands

> Paste everything below the line into a new Claude Code session at the repo root (branch `rework`). It loads the
> context needed to fix how archers and guards behave in Squad's commands. Paul then describes, one message at a
> time, what goes wrong in game. Written 2026-10-31, after docs/33 (orders bound to items) landed (`7e042e8` …
> `48027a6`).

---

You will fix how **archers and guards** behave in Squad, the player-owned Mineflayer bot system. Paul will describe in
his next messages what goes wrong in game ("the guards don't …", "archers shoot …"). This message is the context. Read
what it points to, then wait for his first report.

## The system in one paragraph

- **Mineflayer bots in one Node process.** `squad/` (`npm start`, `:8772`) runs the bots and their orders. An order
  is one JS file controlling all its bots: a stock command in `squad/src/stock/`, or one written by the
  `squad-author` agent.
- **The mod is a thin front.** It lives in `src/main/java/com/paul/brawl/squad/` and provides:
  - the `/bots` commands;
  - the commander snapshot;
  - the triggers of items bound to orders;
  - friendly fire: bots sharing an owner never hurt each other or their owners;
  - kits, and `/bots squad spawn|despawn`.
- **Archers** are bots holding a bow (the `archer` kit: bow, 64 arrows, stone sword, chainmail). **Guards** are bots
  without one (the `guard` kit: iron sword, shield in the off-hand, iron armor). Roles select them with
  `hasItem: 'bow'` / `not: { hasItem: 'bow' }` or `hasItem: 'shield'`.

## Read first

1. `docs/system/squad/overview.md`, the as-built reference. In particular:
   - "`defend` and the damage rules";
   - the `raid` section;
   - "Orders bound to items" (runtime and mod);
   - the four item commands;
   - "Bound items on the dev server (live)";
   - "Not verified yet".
2. `docs/29-squad-design.md`:
   - §1, the owner decisions O1–O7. Never relitigate them.
   - §5.2, the script API.
   - §5.4, bound items. Any item carries any order; a click only says where the player points.
   - §16, the lessons, especially the 20-bot fight, the ladders, the live findings on bound items, and the any-item
     targeting.
3. `squad/README.md` (every `/bots` command, the live-test how-to) and the Squad section of `CLAUDE.md`.

## The code you will touch

| What | Where |
|---|---|
| The archer/guard commands | `squad/src/stock/defend.mjs`, `raid.mjs`, `mur-de-boucliers.mjs` (shield wall), `epee.mjs` (sword), `ligne-archers.mjs` (archer line), `tir.mjs` (volley/target) |
| Helpers they use | `squad/src/api/helpers.ts`: `follow` (slots via `offset`), `goTo`, `attack` (`leash`, `until`), `shoot` (entity or position: hawkEye, then `bowAim`/`aimOvershoot`, `POINT_REACH`), `nearestEntity`/`nearestHostile`/`isHostile`, `lookDir`, `lineSlots`, `groundAt`, `faceYaw`, `raiseShield`, `entityOf`, `pointedTarget` |
| Slots, ladders | `squad/src/bots/follow-goal.ts` (`GoalFollowOffset`, `slotStandable`) |
| Plugins | `squad/src/bots/plugins.ts` (one hawkEye copy per bot), `hardening.ts` (bounded pathfinder, the R4/R5 abort sequence) |
| Orders, triggers, reclaim | `squad/src/orders/order.ts`, `runner.ts` (triggers delivered to a listening order, otherwise it restarts), `squad/src/api/squad.ts` (`parallel` over a live role array re-runs a bot given back), `squad/src/leases.ts` |
| The API scripts see | `squad/reference/squad.d.ts`. Keep it in lockstep with the runtime: `check_script` typechecks against it |
| Mod | `SquadKits.java` (kits), `SquadTriggers.java` + `SquadBinding.java` (bound items), `CommanderSnap.java` (look raycast, `canHit()`), `SquadFriends.java` (friendly fire), `SquadSpawn.java` (`/bots squad`), `SquadCommand.java` |

## Lessons already paid for (don't undo them)

- **hawkEye:**
  - It keeps module state, so each bot loads its own copy.
  - It silently fires nothing when it finds no trajectory.
  - For a point on the ground 6–10 blocks away, it accepts arcs that land 2–3 times too far. That is why
    `POINT_REACH` and `bowAim` exist.
- **`shoot` returns when the arrow count drops.** After an aim, wait for the look packet (`LOOK_SETTLE_MS`).
- **`raiseShield` keeps its own record.** Mineflayer's `usingHeldItem` is cleared by any entity's status packet.
  Shields go down to walk and to fight; the abort sequence also lowers them.
- **Slot timers:** a slot's "stuck" timer restarts once the bot has reached it.
- **Guards:** at most 2 on one target, an untaken target first.
- **Archers** prefer a target no other archer shoots, and step aside after "no clear line of fire".
- **Threats are relative to the commander,** or to the point, or to the leader, and fights are leashed to it.
- **Friends** are the order's team only (`isFriend`, `ctx.friends`). Another owner's bots are enemies.
- **`entityOf` finds an entity by its id only.** A missing id means it is dead or out of sight.
- **Bound items:** a delivered trigger replaces `ctx.commander.at`. Item orders take bots with `take: 'reclaim'`, and
  the bots return to their previous order afterwards (O4).

## Servers: production vs dev (since 2026-10-31)

- **Production** is `run/`: `./gradlew runServer`, port 25565, Paul's world. Its bot runtime is `cd squad; npm start`
  (`squad/squad.json` on 25565, `run/squad.properties` with the token).
  - Paul runs it and reports from it.
  - **Never start, stop, connect to or load-test it, or the runtime on :8772, unless Paul asks in this session.**
- **Dev** is `dev/`: `./gradlew runDevServer`, port 25599, RCON 25576, its own scratch world. It has its own
  settlement port (8777) and God MCP port (8781), so it runs beside production. Squad is off in
  `dev/squad.properties`.
- **The live tests** (`squad/live-tests/run.ts` + `items.ts`) default to `dev/`, and only `dev/`'s world may be
  changed. Item scenarios: `LIVE_ONLY=items`.
  - The scenarios through the mod need `dev/squad.properties` set to `enabled=true`, `url=http\://127.0.0.1\:8779`,
    `token=live-test-token`, and `LIVE_RUNTIME_PORT=8779`.
  - Put `enabled=false` back afterwards.
  - Use `JAVA_HOME='C:\Program Files\Java\jdk-21'`.
  - Stop the dev server with RCON `stop` at the end.
- **Never `./gradlew build`.** Its finalizers copy jars into Paul's real mods folders. Use `remapJar` when a jar is
  needed.

## Not verified on a server yet

These are likely where Paul's reports will land:
- mobs that move (every live husk had `NoAI`);
- real fights at scale (`defend` with 20 bots against waves; `raid` and `/bots raid` never ran on a server);
- shields held up for minutes;
- a crossbow, multishot;
- `ligne-archers` fired from a bow;
- pointing at a friend;
- `/bots squad spawn|despawn` in game.

## How to work each report

1. Restate what Paul saw in one line, and ask only if the command, the bots' kits or the situation are unclear.
2. Find the cause in the code, the order's report (`/bots fix` reads it; the journal is `squad/.squad-data/squad.db`)
   and the runtime log (`squad/squad-runtime.log` when started headless).
3. Reproduce on the dev server when the behaviour needs a world: a scenario in `items.ts`, or RCON plus a captain
   client as in it. Ground truth comes from RCON `Pos`/`Rotation`/`SelectedItem` and entity metadata (index 8: hand
   active / off-hand).
4. Fix the real cause, and add a FakeBot test (`squad/tests/`) that fails without the fix.
5. Check:
   - `cd squad && npm run check` is green (168 tests now).
   - `./gradlew test` is green (1104) if Java changed.
   - Re-run the relevant live scenario on `dev/`.
6. Update the docs with the behaviour (S8): `docs/system/squad/overview.md`, a `docs/29-squad-design.md` §16 entry
   for a real finding, `squad/README.md` if usage changed, `squad.d.ts` and both author prompts if the API changed.
7. Commit in the repo's style, one per fix, and push to `rework`.
8. Tell Paul what was wrong, what changed, and what you verified (fakes, live on `dev/`, or not run).

## Constraints

- **Code style:**
  - TypeScript strict with `verbatimModuleSyntax`;
  - `console.*` only in `src/logger.ts`;
  - comments say why;
  - player-facing strings in French, errors for the model in English;
  - LF line endings.
- **Keep:**
  - the login stagger, `viewDistance: 'short'`, the bounded pathfinder;
  - the A* budget, the patches and their tests (`squad/patches/`, `tests/patches.test.ts`, `tests/ladders.test.ts`);
  - the protocol hardening.
- **Keep O1–O7:** the real bot (O2), per-role reclaim and return (O4), PvP on (O5).

Now read the files above, then wait for Paul's first report.
