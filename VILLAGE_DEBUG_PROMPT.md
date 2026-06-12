# Deep-dive request: why my Mineflayer AI villagers can't bootstrap a wheat farm

You are helping me root-cause and properly fix a set of problems in an LLM-driven
Minecraft villager system. I have working mitigations for most of them; what I
want from you is **in-depth analysis**: the real underlying causes, whether my
mitigations are sound or papering over something, and what the durable fixes
look like (including upstream library issues I should know about).

## System overview (what you need to know to reason about this)

- Stack: Node 24, TypeScript via tsx, **mineflayer 4.35.0**, minecraft-data
  3.105.0, prismarine-windows 2.9.0, mineflayer-pathfinder 2.4.2,
  mineflayer-collectblock 1.6.0. Minecraft **1.21.1** dedicated Fabric server on
  localhost (port 25599), bots run with `viewDistance: 'short'`.
- N villager bots (currently 2: a farmer and a gatherer), each driven by a
  three-layer brain: (1) sandboxed self-written JS "reflex" skills reacting to
  events, (2) long-lived routine scripts (farm-loop, gather-loop, …) of which a
  per-role stock set ships with the system, (3) LLM deliberations woken by a
  priority scheduler (player > combat > conversation > error > job > plan >
  heartbeat), with per-bot cooldowns and a global concurrency cap.
- A "day planner" assigns time slots (job:farm-setup, visit:X, home) and a
  zero-LLM slot executor re-asserts the current slot every 2.5 s scan tick —
  restarting the slot's routine if it isn't running.
- Each bot has a `home` and optional `chest` anchor. Anchors self-heal at boot
  (walk near, snap y to standable ground, adopt nearest real chest) and can be
  overridden by the LLM via set_home/set_chest tools.
- Bots interact with the world through an action library (`goTo`, `collect`,
  `craft`, `deposit`, `withdraw`, `dig`, `place`, `till`, …). Every action has a
  45 s timeout; routines run them sequentially. Tool/action results (success
  strings and error strings) are fed back verbatim into the LLM's context and
  often get written into the bot's long-term memory.

## The session that exposed everything

Goal: two bots ("Froment" the farmer, "Glane" the gatherer) cooperatively
bootstrap a wheat farm from nothing: gather seeds by breaking grass, collect
logs, craft planks → crafting table → chest → wooden hoe, till near water,
plant. Over three runs (~30 min of bot time) they produced: 11 spruce logs,
some seeds, **zero crafted items, zero tilled blocks, zero food** ("benchmark:
0 food acquired"). Below are the distinct failure classes, with log evidence.

---

## Problem 1 — `bot.craft` reported success while the server crafted NOTHING

The highest-impact bug. Timeline from the log (bot had just collected exactly
**4 oak logs**, confirmed by `item-received oak_logx3` + `oak_logx1` events):

```
23:32:34.505 tool craft({"item": "oak_planks", "count": 16}) → crafted oak_planks x16
23:32:35.324 tool craft({"item":"crafting_table","count":1}) → ERROR: cannot craft
             crafting_table: no recipe matches current inventory
```

The first craft "succeeded" in ~30 ms (no real server round-trip time), and
0.8 s later `bot.recipesFor(crafting_table, null, 1, null)` found no plank
variant — i.e. `bot.inventory.count(oak_planks)` was < 4. The planks never
existed. My action code called `bot.craft(recipe, 16, undefined)` — 16 recipe
EXECUTIONS, needing 16 logs, with only 4 in inventory.

What I found reading mineflayer 4.35.0's `lib/plugins/craft.js`: `craftOnce`
drives the 2×2 inventory grid purely with `bot.clickWindow` calls and then
**fabricates the result client-side** (`window.updateSlot(0, new Item(...))`
with a comment "Causes a double-emit on 1.12+"), never awaiting server
confirmation of the crafted output. The 'missing ingredient' guard only checks
the client-side window state.

My mitigation (working, but tell me if it's wrong): treat the requested count
as OUTPUT ITEMS, compute executions = ceil(count / recipe.result.count), clamp
executions to what `recipe.delta` × `bot.inventory.count` can afford, then
after `bot.craft` resolve, `bot.waitForTicks(4)` and diff the real inventory;
throw if the delta is ≤ 0, return the actual delta.

Questions I want answered in depth:

1. What is the precise desync mechanism on 1.21.x? Minecraft ≥1.17 uses the
   stateId-based container protocol (no more transaction acks). Does
   mineflayer 4.35 track `stateId` on `container_set_slot`/`container_set_content`
   for the player inventory crafting grid, and what happens server-side when a
   click sequence references a stale stateId — does the server silently resend
   the whole window (which would explain "success then nothing")?
2. Why did the over-count craft not throw 'missing ingredient' at execution 5
   of 16? Walk through craft.js's client-side bookkeeping (clickWindow local
   apply → putMaterialsAway → fabricated grabResult → updateOutShape clearing
   grid slots) and identify where the client-side log count stops reflecting
   reality.
3. Is `waitForTicks(4)` a principled sync barrier or a race? Is there a packet
   or event (e.g. window `updateSlot` from a genuine `container_set_slot`, or
   `setSlot` with matching stateId) I should await instead to know the server's
   verdict deterministically?
4. Are there known upstream issues/PRs about `bot.craft` desyncs on 1.20/1.21
   (mineflayer, prismarine-windows) and is there a maintained alternative
   (e.g. crafting via the `mineflayer-crafting-util` approach, or clicking with
   explicit stateId waits) that is more reliable than patching around
   `bot.craft`?
5. Should partial success be possible at all under my clamp (executions never
   exceed affordable), or can the server still reject mid-sequence (lag,
   anticheat on a modded server, item entity pickup racing the click sequence)?
   If yes, what's the correct retry strategy?

## Problem 2 — pathfinder spent most of the wall-clock "deciding paths to nowhere"

First run: the roster shipped coordinates from a different world. Every walk to
home/chest/workstation burned 14–60 s per attempt before failing:

```
anchor check: walk to home (-34,76,24) failed: Took to long to decide path to goal!
act goTo(-28,76,30 r3) FAILED after 14186ms: Took to long to decide path to goal!
routine 'farm-setup' FAILED after 60302ms: Took to long to decide path to goal!
act goTo(-33,76,23) timed out after 45000ms
```

Mitigation so far: roster coordinates removed entirely (bots self-anchor at
spawn), anchors self-heal, and the system already backs off per failing slot.
But the pathfinder behavior itself is the open question:

1. "Took to long to decide path to goal!" is mineflayer-pathfinder's
   `noPath`/think-timeout. What do `thinkTimeout` and `tickTimeout` default to
   in 2.4.2, and what's the right way to bound path computation for goals that
   may be unreachable or in unloaded chunks — so the failure comes in ~2 s, not
   14–60 s?
2. Is there a cheap reachability pre-check (e.g. is the goal chunk loaded; is
   there standable ground near the goal; straight-line distance vs viewDistance)
   that should gate every `goTo` before invoking A*?
3. With `viewDistance: 'short'` (the bot was switched to this because 'tiny'
   made 32-block searches scan unloaded chunks), how does pathfinder handle
   goals beyond loaded terrain — does it expand into unloaded chunks treating
   them as air/solid, and is partial-path mode (`GoalNear` with
   `allowPartialPath` or similar) the right tool to walk-toward-then-recheck?
4. When a 45 s collect timed out (`collect(spruce_log x4) FAILED after 45018ms`)
   the in-flight pathfinder goal then poisoned the NEXT action
   (`GoalChanged: The goal was changed before it could be completed!`). I
   already call an `abortActiveTasks` (pathfinder stop, pvp stop, collectblock
   cancel) on action timeout — what's the correct full cleanup sequence for
   mineflayer-collectblock 1.6 + pathfinder 2.4 so a timed-out task can never
   leak its goal into the next action?

## Problem 3 — error strings taught the LLM false facts

After Problem 1's bogus failure, the error string was:

```
cannot craft crafting_table: no recipe matches current inventory
(need ingredients or a crafting table within 16 blocks)
```

The LLM (reasonably!) concluded "a crafting table can't be crafted without a
crafting table nearby", said so out loud, wrote it to long-term memory, and
**never attempted the craft again for the rest of the run** — even after a
human player ordered it to in chat. The day planner kept restarting farm-setup,
which kept escalating "I need a hoe — the crafter has to make one first"
(there IS no crafter in this 2-bot roster), and every error deliberation
re-concluded "blocked, waiting".

Mitigation: errors now name the exact shortfall ("missing ingredients: 4x
oak_planks (have 0)") or prescribe the unblock ("its recipe needs a crafting
table and none stands within 16 blocks — craft one (4 planks, no table
required) and place it first"); the stock skill now tries to craft its own hoe
before escalating, and its escalation text no longer references roles that may
not exist.

What I want from you:

1. A principled review method for an agent-tool surface: how do I audit every
   error string for "does this prescribe the correct next action, and is it
   true in all the states that produce it?" — ideally as a checklist or
   test-harness pattern (e.g. golden tests asserting that each distinct
   failure state's message names the blocking resource).
2. Patterns for preventing one bad inference from becoming permanent false
   memory: should tool errors be quarantined from long-term memory writes,
   tagged with confidence, or should there be a contradiction-checker that
   retires memories when later evidence (a successful table craft) refutes
   them?
3. The repeated-identical-failure loop: the scheduler woke the LLM with the
   same error reason multiple times, and it produced the same conclusion each
   time, burning tokens with zero strategy change. What's a good design for
   failure memoization — e.g. hash(blocked-precondition) → suppress identical
   wake-ups until the precondition observably changes, or escalate to a
   different deliberation kind (plan revision) after K identical failures?

## Problem 4 — stock skills assume a society that may not exist

The shipped farm-setup/gather-loop/craft-batch skills encode a full village
(farmer waits for the crafter's hoe; gatherer banks seeds in a chest the
shopkeeper… etc.). In a 2-bot roster this produced deadlock: farmer waiting on
a nonexistent crafter; gatherer with 11 logs and seeds and **no chest to bank
them in and no way to hand them over** (chest didn't exist yet; trading
requires an external settlement service that may not be running; there is no
"toss item to another bot" primitive).

1. Design question: what's the cleanest way to make stock skills
   roster-aware — check whether a role exists before advising "wait for the
   crafter", with a self-sufficiency fallback chain (do it yourself → ask the
   role if present → escalate to LLM)? Is there prior art in Voyager-like
   systems for skill preconditions over team composition?
2. Should I add a direct item-transfer primitive (mineflayer `bot.toss` toward
   the receiving bot + a pickup acknowledgment event), and what are the
   failure modes (item despawn, third-party pickup, anti-cheat) I need to
   handle to make "give 8 seeds to Froment" reliable without a chest?

## Problem 5 — assorted anomalies I haven't root-caused (lower priority)

- One bot got `Bot error [Unknown error]: client timed out after 30000
  milliseconds` then `Bot disconnected: "keepAliveError"` ~45 s after first
  spawn, while the OTHER bot was mid-pathfinder-burn. Single Node process, two
  bots. Is heavy synchronous pathfinder A* on one bot known to starve the event
  loop long enough to miss keep-alives for its sibling, and is the fix worker
  threads, pathfinder think-time bounds, or both?
- `collect(spruce_log x4)` reliably times out at 45 s in a spruce forest —
  suspect the collectblock find→path→mine loop targets canopy logs it can't
  reach and retries internally. How does collectblock 1.6 pick targets, and can
  I bias it to reachable trunk blocks only?
- The benchmark counted 1 death across the runs; logs don't say cause of death.
  What's the minimal death-forensics hook for mineflayer (last damage event,
  attacker, position) worth logging on every `death` event?

## What I want back

For each problem: (a) root cause confirmed or corrected — name the exact
mechanism in the library/protocol; (b) verdict on my mitigation (sound /
insufficient / wrong, and why); (c) the durable fix with concrete code-level
sketches against the versions above; (d) any upstream issues, PRs, or
replacement libraries I should adopt instead of maintaining workarounds.
Prioritize Problems 1–3; they cost the most bot-hours.
