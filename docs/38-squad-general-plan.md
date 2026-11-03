# 38 — The General: a Claude Code instance commanding an army of squads

Status: **built (G1–G3), not yet live-tested** (2026-11-03). The runtime is `squad/src/general/` + `squad/src/http/
general-mcp.ts` (`tests/general.test.ts`), the mod `SquadGeneral` + `SquadGeneralPlan` (`SquadGeneralPlanTest`), the
instance `squad/agent/general/`. §10 lists where the build differs from the plan below. Plan of 2026-11-02. Owner's brief (Paul): no body; an admin's ticket with a spawn point
prepares a Claude Code instance; the admin tells it what it may spawn, in squads; it fights other players' bots. The
admin's facing at the spawn is the default direction of attack while no enemy is visible, and the admin's prompt
defines the goal and/or the strategy.

## 1. The shape

```
admin in game                         admin in a terminal
/bots general create Rouge ...  ──▶   claude (in squad/agent/general/, ticket in env)
        │ mints gen-… ticket                │  "you have 10 archers, 10 guards; hold the hill, then raid Paul"
        ▼                                   ▼
the mod (spawns, kits, places) ◀─SSE── Squad runtime :8772  ◀── /mcp/general (tools below)
                                         orders, leases, perception digest, events
```

- **No body.** The General is a virtual owner, like `Envahisseur` of `/bots raid` (docs/system/squad/overview.md,
  "`raid` and `/bots raid`"). Its bots are owned by it, so every other player and their bots are enemies through
  the existing friend rules (`SquadFriends`, `OrderRunner.refreshFriends`). Nothing new for friendly fire.
- **Claude is the general, not the soldiers.** A turn takes 5–30 s, and a bot ticks at 20 Hz. Every act is a lasting
  order that the runtime carries out (the stock orders' reflexes); Claude wakes only on decisions (§5).
- **The allowance is enforced by the server, not by the prompt.** The admin can tell Claude whatever they like, but
  `spawn_squad` refuses anything past the ticket's allowance (§3).
- **The admin's prompt is the mission.** What the admin types in the terminal sets the goal and/or the strategy (§1.1).
  The ticket bounds what the General may field; the prompt says what to do with it.
- **The spawn facing is the axis of attack.** With no enemy in sight, the General advances along the direction the
  admin faced at `/bots general create` (§1.1).

### 1.1 Mission and the default axis

- **Mission (from the admin's prompt).** The doctrine (`CLAUDE.md`) tells the General to read its first message as:
  - a **goal**: what winning means ("take the hill at 300 70 -200", "kill Paul's bots", "hold the bridge until
    dusk");
  - and/or a **strategy**: how to fight ("archers behind a shield wall, never split", "harass and fall back",
    "keep half in reserve").

  When only one is given, it chooses the other itself and says so in one line. A later message replaces either part,
  in the terminal or through `/bots general tell`. The General restates the current mission (goal, strategy, axis) in
  one line at the start and on every change, so the admin can correct it.
- **The default goal** (the prompt gives none): seek and destroy enemy bots along the axis.
- **The axis.** The admin's horizontal facing at `create`, rounded to one of 16 directions, is stored on the ticket
  with the spawn point. The General may change it when the mission names another direction or place, but never
  silently: it says so in its restatement.
- **When no enemy is visible** (no cluster seen for 15 s, or none ever):
  - **advance along the axis** (the `advance` tool): each advancing squad runs a `raid` leg to the point 48 blocks
    past the army's front on the axis, side by side in lanes 12 blocks apart, archer squads 6 blocks back;
  - **a leg that ends with no contact** starts the next one (the runtime chains them, no turn of Claude's), once the
    squad is no more than 16 blocks ahead of the slowest advancing squad. The advance is the loop's default move, so
    an army told only "attack" still finds the enemy. With no enemy, no order and no advance for 20 s, an `idle` event
    reminds the General of it;
  - **contact interrupts it:** the first `contact` wakes the General, which fights as the mission says;
  - **after the enemy is lost** (`contact-lost` and nothing else seen), it goes back to the advance from where it
    stands.
- **Limits of the advance:** `maxAdvance` (default 256 blocks from the spawn point, set on the ticket,
  `/bots general create … range=N`). At the limit, the army holds and wakes the General once (`event: axis-end`).

## 2. The admin's side (mod, `com.paul.brawl.squad`, perm 2)

| Command | What |
|---|---|
| `/bots general create NAME [kit=max …] [reinforce=N] [range=N]` | Mints a `gen-…` ticket for the virtual owner `NAME` (offline UUID, like `Envahisseur`). The **spawn point** is the caller's position at the call, and their horizontal facing is the **axis of attack** (§1.1). The allowance comes from the arguments, e.g. `archer=10 guard=10 reinforce=6`. The ticket and the launch line are shown only to the caller, as `/construction ticket` does. |
| `/bots general allow NAME kit=max …` | Changes the allowance while the General runs (it is told through `wait_events`, kind `allowance`). |
| `/bots general tell NAME text` | A line to the General from in game (event kind `admin`). Optional: the terminal is the main channel. |
| `/bots general stop NAME [despawn]` | Revokes the ticket and stops the General's orders. With `despawn`, every bot it owns is removed (and its save deleted, `SquadSaves`). |
| `/bots general list` | Generals, their tickets' ages, their bots alive/dead and their allowance use. |

**The prepared instance** is `squad/agent/general/`, the same pattern as `agent/claude-code/` for `squad-author`:
- `CLAUDE.md` holds the doctrine: the vocabulary, the sitrep legend, the rules of engagement, and "every act is an
  order; wait with `wait_events`".
- `.mcp.json` holds only `general` (`http://127.0.0.1:8772/mcp/general`, with the ticket from env in a header).
- The settings allow only `mcp__general__*`, with no Bash and no file edits, and set `MCP_TOOL_TIMEOUT` above the
  longest wait (§5).
- The mod prints the launch line: `cd squad/agent/general; $env:SQUAD_GENERAL_TICKET='gen-…'; claude`.

**The allowance, decided:** a per-kit cap on **bots fielded, alive or dead** (`archer=10`; a disbanded squad frees
its slots) plus a pool of **reinforcements** (`reinforce=6`). (Counting only the living would let the General spawn
fresh bots for every one that dies, and reinforcements would mean nothing.) Respawning a dead bot spends one reinforcement. With no `reinforce`, the dead stay dead. Every
spawn and respawn happens **at the spawn point**, never where Claude chooses (no spawning behind the enemy).

## 3. The tools (`/mcp/general`, runtime `squad/src/general/`, English text for the agent)

The ticket is the instance's only credential: the `X-Squad-General` header (from `SQUAD_GENERAL_TICKET`, in
`.mcp.json`), no bearer token and no ticket argument. A refusal is `isError: true` with a reason the agent can act on (as in `http/mcp.ts`).

| Tool | Kind | What |
|---|---|---|
| `get_briefing()` | read | Called once. It returns the allowance and its use, the spawn point, the axis and `maxAdvance`, the orders it may give (stock commands as one line each: name, roles, params with ranges, what a click does), the sitrep legend and the origin of its coordinates (the spawn point). |
| `sitrep()` | read | The whole battle in ≤ 400 tokens (§4). |
| `squad_detail(squad)` | read | One line per bot: name, kit, hp, position, order, what it is doing (the reports' logs), seen enemies. |
| `map(center?, radius≤64, cell=4)` | read | A coarse relief and obstacle map from the shared world (the columns its bots hold), with its squads and the enemies seen, as letters. |
| `wait_events(cursor, timeoutS≤50, wakeOn?)` | read | Long poll (§5). |
| `spawn_squad(name, kit, n)` | act | Asks the mod to spawn `n` bots of `kit` at the spawn point, owned by the General and named `<NAME><Kit>01…`. It is refused past the allowance or `limits.maxBots`. It answers at once, and the arrival is an event. |
| `reinforce(squad, n)` | act | Respawns up to `n` of the squad's dead at the spawn point, refilled to their kit, and spends reinforcements. |
| `assign(bots, squad)` | act | Moves bots between squads (split, merge). A squad is a name over a set of bots, and an order's `@bot` filters are its members. |
| `order(squad, command, args, at)` | act | Starts an order for the squad's bots only. `at = { pos, facing, target? }` builds the commander snapshot (§6). `pos` may be relative to the spawn point (`E12 N3`) or along the axis (`axis+48`: 48 blocks past the army's front, on the axis line). `facing` defaults to the axis. |
| `set_axis(dir)` | act | Changes the axis (a compass point, degrees, or toward a place). It is reported in the sitrep header. |
| `retarget(squad, at)` | act | Re-aims the squad's running order: a listening one (`epee`, `ligne-archers`, `mur-de-boucliers`) gets the new snapshot (`Order.deliverTrigger`), others restart with the same args. |
| `advance(squads?, distance?)` | act | The default move (§1.1): raid legs along the axis until contact or the range. |
| `set_mission(goal?, strategy?)` | act | Records the mission read from the admin's message; every sitrep shows it. |
| `stop(squad)` | act | Stops the squad's order. The bots stay where they are, idle. |
| `disband(squad)` | act | Despawns the squad (the slots return to the allowance; reinforcements are not refunded). |

`request_command` (handing a new behaviour to `squad-author`) is left for later. The stock orders cover the first
fights; more in §8.

## 4. Getting the information across

The rule: **group by squad, send changes, show only what the army sees.**

```
t=812 cur=4471 origin=spawn(120,64,-340) axis=E front=E14/256  allow: archer 8/10 guard 7/10 reinf 4
mission: take the hill E60 N20 | strategy: archers behind a shield wall, never split
A 8/8 archer8 hp92 ligne-archers @E12 N3 contact X1 18b
B 6/7 guard7 hp61 mur-de-boucliers @E10 N3 contact X1 16b dead1 mobs2
X1 6 @E28 N8 y64 →W 2.0b/s bow3 sword3 iron [Paul,PaulArc01,PaulArc02,+3] seen 0s ago
X2 1 @E40 S12 y70 static bow1 [Alice] seen 25s ago
```

- **Coordinates** are relative to the spawn point (`E12 N3` = 12 east, 3 north), rounded to whole blocks. Absolute
  values are given only in `get_briefing` and `map`.
- **Enemies by cluster:** every army bot's `bot.entities` merged by entity id (the same id on every client),
  single-link clusters within 8 blocks. They keep IDs (X1…; not E1, which reads as "1 block east") across reports while they persist, and show what they
  visibly carry (held item, armour) and their speed and heading. A cluster nobody sees ages (`last seen`), and is
  dropped after 2 min.
- **Fog of war:** only what its bots perceive: positions, held items, chestplates and nametags (up to 3 names per
  cluster, so a target can be named). Not the roster's owners and kit tags of enemy bots, and not player positions
  from the server. The runtime knows them, and showing them would be cheating against the players.
- **One squad, one line.** Per-bot detail only through `squad_detail`. Health is the squad's mean; deaths are
  counted, with when.
- **Agent-facing text is English** (the `squad-author` convention); anything said in game stays French.

## 5. The loop and the events

`wait_events` returns as soon as an event the agent woke on happens, else at `timeoutS` with `{cursor, none}` and a
one-line sitrep. Events are kept in a ring per General, and `cursor` is the last one seen.

| Kind | When |
|---|---|
| `contact` / `contact-lost` | A new enemy cluster seen by any of its bots, or one not seen for 15 s |
| `casualty` | A bot of its army died (squad, who, killed by what if the bot saw it) |
| `hp-band` | A squad's mean health crossed 75 / 50 / 25 % |
| `order-end` | A squad's order ended (its status and its last line) |
| `arrived` | A spawn or reinforcement has arrived and been equipped |
| `axis-end` | The advance reached `maxAdvance` with no contact (§1.1) |
| `allowance` / `admin` | `/bots general allow` / `tell` |
| `kill` | An enemy the army hit died |

- **One incident, one wake (R36).** After the first event a wake waits 2 s for the rest of the burst, then
  returns them together. A burst of 6 deaths is one `casualty ×6`.
- **Nothing hot is journaled (R44).** The digest is in memory: a 1 s sampler over the army bots' `bot.entities` and
  health, the pool's `gone` (deaths) and each army bot's `entityDead` (kills). The General's orders are journaled like
  every order; nothing else is (no per-minute sitrep row yet).
- **The terminal stays the admin's.** Interactive `claude` sits in `wait_events` between moves. The admin presses
  Esc and types, and the General's doctrine says to call `wait_events` again after answering. Hence `timeoutS ≤ 50`:
  a wait never blocks the session long.
- **Cost:** one wake is about one short turn (cached context + a few hundred tokens of events). A quiet army wakes
  once every 50 s.

## 6. What changes in the runtime (`squad/src/`)

1. **Two squads running the same command.** An order's binding is keyed by (commander, command)
   (`OrderRunner.trigger`), so squads A and B both on `ligne-archers` would restart each other. Add an optional
   `squad` to the key on `/api/orders/start|trigger`; the General's orders always carry it. Players' keys are
   unchanged.
2. **The synthetic snapshot.** From `at`, build what `CommanderSnap` gives:
   - `pos` and the yaw of `facing` (a compass point or degrees);
   - `lookEntity` (with its id) when `target` is an entity seen by the army, or else `lookBlock` = the block under
     `target` (`groundAt`);
   - `trigger: use`, so `pointedTarget` works unchanged.

   The snapshot goes through the existing sanitizer (`http/server.ts` `snapshot`).
3. **Orders that need a body.** `defend` and `follow` measure from the commander's entity, and the General has none:
   - `defend` and `follow`: not offered. Use `epee` on a point instead (it defends that point: threats within
     `radius`, guards on a ring of 3, archers on a ring of 6).
   - `epee`'s fallback "defend the commander" (target dead, `seconds` over): it goes to the snapshot's position.
   - `raid` already runs with a virtual commander (`Envahisseur`), and works as is.

   Check each offered stock command with a snapshot and no entity in `tests/` before offering it.
4. **Spawning without a calling player.** The runtime asks the mod over SSE (a new event `general-spawn
   {general, kit, n, names?, revive?}`), and the mod answers through `/api/general/spawned`. In the mod, factor
   `SquadRaid`'s path (names, whitelist, `/api/bots/spawn`, `expectArrival` at a spot, kit and tag) into one
   placement taking a point and a facing (`SquadRaidPlan`'s rows of 5). Raid, squad spawn and the General then share
   it.
5. **Tickets and the allowance** live in the runtime (`general/tickets.ts`, `general/allowance.ts`). The allowance
   is counted from the roster (bots alive per kit tag), never from a counter Claude can drift from. They are
   persisted in `.squad-data/generals.json`, so a General survives a runtime restart.
6. **Limits:** one army of 20 plus one player's 20 needs `limits.maxBots` ≥ 40 (default 30). Orders per General are
   capped at 20/min, so a confused agent cannot thrash.

## 7. Phases

| Phase | What | Done when |
|---|---|---|
| G1 | The mod's `general create/allow/stop/list`; the shared placement; runtime tickets, allowance and squads; `spawn_squad`, `assign`, `order`/`retarget`/`stop` with the `squad` key and the synthetic snapshot; `get_briefing` | From a hand-written MCP client on the dev server: spawn A (archers) and B (guards), `ligne-archers` + `mur-de-boucliers` facing E, both at once, no mutual restart |
| G2 | Perception digest, `sitrep`, `squad_detail`, events, `wait_events` | `tests/` with the fakes: the clusters, the ID stability, the 2 s coalescing, the 400-token sitrep for 30 bots |
| G3 | `squad/agent/general/` (doctrine with the mission and the default advance, `.mcp.json`, settings); `reinforce`, `disband`, `map`, `set_axis`, `axis+N` | Live, on the dev server: told only "attack", a General advances along its axis, finds a `/bots raid 60 6 6` placed 100 blocks ahead, and fights it; told a goal and a strategy, its restated mission and its first orders match them |
| G4 | Live tests and tuning | General vs a player's army; **General vs General** (two tickets, two terminals) as the repeatable bench |

## 8. Later, not now

- **New behaviours** by handing a description to `squad-author` (`request_command`), with the General's bots as the
  trial bots.
- **Headless mode:** the runtime wakes `claude -p --resume` on events instead of a terminal, for a General nobody
  watches.
- **Taunts:** a rate-limited `say`.

## 9. Open (owner)

- **O1:** does the General also fight players without bots, and mobs? As planned it fights any non-friend, as
  `raid` does.
- **O2:** should an enemy's identity (whose bots) stay hidden (fog of war, §4), or is it fair game?
- **O3:** may the admin raise the allowance mid-fight from the terminal (a tool that asks for the human's approval
  every time), or only in game (`/bots general allow`)? As planned, only in game.

## 10. As built (2026-11-03): where it differs from the plan

- **No binding-key change (§6.1).** The General keeps each squad's order by id and re-aims it directly
  (`Order.deliverTrigger`), never through `/api/orders/trigger`, so two squads on one command cannot restart each
  other and the player-facing binding key is untouched. Its orders end silently (`silentEnd`), and the HTTP layer
  drops any notice addressed only to a General's virtual owner (a script's `ctx.say`): it would pile up in the mod's
  offline-player queue.
- **The mod's spawn path is its own (§6.4)**, `SquadGeneral.spawn`, a copy of `SquadRaid`'s steps (names via
  `SquadRaidPlan.names`, whitelist, `/api/bots/spawn` as the virtual owner, `expectArrival`, `equipLater`, the kit
  tag), placed by `SquadGeneralPlan.place` (rows of 5 across the axis). `SquadRaid` is unchanged. The SSE events are
  `general-spawn {request, general, owner, kit, n, prefix, spawn, revive, kits}` and `general-despawn {general, bots}`;
  the mod answers `/api/general/spawned|arrived|failed {request, name}`. With no mod connected, `spawn_squad`,
  `reinforce` and `disband` refuse at once.
- **Tickets, allowance, squads** live in `general/general.ts` and `.squad-data/generals.json` (no separate
  `tickets.ts`/`allowance.ts`). A ticket lasts until `/bots general stop`.
- **Offered orders:** `raid`, `epee`, `tir`, `ligne-archers`, `mur-de-boucliers`. No stock command was changed: with no
  commander entity, `epee`'s "defend the commander" mode holds where the bots stand (`follow` of no entity sleeps).
- **The snapshot** stands 4 blocks behind the point, facing `at.facing` (else toward the target, else the axis); the
  point's y is the ground an army bot knows there (`groundFeet`), else the given y. `raid` gets `x y z` (and
  `target=` for a named enemy) as args.
- **The instance** (`squad/agent/general/`): `CLAUDE.md` (the doctrine), `.mcp.json`, `.claude/settings.json`
  (`mcp__general` only, the other tools denied, `MCP_TOOL_TIMEOUT` 120 s, `claudeMdExcludes` so the repository's
  CLAUDE.md files are not loaded). The first launch asks to trust the folder.
- **Not built yet:** the live G3 check, G4, the per-minute journal row, "killed by what" in `casualty`.
