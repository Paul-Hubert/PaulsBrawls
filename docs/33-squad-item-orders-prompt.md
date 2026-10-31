# Prompt: orders bound to items (shield wall, sword, archer line, volley)

> Paste everything below the line into a new Claude Code session at the repo root (branch `rework`). It designs,
> builds and live-tests item-bound orders for Squad. Paul asked for it on 2026-10-31, after the `defend` fixes, the
> ladder fix and `/bots raid` (commits `031256d`, `b54dc35`, `721c6f1`).

---

You are adding **orders bound to items** to Squad, the player-owned Mineflayer bot system: `squad/` is one Node
process, and the mod is a thin front in `src/main/java/com/paul/brawl/squad/`.

**The idea, in Paul's words:**
- Holding an item, `/bots orders bind <ordername>` makes that item an order giver.
- Using the item then starts (or re-aims) that order. The script gets the player's position and view at the moment
  of the click, plus what the click hit.
- Paul's first set of orders:
  - **Shield:** forms a shield wall. The guards stand in a line perpendicular to the player's view, facing the view
    direction, with their shields up.
  - **Sword:** starts attacking what the player looks at. If the player looks at the ground, the bots defend that
    spot.
  - **Arrow (right-clicked):** forms a wall of archers perpendicular to the view.
  - **Firing an arrow from the bound bow:** the archers aim at what the player aimed at: an entity, a player, or the
    ground (a volley on that spot).

## Read first

1. **The Squad system as built:**
   - [docs/system/squad/overview.md](system/squad/overview.md). Read all of it, in particular "`defend` and the damage
     rules", the `raid` section, and the friends rule.
   - [docs/29-squad-design.md](29-squad-design.md):
     - §1, the owner decisions O1–O7. Never relitigate them; say plainly if anything would bend one.
     - §5, the script API, `ctx.commander.at`.
     - §7.1, the commander snapshot.
     - §9, the `/bots` grammar.
     - §16, the lessons, including the ladders and the two armies.
   - `squad/README.md`.
   - The Squad section of `CLAUDE.md`.
2. **The code you'll extend:**
   - `squad/reference/squad.d.ts`: the API that scripts and the authoring agent see. Keep it in lockstep with the
     runtime.
   - `squad/src/stock/defend.mjs` and `squad/src/stock/raid.mjs`: the models for roles, commander-relative targets,
     per-target caps, slots, the leash and archers spreading their fire.
   - `squad/src/api/helpers.ts`: `follow` with `offset`, `goTo`, `attack` with `leash`/`until`, `shoot`,
     `nearestEntity`/`nearestHostile` with `from`.
   - `squad/src/bots/follow-goal.ts`: `GoalFollowOffset` and `slotStandable`.
   - `squad/src/bots/plugins.ts`: one hawkEye copy per bot.
   - `squad/src/orders/*`: Order, runner, friends, claims.
   - `squad/src/service.ts` and `squad/src/http/server.ts`: `/api/orders/start` and `/stop`.
   - Java:
     - `SquadCommand.java` (the `/bots` tree, `order`, `call`, `base`);
     - `CommanderSnap.java` (position, yaw, pitch, held item, lookBlock and lookEntity by raycast within 64 blocks);
     - `Squad.java` (the roster cache, `expectArrival`, the friendly-fire hook);
     - `SquadKits.java`, `SquadArgs.java`;
     - `SquadRaid.java` (an example of the mod starting an order by itself).

## What exists that you build on

- **`/bots order NAME [args] [@bot …] [--reclaim|--free]`** starts an order with a `CommanderSnap` taken on the main
  thread. It becomes `ctx.commander.at` in the script.
- **Roles** select bots by item (`hasItem: 'bow'`) or tag (the kits set `archer`/`guard`). `take: 'reclaim'` takes
  bots away from other orders; they return afterwards (O4).
- **Friends and friendly fire:**
  - Bots that share an owner never damage each other or their owners. The mod enforces this server-side in
    `SquadFriends`.
  - An order's friends are its team.
- **Kits** (`/bots equip BOT guard`) give guards an iron sword and a shield. The shield's slot (off-hand or
  inventory) is whatever `SquadKits` does today; check it.

## Design: decide these first, and write the decisions down (docs/29 §9 and a new subsection of §5)

Recommendations are given; decide from the code and say why.

1. **Where a binding lives.**
   - **Recommended:** on the item stack itself, as a `minecraft:custom_data` component (`{squad:{order, args}}`), with
     a lore line and a glint so the player can see it. The binding then travels with the item, and two shields can
     carry two different orders.
   - **The alternative:** per player and item type, stored in the runtime. Weigh it, then pick one.
   - **The commands:**
     - `/bots orders bind <order> [args…]` binds the held item; `/bots orders unbind` removes the binding;
       `/bots orders bound` lists bindings.
     - Today bare `/bots orders` lists the running orders. Keep it.
   - **Who may use it:** only commands the player can order, the same check as `/bots order`. A bound item given to
     another player orders *their* bots, not the binder's; decide whether that's wanted.
2. **The triggers, and what reaches the server.**
   - **Right-click:** `UseItemCallback` (Fabric). Using a shield starts blocking, so right-click is a natural "use"
     for it.
   - **Left-click on air:** only reaches the server as an arm-swing packet. You'd need a mixin on the swing handler;
     check what Fabric offers first.
   - **Left-click on an entity or block:** `AttackEntityCallback` / `AttackBlockCallback`.
   - **Releasing a bound bow:**
     - track the arrow entity it spawns;
     - on the arrow's hit (entity or block), send a trigger with the hit point and the hit entity;
     - also send the aim at release, so the archers can start drawing before the arrow lands.
   - **Pick per item.** Shield: use. Sword: use, or swing; decide. Arrow: use. Bow: the released arrow.
   - **Rate-limit triggers per player,** for example 4 per second.
   - **Never cancel vanilla behaviour unless needed:** a shield should still block for the player.
3. **What the script receives.**
   - Extend `ctx.commander.at` with
     `trigger: { kind: 'use' | 'swing' | 'arrow-release' | 'arrow-hit', item, hit?: { position, entity? } }`.
   - The snapshot is taken at the click on the main thread: position, yaw, pitch, lookBlock and lookEntity.
   - Document it in `squad.d.ts` and in the authoring agent's prompts (both copies:
     `squad/agent/prompts/squad-author.md` and `squad/agent/claude-code/.claude/agents/squad-author.md`).
4. **What a second click does.**
   - **Recommended:** a binding has one running order per player.
     - A new trigger while that order runs is delivered to it as an event, for example
       `ctx.commander.on('trigger', (at) => …)` or `ctx.commander.next()`, so a shield wall re-forms where the player
       now looks in milliseconds, without stopping and reclaiming bots.
     - If the order isn't running, the trigger starts it.
   - Add the runtime route, for example `POST /api/orders/trigger` (by, binding id or order name, snap). Add a stop
     gesture too, for example sneak + use.
   - Keep orders crash-only and journaled: a trigger is a small journal row, never the hot stream (R44).
5. **New helpers, if the scripts need them** (check what exists first):
   - **Formation slots:** `lineSlots(center, yaw, count, spacing)`, giving positions on a line perpendicular to the
     yaw, plus a depth for a second rank.
   - **The shield:** `raiseShield(bot, on)`, which equips it to the off-hand and holds use (`activateItem(true)`).
     Check how mineflayer exposes off-hand use. Note that blocking slows walking; raise it after arriving.
   - **Facing:** `faceYaw(bot, yaw)`.
   - **`shoot` at a position as well as an entity:** a volley on the ground.
     - Check whether minecrafthawkeye can aim at a fixed point.
     - Otherwise compute the bow's ballistic angle yourself. Arrow speed is 3 blocks per tick at full draw, gravity
       0.05, drag 0.99.
     - Spread the volley around the point.

## The first stock commands (French summaries; each must pass `check_script` with no warnings)

- **`mur-de-boucliers`** (shield): guards line up at the point looked at, or a few blocks in front of the player when
  the point is too far or not standable.
  - The line is perpendicular to the view, the guards face along the view, and their shields go up once in place.
  - A second click re-forms the line.
  - Guards hit back at hostiles or enemies that reach the line, leashed to their slot, and return to it.
- **`epee`** (sword):
  - Looking at an entity or player that isn't a friend: everyone attacks it, archers shooting and guards with at most
    2 per target.
  - Looking at the ground: the bots hold that spot, like `defend` but anchored on a position instead of the commander.
- **`ligne-archers`** (arrow, use): archers form a line perpendicular to the view, a few blocks behind the point, and
  shoot threats within range.
- **`tir`** (fired from the bound bow): archers shoot at the arrow's target.
  - **An entity:** they shoot at it until it dies or a few seconds pass.
  - **The ground:** a volley of N arrows spread around the point.
  - **Afterwards:** they keep their formation.

**Paul's example:** shield forward → a shield wall perpendicular to the view, shields up.

## Verify

- **Tests:** `cd squad && npm run check` and `./gradlew test` (`JAVA_HOME='C:\Program Files\Java\jdk-21'`) both green.
  - Node tests on the FakeBot for the slots, the trigger delivery to a running order, and each stock command's
    choices.
  - JUnit for the Minecraft-free parts: the binding component, the trigger rate limit, the parsing.
- **The live test:**
  - Run `npm run live-test` on the **dev server only**: `./gradlew runServer` in `run/`, ports from
    `run/server.properties`.
  - The dev server and production both use RCON port 25575. If production is up, set the dev `rcon.port` to 25576 for
    your session, then restore it with `git checkout -- run/server.properties`.
  - Create `run/squad.properties` with `enabled=false` so the dev mod doesn't talk to a production runtime on :8772.
    Delete it afterwards.
  - Add a scenario per stock command where it can be checked over RCON, for example "the guards stand on a line
    perpendicular to yaw 90 with their shields raised".
- **Never `./gradlew build`.** Its finalizers copy jars into Paul's real mods folders. Use `remapJar` when a jar is
  needed.
- **Never start, stop or load-test the production server** (`C:\Users\Paul\Desktop\PaulsBrawlsVanilla`, :25565), or
  the runtime on :8772, unless Paul asks in this session.

## Constraints

- **O1–O7:** O2 scripts get the real bot, O4 per-role reclaim and return, O5 PvP on.
- **Keep the lessons:**
  - the login stagger (I1);
  - `viewDistance: 'short'` (R8);
  - the bounded pathfinder and `tickTimeout` 10 (R6);
  - the abort sequence (R4/R5);
  - the protocol hardening;
  - the A\* budget;
  - the patches and their tests (`squad/patches/`, `tests/patches.test.ts`, `tests/ladders.test.ts`).
- **Code style:**
  - TypeScript strict with `verbatimModuleSyntax`;
  - `console.*` only in `src/logger.ts`;
  - comments explain why;
  - player-facing strings in French, errors for the model in English;
  - LF line endings.
- **S8:** behaviour and docs change together:
  - `docs/system/squad/overview.md`, then `node docs/system/build-index.mjs`. It fails while `.claude/worktrees/`
    holds repo copies; skip that directory or move the copies aside;
  - `docs/29` §5, §9 and §16;
  - `squad/README.md`;
  - `CLAUDE.md`'s Squad section.
- **Sub-agents:** use one per workstream with explicit file ownership: mod triggers, runtime trigger route plus API,
  stock commands plus helpers, live tests. After each agent, run the checks yourself and read the diff before starting
  the next.
- **Commits:** one per workstream, in the repo's style, pushed to `rework`.

When you're done, give Paul:
- the in-game usage, from binding to clicking to stopping;
- what each item does;
- what was verified live;
- what is still open.
