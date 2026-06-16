# 07 — Hard-won lessons (v1 → Eden requirements)

v1's most valuable output is not its code — it is the months of debugging encoded
in its comments, commit messages, and the June 2026 reliability passes. The rewrite
**must not re-discover these**. Each lesson below is stated as a requirement on
Eden, with the v1 evidence. Implementing agents: treat this file as acceptance
criteria for `bots/hardening.ts` and the exemplar skills.

## Crafting

**R1 — Close stray windows before any crafting click sequence.** Mineflayer routes
`clickWindow` to `bot.currentWindow` regardless of intent. An open chest window
silently hijacks every click: instant fake success, zero items crafted. v1's fix:
`craftItem` closes any container window first.

**R2 — Trust inventory diffs only after packet quiescence.** A craft's outcome is
confirmed by server packets (`set_slot` / `window_items` on `bot._client`), not by
the resolved promise. v1 waits for packet-level quiescence before diffing
inventory; Eden's `craft-item` exemplar must do the same. Craft `count` semantics:
**output items**, clamped, inventory-verified, errors name the missing
ingredients (v1's June 12 contract — the eval suite pins it).
*Why the promise lies* (verified against mineflayer 4.35.0 internals): 1.17+ has
no per-click ack, `stateId` is one shared (per-bot, closure-scoped) variable, and a full
`window_items` re-emits `updateSlot:0` unconditionally — spuriously satisfying
naive "wait for a slot update" sync. Packet-level listening is the only genuine
confirmation.

**R3 — Quiesce autonomous inventory mutators during window operations.** Auto-eat
mid-click-sequence corrupts the transaction — and `armor-manager` auto-equips on
`playerCollect`, so BOTH are concurrent-mutation hazards during any multi-click
sequence. Pause/resume around crafting and chest work.

## The abort protocol

**R4 — Aborting is a sequence, not a call.** The only safe order (verified against
mineflayer/pathfinder/collectblock sources in v1):

1. clear collectblock targets;
2. `bot.pvp.stop()`;
3. `bot.pathfinder.stop()` **then** `setGoal(null)` — a lone `stop()` arms a latent
   `stopPathing` flag on an idle pathfinder that silently self-cancels the *next*
   goal;
4. close any stray window;
5. yield one macrotask to let event handlers settle.

Every timeout/stall/preemption path runs this; "the next action fights a zombie
task" was v1's most expensive recurring bug class.

**R5 — A timed-out action's promise is abandoned, but its plugin keeps driving the
bot.** pvp/collectblock don't know your wrapper gave up. Hence R4 on every
timeout — already wired into the engine spec
([02 §Validation](02-skill-system.md#validation--runtime-supervision)).

## Pathfinding & movement

**R6 — Bound the pathfinder at spawn.** Upstream `searchRadius` defaults to `-1`
(unbounded); `thinkTimeout`/`tickTimeout` default high (5000 ms / 40 ms). All three
must be bounded.
v1 values, adopt as-is: `thinkTimeout` 2 s, `tickTimeout` 10 ms, `searchRadius` 64.

**R7 — Walk far/unloaded goals in hops.** ≤40-block legs toward distant targets;
a single goal into unloaded chunks stalls or detours absurdly.

**R8 — `viewDistance: 'short'`.** `'tiny'` made 32-block searches scan mostly
unloaded chunks (v1: hours lost to "block not found" that was really "chunk not
loaded"). Related diagnostic: a 0 ms perception failure means *absent-or-unloaded*,
not "searched and missing."

**R9 — Distinguish benign preemption from failure.** "Path was stopped" /
"goal changed" / cancellation are *deliberate interruptions* — they must not count
against a skill (v1 struck skills for being correctly interrupted). Eden encoding:
`RunReport.aborted = 'preempted'`; the critic treats it as no-fault.

## Collection

**R10 — Collect trunk logs only (column-connected-to-ground), one block per
`collect()` call, skip-on-failure.** Bulk `collect()` of a matched set chases
floating leaves-logs and dies mid-list. The `collect-blocks` exemplar inherits
v1's algorithm. Also: collectblock picks targets greedy-nearest-3D with **no
reachability check and no timeout**, and it **replaces the bot-global pathfinder
`Movements` on every `collect()` call** — re-assert your movement config after
using it.

## Connection & identity

**R11 — Protocol pin.** Server, Java mod, and every bot agree on **1.21.1**.
Version drift = silent kick at login.

**R12 — Username uniqueness across ALL processes.** Minecraft kicks the second
login of a name. Eden villagers, Eden's `Dieu` avatar, v1's `LLMBot`, and the
unified entrypoint must be pairwise distinct while coexisting. Eden asserts at
boot: no roster name equals the avatar name; document the cross-system invariant
in `eden.example.json`.

**R13 — Stagger logins; keepalive realism.** Burst-spawning 11 bots trips
throttles. `checkTimeoutInterval` 90 s (v1 value). Diagnostic to preserve: a
keepalive error means *the server stopped sending* (server-side stall/restart),
not bot CPU.

**R14 — Op only the avatar, automatically; villagers never get op.** v1's
op-on-join hook keys on the god bot's name. Same rule, Eden's name.

## Plugins & module system

**R15 — Named imports for the CJS/`__esModule` plugin trio.**
`mineflayer-pvp`, `mineflayer-collectblock`, `mineflayer-tool` ship CJS with
`__esModule: true` and `exports.plugin` but no default. Default-import works under
tsx-production and lands `undefined` under test loaders. Always
`import { plugin as pvp } from 'mineflayer-pvp'`. (`mineflayer-auto-eat` is native
ESM — named import required; `pathfinder`/`armor-manager` are flagless CJS —
either works.)

**R16 — Plugin loading is individually fallible.** Wrap loads so one failed plugin
logs a warning instead of taking the bot down. The `physicTick`-deprecation line on
every spawn is upstream noise — don't chase it.

**R17 — auto-eat config is load-bearing:** `returnToLastItem: true` (combat-after-
eat) and the explicit `bannedFood` list. Port verbatim.

## World state

**R18 — Configured coordinates are hints, not contracts.** Homes snap to real
standable ground at boot; a missing chest is replaced by the nearest
chest/trapped_chest/barrel; discovered positions persist as overrides that win over
config; unrecoverable anchors produce ONE loud warning, never an error loop.
(v1's anchors.ts behavior — Eden keeps it in villager boot, spec'd in
[01 §Startup](01-architecture.md#startup-sequence).)

## LLM plumbing

**R19 — Token-budget memory, not message-count.** One tool result can outweigh
fifty chat lines. (Eden context packs budget per section —
[04 §Context pack](04-villager-runtime.md#the-context-pack).)

**R20 — Tool-call/result adjacency is sacred.** An assistant turn with tool calls
followed by anything but its results = provider 400. Every error/abort path must
either complete the pair or wipe the conversation — never leave it dangling.

**R21 — Timeouts are not retries.** Reasoning models legitimately exceed 60 s;
configure generous HTTP timeouts (v1: 180 s default). Conversely, TCP
connection-resets from stale keepalive pools are retriable noise — let the client
retry those automatically. Don't conflate the two.

**R22 — Config files warn on unknown keys** and adopt common aliases
(`max_tokens`/`max_completion_tokens` → `maxTokens`). Silent config typos cost v1
days.

## Process hygiene

**R23 — One clean stdout.** All logging through the logger to stderr/files.
Even without an MCP-stdio transport in Eden, mineflayer deps print garbage;
discipline from day one.

**R24 — Ports are a registry, not folklore.** v1: 8765 unified, 8766 village
admin, 8767 Java settlement. Eden adds 8770 admin. Document every port in
`eden.example.json`; never reuse 876x while v1 can still run.

## Privilege

**R25 — Non-divine code never speaks slash commands on an op'd bot.** v1's bridge
stripped the leading `/` from every `POST /chat` body precisely because an LLM
could otherwise run arbitrary server commands by phrasing them as "speech" on the
op'd avatar. Eden generalizes the rule: villager bots are never op'd (the server
refuses commands — first layer), and when the avatar executes a *mortal*-tier
skill (demonstrations, trials of villager-authored code), the engine intercepts
and drops `/`-prefixed chat for the duration of the run (second layer). Only
divine-tier code commands the server
([02 §Tiers](02-skill-system.md#tiers-mortal-and-divine)).

## Pathfinder economics

**R26 — Know the pathfinder's hidden retry economy.** "Took to long to decide
path to goal!" is ONE A* context exhausting `thinkTimeout`. But a 14–60 s `goTo`
burn is *legitimate*: `resetPath` churn — the bot's own block updates,
`chunkColumnLoad` adjacent to visited chunks, stuck-detection (>3.5 s) — each
grants a FRESH `thinkTimeout` budget while the promise survives. Unloaded chunks
are impassable *fake blocks*, and `canDig: true` makes the search space ≈ the
entire loaded volume, so you get `timeout` instead of the honest `noPath`. Budget
for this: bound the search (R6), hop (R7), and treat long burns as expected
behavior to cap — not bugs to chase.

## Death forensics

**R27 — The authoritative cause of a bot death is the `death_combat_event`
packet** (`bot._client.on('death_combat_event')`), not inference from entity
state. Eden's bot pool journals it on every death.

## Environment & operations

**R28 — Two servers, two working directories.** The dev server
(`./gradlew runServer`) lives in `run/` and listens on **25599**
(`run/server.properties` — read it, never assume 25565). The eval/production
server is `C:\Users\Paul\Desktop\PaulsBrawlsVanilla` (25565; RCON 25575), and the
**JVM cwd is `PaulsBrawlsVanilla\`** — the Java mod's runtime configs
(`*_config.properties`) and logs live THERE, not in `run/`.

**R29 — `./gradlew runServer` steals port 8767** (the settlement listener binds
in whichever mod instance starts first). Stop the dev server before anything
that needs settlement against PaulsBrawlsVanilla — evals especially.

**R30 — `npm install` can truncate `@types/node`** (`process.d.ts` cut
mid-declaration; symptom: `error TS1005: '>' expected` at build). It is not a
TS version mismatch. Fix: `npm install @types/node` again, alone.

**R31 — Open-to-LAN singleplayer cannot host Eden.** It randomizes ports per
session and cannot reliably op a bot — the avatar's divine tier (R14, R25)
requires a real dedicated server.

**R32 — World regeneration poisons persisted state twice.** Coordinates go stale
(self-healing anchors fix that, R18) — but **beliefs** survive: v1 bots carried
"no seeds exist in this world" through archives and life summaries long after the
world that made it true was deleted, and kept steering by it. Eden: stamp every
data dir with a world identifier at first boot; on mismatch, quarantine memories
behind an admin decision (wipe or migrate) instead of letting bots reason from a
dead world.

## Cognition-loop economics

**R33 — When a tool error is mechanically recoverable, recover in the tool.**
v1 evidence: `start_conversation → "too far away"` burned four deliberations
while the target kept moving; the fix was walk-then-talk *inside the tool*, not
prompt tuning. Repeated identical tool errors across LLM calls = the tool's
contract is the bug, and every retry is money.

**R34 — Completion ≠ progress.** A job can exit cleanly having achieved nothing.
v1's futility pass: zero productive actions (numeric results > 0 on
dig/place/collect/craft/deposit/withdraw/give) plus ≥1 swallowed action error
means "the script tried and the world said no" — escalate after 2 consecutive.
Eden mapping: the critic judges **world delta** (RunReport snapshots + call
tree), never a clean exit alone.

**R35 — …and quiet ≠ futile.** Zero progress with ZERO failures is a legitimate
pass — a patrol, a field still growing. Don't escalate it. (The two halves of
R34/R35 are why "did it work?" needs a judge, not a counter.)

**R36 — One incident, one wake-up — and every suppressor needs a release
valve.** v1 double-fired deliberations (routine runner AND bot host each
reporting one failure) until fixed; and its failure-suppression memo had to
learn to reset on real progress or it gagged legitimate news. Eden: the
component that owns a failure owns the single escalation; everyone else only
journals. Any anti-spam counter that never resets is a future gag.

**R37 — Contradiction retires belief.** A success must retire stored "X is
impossible" conclusions (v1's `refuteBlockedBeliefs`). Eden assigns this to the
critic at verdict delivery ([04 §Memory](04-villager-runtime.md#memory)) — the
requirement stands wherever it lives: stale negative beliefs compound worse than
stale positive ones.

## Embeddings

**R38 — Multilingual embedding model, lazily, with a keyword floor.** The bots
think partly in French; English-only MiniLM cannot separate French topics —
multilingual is mandatory, not a nicety. Embed in batches off the hot path.
Three consecutive embedding failures → degrade retrieval to keyword overlap for
the run instead of erroring.

## Monitoring & timeouts

**R39 — Timeouts are safety valves, never the bug.** Removing a timeout to "fix"
a hang converts a 30 s blip back into a permanent hang. Fix the blocking work;
keep the valve.

**R40 — Monitor event-loop lag in-process and journal spikes.** When the host
freezes for N seconds, every watchdog fires at once and the logs blame the
network. The lag monitor (v1 added one after the keepalive cascade) is what
tells you *it was you*. Corollary diagnostic: mass simultaneous disconnects +
"Can't keep up! Running ~Nms behind" where N matches one of your timeouts =
a single block of that length, not a network bug.

**R41 — Log tags must name the true actor.** v1's logger hardcoded
`[mcp-server]` for every entrypoint, so `[mcp-server] keepAliveError` actually
meant "the *bot* lost the *Minecraft server*" — hours of misread logs. Eden
journal events carry `actor`; human log lines inherit it.

## Testing & eval discipline

**R42 — Port the eval-harness patterns, including its sharp edges.**
Deterministic scripted mock LLM (own port); idempotent world fixtures via RCON;
the eval roster suppresses ambient machinery (huge heartbeats, embeddings off)
so scenarios drive everything explicitly; the eval data dir is wiped at run
start; eval bot usernames share a reserved prefix and must not collide with any
production name (R12). Sharpest edge: per-scenario pre-boot state seeds are
per-bot EXCLUSIVE — a new scenario must claim an unclaimed bot or it silently
clobbers another scenario's seed.

## Repo hygiene

**R43 — No nested git.** v1's vendored fork was a nested standalone git clone
(its own `.git` pointing at upstream — not a submodule/gitlink) while months of
village work sat uncommitted in the inner repo.
Eden lives in the parent repo as a plain directory (`eden/`) — no submodule, no
inner `.git`, one history.

## Journal volume

**R44 — High-frequency liveness signals stay in memory; never journal a per-tick
stream.** The stall detector's pulses (position delta, pathfinder liveness,
dig/place) are in-memory counters, not journal events — journaling the
20 Hz × 11-bot stream is the volume bomb. Website liveness is derived from `vitals`
(snapshot cadence, default 10 s) plus the live event stream, never from raw pulses.
General rule: any signal sampled at physics rate is read in RAM, and only its
*summary* (a `vitals` snapshot, a `RunReport` field) is journaled. The journal
writes synchronously on the shared loop precisely *because* the hot stream was kept
out of it; the R40 lag monitor is the canary that says when that stops holding.
(Eden decision [D-07](05-observability.md#decision-d-07-synchronous-journal-in-memory-pulses-lag-monitor-as-the-canary).)

## Sandbox boundary

**R45 — The syscall shim is footgun removal, not a sandbox.** Eden neuters
`process.exit`/`reallyExit`/`abort`/`kill` in skill scope (D-08) because they have
no legitimate skill use and an unbounded blast radius. It is **not** a security
boundary and must not grow into one: determined escapes (`globalThis.process`, the
`Function` constructor reaching globals, `worker_threads`) remain reachable **by
design**, because closing them is the full sandbox owner decision #5 / P3
deliberately rejected. The only security boundary is the **tier gate** (R25) plus
villagers never being op'd. If you find yourself adding identifiers to the shim's
denylist, stop — you are rebuilding v1's banned-identifier scan that the rewrite
dropped. (Verified fact behind the design: `process.exit()` in a worker thread kills
only that worker, so the worker escape hatch genuinely contains it — but that is the
deferred last resort, not v0.)

## Stall detection

**R46 — A stall pulse is a discrete progress *event*, not an "in-progress" state —
and pathfinder liveness is a pulse source.** Implementing the async stall detector by
polling state ("is a dig/path happening?") re-breaks hang detection: a wedged
`bot.dig` holds `targetDigBlock` forever and a dead A* still "has a goal." Pulse only
on discrete events — moved, inventory changed, window toggled, dig/place started or
completed, `path_update`/`path_reset`/`goal_*` fired, a `ctx.log`/`sleep` tick.
Subscribing to mineflayer-pathfinder's **public** events is the *precise*
reconciliation with R26: a churning `goTo` emits them while the bot stands still, so
it is genuinely alive — omit that source and you re-introduce R26's false abort of
legitimate 14–60 s paths. The detector is async-hangs-only (sync `while(true)` is the
loop budget); the wall-clock `timeoutMs` is the separate ceiling that bounds a
pulse-forever spin (e.g. `while(true){await sleep()}`), which then reaches the critic
as futility (R34/R35), not the detector. (Eden decision [D-10](02-skill-system.md#decision-d-10-a-pulse-is-a-discrete-progress-event-pathfinder-liveness-is-a-built-in-pulse-source).)

## Density budgeting

**R47 — Never trim the current density payload; bound skill size at the source.** The
refinement loop's invariant (full draft code + verbatim error + before/after world +
critique in ONE message) is only a guarantee if the current payload can never exceed
the budget. Enforce that at `write_skill` with a hard size cap (`skills.maxSkillLines`)
— a decompose-or-reject error, **not** prompt-time truncation of code (which blinds
the critic). At trim time, drop only *prior* revision turns, oldest-first, as whole
tool-call/result pairs (R20); the current payload and the frame are never trimmed
(R19: token-budget, not message-count). Any tier that runs a rollout role must satisfy
`inputTokenBudget ≥ frame + max-draft + RunReport + critique + headroom`; config
validation warns otherwise. (Eden decision [D-11](03-god.md#decision-d-11-never-trim-the-current-density-payload-bound-skill-size-at-the-source-per-tier-input-budget).)

## Library health

**R48 — Contain a wrong verdict with rails, not silos; keep them one-directional.**
The global library (owner #2) means a false admission reaches every villager *and
every composing skill*. Contain it without re-siloing: **probation gates composition +
time, never per-villager access** — an `active-probation` skill is globally runnable
and retrievable but not composable until it survives N clean runs (D-12). Three
one-directional invariants must hold or the rails invert into bugs: the `check`-veto
only *blocks* admission on a failed check (a passing check is never an auto-admit —
"evidence FOR the critic, not a bypass"); self-healing un-quarantine lands in
`active-probation`, never straight to `active` (a fluke success must not instantly
restore a dependency); and probation gates `ctx.skills.run` *from another skill*, not
the brain's direct `run_skill`. A hallucinated critique needs no rail — it corrupts
nothing and is bounded by `maxRetries` + curriculum frontier-learning. (Eden decision
[D-12](03-god.md#decision-d-12-three-deterministic-rails-around-the-single-verdict).)

## Cost & throughput

**R49 — At low concurrency the limiter is throughput, not the wallet; don't
cap-throttle the loop.** With `maxConcurrent: 3`, ten bots emit at most
~3 000 calls/day through three slots regardless of budget — the throughput ceiling
(`maxConcurrent × 86 400 ÷ avgLatencySeconds`) already bounds the worst case. So a
daily per-desk token cap is a *safety valve* to set against a provider price, not the
primary cost control; defaulting it aggressive re-creates v1's suppression pathology
in budget form — a breached cap gags the refinement loop exactly when it is learning.
The real levers are structural and free: the **strong/fast tier split** (strong for
novelty, fast for dispatch/reactive/QA) and **zero-token `subscription → skill`
reactivity**. Spend LLM budget only where novelty requires it. (Eden decision
[D-13](03-god.md#decision-d-13-throughput-limited-budget-caps-are-a-safety-valve);
live cost model in that record — update it if maxRetries / probationRuns / the density
budget move.)

## Reactivity

**R50 — A reflex is only a reflex once it's WIRED into the running host; built-and-
unit-tested is not "done."** The whole M5 reactivity system (EventRouter /
SubscriptionRouter / SubscriptionStore / role-defaults / `roles.json`) shipped
green in isolation but was never assembled in `main.ts`, so in a live run a hit
still waited ~16 s for the LLM to author a combat skill while the guard died at
+11.7 s (cooperative-mob-defense). The bar the fix must clear is *time-to-first-
defensive-action < survival-time-under-fire*: a `kind:'skill'` handler runs
**zero-token via `engine.run` the instant the signal normalizes**, ahead of any
wake-up. The fix is composition, not new mechanism — per villager: a per-bot signal
adapter → an `EventRouter.attach()` → a `SubscriptionRouter` (with `engine`,
`journal`, a live `vitals()`, and a wake-up that swallows its own LLM errors), seed
role-defaults at first boot, arm the 30 s `tick()`, detach on `stop()`. Wire it on
the SAME gate as the rest of the live host (a live bot pool); a CI/no-bots boot
leaves the store empty and builds no router. (Eden decision
[D-15](04-villager-runtime.md#decision-d-15-a-role-reflex-overrides-the-everyone-reflex-on-the-same-event).)

**R51 — mineflayer's `entityHurt(entity)` carries neither damage nor attacker;
derive both, and don't let the router hear the native event.** The EventRouter's
`hurt` row is designed for a normalized `(self, { damage, byEntity })` shape, but
mineflayer fires native `entityHurt(entity)` for EVERY entity with no damage and no
attacker. A per-bot adapter (`bots/signals.ts`) therefore synthesizes the hurt from
the bot's own `health` **delta** (the damage) + the nearest hostile (the attacker)
and emits it on a DEDICATED bus the router attaches to — never the bot directly, or
the native event would leak spurious damage-0 hurts for the whole world and fire the
reflex on anything. The router still reads live STATE (health/time for the
hysteresis edges) off the real bot. Scope the translation: forward only the signals
a real source exists for (`hurt`/`health`/`death` this pass), so the unfired router
rows stay inert instead of spamming a wake-up before their source is real.

**R52 — `tool_choice: 'auto'` lets gpt-4o skip the `verdict` tool call and return markdown
text; `parseContentJson` only rescues JSON code blocks, not markdown bullet lists — a
`success:true, libraryAction:admit` verdict was silently degraded to `keep-draft`.** In the
2026-06-15 farm-wheat run, the critic's first call returned a ````json {...}` code block
(parsed correctly); subsequent calls returned `- **success**: true` markdown bullets
(`parseContentJson` fails; no `{` in the right place), and the `harvest-wheat` skill was
never admitted despite 5 successful runs and 14 harvested wheat. Fix: set
`tool_choice: { type: 'function', function: { name: 'verdict' } }` in the critic's LLM call
(requires adding a `toolChoice` option to `LlmRequest` and threading it through
`LlmClient.chat`). Until fixed, re-run a scenario with the
same provider to confirm the model behaviour is deterministic; if the model continues to
skip the tool, pin `tool_choice: 'required'` globally as a stopgap.

**R53 — two pools both spawning the avatar = a self-inflicted R12 kick loop; the in-game
`/villagers start` must drive the SAME pool God is wired to, and the avatar's login must be
DEFERRED, not auto-spawned at boot.** In the 2026-06-15 farm-hamlet session, booting Eden
(avatar-only) and then running `/villagers start farming-hamlet` connected the scenario through a
SECOND pool (the old `ScenarioManager`, which created its own `BotPool` with `avatarName` set). The
boot pool's `Dieu` was already connected, so Minecraft kicked the duplicate login ~1×/s forever
(`system.bot-disconnected{reason:"kicked"}` → `bot-connected` → repeat). Worse, `wireGod` binds ONCE
at boot to `config.villagers` + the boot pool, so the scenario pool's villagers were never God- or
reactivity-wired — inert bodies. Fix (option C): **one pool.** Load the scenario at boot
(`config.scenario` → `applyScenario` before `wireGod`) so God + reactivity bind to its roster; then
**defer the spawn** — the bots connect only on the in-game `/villagers start`, which starts the
already-wired boot pool (`VillageLauncher`, not a second pool). A bare boot (no scenario, no
villagers) builds NO pool, so the avatar never auto-logs-in. `autoSpawn` is the opt-in for
boot-then-act drivers (the live-test harness). `BotPool.start()` clears `stopping` so the reused pool
survives a stop→start (restart). The lesson generalizes: **the avatar is single-instance; every code
path that can connect it must converge on one owner, and "spawn at boot" is a trap whenever a second
spawn trigger exists.**

**R54 — the refinement loop needs a DRIVER in the running host; "the GATE test / live-test harness
calls `runOnce`" is not a production pump.** Sibling of R50 (a reflex isn't wired until it's wired),
one layer up. In the 2026-06-15 farm-hamlet session, `/villagers start` connected all 4 bots (R53 held)
and then the village sat dead: `/status` `currentRuns:0, queueDepth:0, budgetSpend:0`, the journal only
`vitals` + the M5 `hurt` reflex — no `brain.wakeup`, no `god.task-proposed`, no `llm.call`. Root cause:
`RolloutCoordinator.runOnce()` (the M4-3 loop) was only ever called from `tests/` and the live-test
`harness.ts`; `main.ts` *builds and exposes* the coordinator but no boot path and no admin route ever
pumps it. The launcher connects bodies + loadout; it does not propose tasks. Fix: a `VillageLoop` at the
composition root — one loop per villager (`runOnce({trigger:'idle', villager})` after the body connects),
tied to the launcher lifecycle (`start` on `/villagers start|restart`, `stop` on stop + shutdown), and
explicitly NOT armed on `autoSpawn` so the harness keeps sole control during live-tests. **The driver
must always end each turn with an awaited macrotask `sleep`** — the first cut only backed off on a
no-proposal turn and microtask-spun on success, starving every timer (finding W, re-bitten). General
lesson: when a coordinator is exercised only by tests + a harness, the production *caller* is the silent
gap — "feature-complete and CI-green" can still mean "never actually run by the host."

## World interaction (block state)

**R55 — a world mutation is confirmed by the server's block-update, NEVER by `activateBlock`
resolving; reading `bot.blockAt` synchronously after it is a read-after-write race that
false-reports failure.** The block-state analog of R2 (crafting: trust packet quiescence, not the
resolved promise). `bot.activateBlock(block)` resolves the instant the use-item packet is **sent**;
the world flip (dirt→farmland on a hoe, farmland→crop on a seed) only lands ~1+ tick later when the
server's block-update returns and refreshes mineflayer's local chunk. In the 2026-06-15 farming-hamlet
session two farmers churned **16+ versions** of `till-and-plant` (plus a dozen siblings) emitting
`"Le labour n'a pas fonctionné (bloc pas devenu farmland)"`: the journal showed a clean controlled
split — versions that read `blockAt()` immediately after `activateBlock` (v10/v11) reported failure on
grass blocks they had *actually tilled* (the whole patch was already farmland; a later run "found" them
done), while a near-identical version that `await sleep(200ms)` first (v13/v14) succeeded. Two
Minecraft rules the villagers also kept breaking, both folded into the fix: (1) the hoe only tills a
block with **air directly above** — never a buried block at `waterY-1` under the bank (vise la
SURFACE); (2) the action is idempotent if the block is already farmland. Fix = **seed the confirmed
primitive, don't let the loop re-derive the race**: stock `till-block`/`sow-seed`
([eden/src/skills/exemplars/index.ts](../eden/src/skills/exemplars/index.ts)) equip → activate → **poll
`blockAt` until the server confirms (or time out)**, returning a clear error naming the likely cause.
The fakes never caught this because FakeBot had no `activateBlock` and flipped no blocks — the exact
"stock/exemplar validated against FakeBot but wrong on real mineflayer" trap (Z/C/E class). So the
FakeBot now models `equip` + `activateBlock` with a **delayed** transition (`setActivateDelayMs`) so the
race is reproducible in CI: a synchronous read sees the stale block, a polling skill sees the flip. Poll
with a real macrotask (`await new Promise(r => setTimeout(r, 50))`), never an immediately-resolved
promise — that would starve the watchdogs (finding W).

**R56 — a per-provider key var that's unset must FAIL LOUD, never silently fall back to another
provider's key; and the production host must load the SAME key file the live-test harness does.** In the
2026-06-15 session the host (provider `deepseek`, `apiKeyEnv: DEEPSEEK_API_KEY`) emitted an endless
`HTTP 401: your api key ****YCoA is invalid` on a key the user had never configured for DeepSeek — `YCoA`
was the *OpenAI* key. Two compounding faults: (1) `tsx src/main.ts` never loaded `eden/api-keys.env`
(only `live-tests/run*.ts` did), so `DEEPSEEK_API_KEY` was absent from the host's environment even though
the file held the correct key; (2) [client.ts](../eden/src/llm/client.ts)'s `apiKey ?? process.env.OPENAI_API_KEY`
default then masked the gap by sending the OpenAI key to `api.deepseek.com`. The user's "the key file is
correct and doesn't end in YCoA" was exactly right — the file was fine, the host just never read it and
silently substituted the wrong key. Fix: `main.ts` calls `loadEnvFile(api-keys.env)` (existing env wins —
pm2/CI override the file) before resolving the provider, and `wireGod` **throws** at boot when a declared
`apiKeyEnv` is unset rather than letting the client's OpenAI fallback fire. A null `apiKeyEnv` (local
providers) still needs no key. Loud diagnosis at boot beats a quiet 401 loop pointing at the wrong key.
(pm2 caches env at start — after setting a key, `pm2 restart eden --update-env`.)

**R57 — a state machine with no runtime caller for its advancing transition is a deadlock, even with
green unit tests.** D-12 probation was inert in production: `SkillLibrary.recordProbationRun` (the ONLY
path that decrements `probationRunsLeft` and graduates `active-probation → active`) had **zero callers
outside its own unit test**, which exercised it by calling it directly. So every LLM-admitted skill stayed
`active-probation` forever; the engine's `ProbationError` gate refused it as a composition callee forever;
and farmers churned re-authoring wrappers (`till-then-plant-row-hydrated` wrapping the probationary
`till-then-plant-row`, …) until the brain's tool-turn ceiling — looking, in-game, like "after a skill
succeeds the farmer stops doing anything useful." The 2026-06-15 journal made it unambiguous: 7 `skill.admit`s,
**20 distinct skills drafted in one session**, and admitted skills (`farm-wheat-row-1x3`,
`till-then-plant-row-1x3`) each got **4 clean direct root runs** that should have graduated them at 3 — but
never did. Fix = wire graduation at the engine's root-run completion, beside the existing
`tripwire.recordRun`: `if (root.version.status === 'active-probation') library.recordProbationRun(name, ok)`.
Gate on the version that ACTUALLY ran being probationary, so a draft trial (status `draft`) of a newer
version never advances an older live-probation version. **The pinning test must drive the real path
(`engine.run` ×3 → graduates), not call `recordProbationRun` directly** — the direct-call test is exactly
what let the gap ship. (NOTE: this counts clean runs but does not critic-re-judge them — the "auto-ticket
the first 3 production runs for re-review" of [03-god.md §Probation](03-god.md) is still unbuilt; graduation
is run-counting, matching the 02 state machine.)

**R58 — never recompute a per-item embedding inside the per-request hot path; cache it by an immutable
key.** `SkillRetriever.search` embedded `[query, ...EVERY live skill summary]` through the embeddings
backend on **every** deliberation — O(library) inferences per wake-up. With the in-process ONNX backend
(`@xenova/transformers`, multilingual MiniLM, R59) that is O(library) *synchronous* main-thread inferences
that do NOT yield to the event loop — a multi-second stall on every retrieval that worsens monotonically as
the library grows (compounded by R57's churn to ~180 skills). (Caveat from the 2026-06-16 diagnosis: in the
journal that showed `system.loop-lag max≈2166ms`, embeddings were 401-degraded to the keyword floor (R59),
so that *particular* lag was GC/churn, not inference — but the moment local embeddings are correctly enabled,
this uncached O(library) loop IS the dominant stall, which is why the cache ships alongside enabling them.)
Fix = cache skill vectors keyed by `name@version` (append-only ⇒ immutable), re-embedding only the query +
skills whose **text** changed — keyed on the text too because the description-from-code pass mutates a
version's manifest AFTER its first retrieval (admit → live → describe). FIFO-bounded so a long run can't grow
the cache unboundedly. Residual: the FIRST retrieval after boot still embeds the whole live set once (cold
cache); the proper long-term home for inference is a worker thread (D-01's escape hatch).

**R59 — the embeddings backend must never be derived from a CHAT provider, and an authenticated endpoint
needs the Bearer header.** Eden's host wired `EmbeddingsService` to
`config.llm.providers.fast.baseUrl ? providerBackend(fast.baseUrl, fast.model) : localBackend()` — so on any
remote provider it POSTed the fast **chat** model (e.g. `gpt-5.4-mini`) to `${baseUrl}/embeddings` with **no
`Authorization` header**, producing `embeddings: HTTP 401` on **every** call → after 3 it R38-degraded to the
keyword floor for the whole run (silent: semantic retrieval just stopped, which itself fed the R57 duplicate-
skill churn). Three stacked faults: (1) `providerBackend` sent no auth; (2) a chat model is not an embedding
model; (3) the documented default is the **local in-process** model, but the wiring only fell back to local
when the chat provider had *no* baseUrl — never true for a remote LLM. Fix = default to `localBackend()`
unconditionally (no key, no HTTP, so no 401 — needs the `@xenova/transformers` dep, which was missing from
`package.json`); a remote embeddings endpoint is now an **explicit** opt-in (`providerBackend(baseUrl,
*embedding*-model, apiKey)`, Bearer header added), never the chat provider by default. Sibling of R56 (a
silent wrong-key fallback) one layer over: a degrade path that hides a config error reads as "feature off,"
not "misconfigured."

**R60 — a read-only discovery tool needs a hard per-deliberation budget; a reasoning model will loop on it
forever otherwise.** With the strong tier on `gpt-5` (a reasoning model) and the rollout context pack
shipping `retrievedSkills: []` (no skills pre-loaded — the villager must discover the library by calling
`search_skills`), villagers fired query after query — `find-block`, `craft-item`, `go-to`, `collect-blocks`,
`place-item`, `till-block`, … — at ~2–3k reasoning tokens per turn, never reaching `write_skill`/`run_skill`,
and hit the 16-turn ceiling with `brain.done "(plafond de tours d'outils atteint)"` and zero progress. The
LLM transcripts (`.eden-data/llm/*.json`, `debugPrompts:true`) were decisive: the response of every turn was
another batch of `search_skills`. Old, healthy transcripts that converged `write→run→done` had a directive
that *literally said* "Écris (write_skill) une nouvelle compétence" and a non-reasoning model — the new
natural-language directive + reasoning model removed both guardrails. Fix (two layers): (1) a **circuit
breaker** in the brain — after `SEARCH_CALL_CAP` (3) `search_skills` calls, **withdraw the tool** from the
offered set for the rest of the wake-up and inject a one-time forcing message ("act now: write_skill +
run_skill, or done"); the model literally cannot search again. (2) prompt **steering** in the capabilities
section ("search_skills is for DISCOVERY, 1–2× — then act"). Deeper root **now fixed (R61)**: the rollout path
passed `retrievedSkills: []`, so the villager had nothing in-prompt to act on and was *forced* to search —
populating it with top-k retrieved skills for the directive (the Voyager design) cuts the searching at the
source. Sibling of the scheduler rate cap (R36) and the loop-budget (W): every read-only/again-able
affordance an autonomous loop has needs a release-valved ceiling, or a thorough model spends the whole budget
exploring.

**R61 — pre-load relevant skills into the prompt; don't make the model discover the library by searching.**
The fix for R60's deeper root. The rollout + reactive deliberation paths shipped `retrievedSkills: []`, so a
villager's ONLY way to find the (~180-skill) library was the read-only `search_skills` tool — which a
reasoning model loops on (R60), starting blind even with the breaker. Fix (the Voyager design, owner #8/#10):
the `SkillRetriever` is now wired into BOTH deliberation paths at the composition root (`main.ts`).
`RolloutCoordinator.assignAndRun` retrieves the top-k (k=10) relevant *live* skills **ONCE per task** (query =
the directive/task goal) BEFORE the revision loop and passes them as `name — signature — summary` one-liners
into the §CAPACITÉS section; the reactive `WakeupFn` retrieves top-k (k=8) for `triggers + hints` (fast tier,
`includeExemplarCode:false` → the retrieved one-liners are its main skill signal). Exemplars (already injected
as full code) are filtered out of the rollout one-liner list so they aren't duplicated. **Retrieve once, never
per-revision:** the library barely changes within a rollout, a freshly-authored draft is `draft` status (not
retrievable), and re-querying would bloat the never-trimmed density payload (D-11). The retriever option is
OPTIONAL on the coordinator — absent → `[]` (the M3/M4/gate/loop-test baseline, zero behavior change).
Embeddings degrade gracefully to the keyword floor (R38/R59), so `search` never throws on this path. This
lifts reuse over the churned library (fewer duplicate-skill authorings — sibling of R57) and cuts searching at
the source; the R60 circuit breaker STAYS as the backstop (this reduces the NEED to search, the breaker bounds
the worst case). Pinned by `tests/loop-integration.test.ts` (rollout path + exemplar-dedup, reactive path,
no-retriever backward-compat).

**R62 — give the skill `ctx` an `mcData` handle, and NAME every registry-lookup failure.** Live finding D1
(diagnosed from the journal): authored skills crashed on real mineflayer with `TypeError: Cannot read
properties of undefined (reading 'itemsByName')` / `(reading 'id')`. Two coupled root causes, both the
"ctx-lockstep" class the gotchas warn about (sibling of Z/C/E): (1) the injected `SkillContext` exposed **no
`mcData`**, yet the LLM — trained on idiomatic mineflayer — writes `ctx.mcData.itemsByName[name].id` /
`mcData.blocksByName[...]`, so it dereferenced `undefined`; (2) the STOCK skills did `bot.registry.itemsByName
[name].id` **unguarded**, so an unknown item name threw the same cryptic `reading 'id'` instead of a named
error. Fix (minimal, S3 — no new module): in `skills/engine.ts` set `ctx.mcData = bot.registry` (the real
`bot.registry` IS the prismarine-registry / minecraft-data instance with `itemsByName`/`blocksByName`), and
add a doc-commented `mcData: ItemRegistry | undefined` to the `SkillContext` interface (with `blocksByName`
added to `ItemRegistry` in `types/bot.ts`); in `skills/exemplars/index.ts` route the five unguarded lookups
(`use-chest`, `smelt-item`, `place-item`, `craft-item`) through a file-local inlined `itemId(bot, name)` guard
that throws `unknown item "<name>" — not in bot.registry.itemsByName (D1)` (S10 — every error names its
subject + the lookup path). The skill bodies are isolated JS *strings* the engine compiles one at a time, so
the guard is INLINED into each body (a TS helper isn't in scope inside the string), NOT exported. FakeBot grew
a `blocksByName` Proxy + a `setUnknownItems()` seam so the named-error path is testable without a server.
Pinned by `tests/skills-engine.test.ts` (`ctx.mcData` resolves a real numeric id; an unknown stock lookup
fails with the NAMED error, never a raw undefined deref). Lesson: whenever you add a field skills are TOLD
they can call, the runtime `ctx` object must move in lockstep — and a bare `registry[name].id` is a cryptic
crash waiting for the first unknown name.

**R63 — the STOCK container/crafting skills must self-apply close-stray-window-first + pause-auto-eat/armor +
finally-close, so authored skills composing them inherit window safety (R1–R3).** Live finding D4 (from the
journal): every container/crafting interaction wasted ~20–22 s and sometimes wedged with
`Error: Event windowOpen did not fire within timeout of 20000ms`. Root cause: the stock skills that open a
window — `use-chest` (chest), `smelt-item` (furnace), `craft-item` (crafting table) — did NOT all follow the
R1–R3 protocol. A previous window left open on `bot.currentWindow` makes the next `openChest`/`openFurnace`/
table-open HANG (the 20 s `windowOpen` timeout) or hijack every click (R1); an autonomous auto-eat/armor-manager
click mid-sequence desyncs the window (R3); and an error/abort that doesn't close in a `finally` leaks the
window for the *next* skill to trip over (R4–R5). Fix (minimal, S3/S5 — no new module): a file-local inlined
`CONTAINER_SAFE_HELPERS` snippet in `skills/exemplars/index.ts` (sibling of D1's `ITEM_ID_HELPER` — skill
bodies are isolated JS *strings* the engine compiles one at a time, so a TS helper isn't in scope; INLINED,
not exported) provides three small guarded functions, prepended into each window-opening body: `safeCloseStray`
(R1 — close `bot.currentWindow` if truthy, then yield one macrotask so the close lands before the open),
`pauseMutators`/`resumeMutators` (R3 — `bot.autoEat?.disableAuto()`/`enableAuto()` + `bot.armorManager?.pause?.()`/
`resume?.()`, the canonical `bots/helpers.ts` API, `&&`/`?.`-GUARDED so a fake/pre-spawn bot with the plugins
absent is a no-op, never a `TypeError`). `use-chest`, `smelt-item`, and `craft-item` now call `safeCloseStray`
+ `pauseMutators` before opening and `resumeMutators` (plus the container close) in a `finally`. Because every
authored skill reaches a chest/furnace/table THROUGH these stock primitives (P2 — the library is the single
vocabulary of action), the window discipline is inherited, not re-derived per authored skill. FakeBot already
modelled `currentWindow`/`closeWindow`/`openContainer` + the auto-eat/armor hooks, so the stray-close ordering
and the absent-plugin no-op are both testable without a server. Pinned by `tests/skills-exemplars.test.ts`
(`D4/R1: use-chest CLOSES a stray window before opening the container`; `D4/R3: pause/resume is GUARDED — no
throw when auto-eat/armor are absent`). Lesson: window safety belongs in the stock primitive, not in every
authored caller — harden the vocabulary once and composition carries it everywhere.

**R64 — an authored skill must VERIFY its intended world effect before returning success; attribute any
delta to THIS run.** Live finding D2 (from the journal): drafts returned a self-reported `{ ok: true }` that
the world contradicted — a chest-"deposit" skill reported `{ placed: true }` after consuming 8 planks but no
chest was actually placed; another "succeeded" by handing over PRE-EXISTING bread instead of bread it crafted
this run. God's critic catches these by world-before/after delta (the D-12 check-veto rail working as
designed — R34: a clean exit is not progress), but each false success burns a full author→run→judge→revise
cycle. Fix (authoring doctrine, prompt-only — no engine change; the engine cannot know task semantics, only
the critic can, and it already does): the authoring wake-up in
[eden/src/villagers/context-pack.ts](../eden/src/villagers/context-pack.ts) `renderCapabilities` (the
`includeExemplarCode` block, sibling of R60-R63's doctrine) now prints a "VÉRIFIE avant de réussir" rule —
re-read the real world state (`bot.blockAt(pos)` to confirm a placed block/container exists and is the right
type; compare an item count BEFORE vs AFTER to attribute the gain to THIS execution), never report success
from a precondition that already held (depositing items you already owned) or from a call that only *attempted*
the action, and return `{ ok: false, error: "<named cause>" }` (S10) when the effect can't be confirmed. The
`write_skill` tool description ([eden/src/villagers/tools.ts](../eden/src/villagers/tools.ts)) carries the same
clause so the rule is present even outside an authoring wake-up. Pinned by `tests/villagers-context-pack.test.ts`
(`M3-1 (§7)`: authoring carries the doctrine; reactive omits it). Lesson: state "confirm the effect before
claiming success" at authoring time to lower the false-success RATE; the critic stays the backstop, not the
only line of defense.

**R65 — give up on an unconvergeable task after K exhausted rollouts; never re-propose the same wall
forever.** Live finding D3 (from the journal): one hard, over-bundled, resource-gated task ("Place a chest by
the 3×3 wheat plot and store the first loaf of bread") was attempted **13 times across ~3–4 rollouts in 21
minutes and never admitted** — ~16 min of LLM and ~115k completion tokens for ZERO progress. Mechanism: a
rollout runs `for (i = 0; i < task.maxRetries; i++)` (DEFAULT_MAX_RETRIES = 4); when it exhausts its retries
WITHOUT converging the coordinator just stopped looping and **left the task open** — so the next `runOnce`
re-attempted the IDENTICAL task with a fresh maxRetries budget, indefinitely. Half the failures were unmet
PRECONDITIONS (`planches insuffisantes`, `bois/planche manquants`, "no 3×3 irrigated farmland found") that
rewriting skill CODE can never satisfy. This is exactly the R33–R37 anti-pattern in a new guise: repeated
failure was an engine silently re-proposing the same task, not a SIGNAL that changes the task. Fix (the
convergence breaker, smallest correct change): the curriculum (sole ledger writer — S2) tracks a per-task
count of EXHAUSTED rollouts via `noteExhausted(task)`, called by the `RolloutCoordinator` on every
`converged:false` return ([eden/src/main.ts](../eden/src/main.ts) `assignAndRun`); after
`MAX_ROLLOUT_ATTEMPTS = 2` exhausted rollouts it CLOSES the task `failed` with a blocked-task reason that
NAMES the task + the attempt count (S10), journaled on the existing `god.task-closed` kind (a one-field
`reason?` extension, not a new kind). The task leaves `ledger.open` → lands in `ledger.failed` (a frontier
signal that steers the next proposal AWAY) → the village moves on to a DIFFERENT task instead of grinding the
same wall. Below the threshold the task stays open and retries exactly as before (the legitimate path is
unchanged); a task that converges still closes `completed` normally. The same exit also now closes the
task's open directive (`expired`) — previously leaked on the non-converged path, which could block the next
task's directive under the orchestrator's "max 1 open non-standing directive per villager" anti-thrash rule.
Future hook (NOT this change): a blocked over-bundled task is a natural `decompose()` candidate — left to the
curriculum's existing decomposition entrypoint. Pinned by `tests/god-curriculum.test.ts` (R65: the breaker
fires after K with a named reason and stays closed; the within-budget retry leaves the task open; a converging
task closes `completed` untouched). Lesson: completion ≠ progress, but a never-converging task is a *signal*
God must act on (defer/decompose/change it), not a loop the engine runs to infinity — one judge, not one
counter (R33), and one give-up is information, journaled (R36 spirit).

**R66 — a bot-pool lifecycle handler must be keyed on the bot INSTANCE, not the member name; and a kick
reason is an OBJECT — never `String()` it.** Live finding (2026-06-16, from the `/villagers restart` journal):
a single bot `Harry` connect/kick-looped at ~1 Hz, every cycle reaching `system.bot-connected` (a full spawn)
*before* the kick, with the reason logged as the useless `kicked: [object Object]`. Two compounding bugs in
[eden/src/bots/pool.ts](../eden/src/bots/pool.ts), both downstream of one restart race. `restart()` (in
[village-launch.ts](../eden/src/village-launch.ts)) calls `pool.stop()` — which fires `bot.quit()`
fire-and-forget (the TCP FIN is not yet processed server-side) — then *immediately* `pool.start()`, which
resets `stopping=false` and re-spawns. The fresh login briefly overlaps the old session, so the server evicts
one with `multiplayer.disconnect.duplicate_login` (sibling of R53's TWO-pool kick loop — this is the
ONE-pool, across-restart variant). The old instance then fired `kicked`/`end`, but `onEnd` looked up its
record by **member NAME** — now pointing at the *replacement* bot — saw state ≠ disconnected, **clobbered the
replacement's record**, and (stopping already false) scheduled a phantom reconnect → the self-inflicted storm.
`onSpawn` resetting `reconnectAttempts=0` on every brief spawn pinned the backoff at its 1 s floor, so it
never climbed. And the reason was destroyed: the 1.21 `kicked` payload is a chat-component **object**
(`{ translate: 'multiplayer.disconnect.duplicate_login' }`), and `String(obj)` → `[object Object]`, hiding the
one fact that names the bug (S10). Fix (smallest correct): every lifecycle listener closes over THIS bot
instance and the handler is **identity-guarded** — `if (!rec || rec.bot !== bot) return` in `onSpawn`/`onEnd`/
`onDeath` — so a superseded instance's events can neither mutate its replacement's record nor trigger a
reconnect (this also subsumes the old already-disconnected guard). Plus a `formatEndReason`/`reasonText`
helper that pulls text out of `{text}`/`{value}`/`{translate}` chat components and falls back to
`JSON.stringify` so a reason is never lost. Pinned by `tests/bots-pool-coverage.test.ts` (a superseded
instance's kicked+end creates no new bot and leaves the live record untouched; an object reason renders
`duplicate_login`, never `[object Object]`). Lesson: a record keyed by a STABLE id (name) but holding a
REPLACEABLE resource (the live socket) must verify which generation of that resource an async event came
from — else a dying predecessor's callbacks corrupt its successor. Diagnostic tell: a connect/kick storm that
reaches `bot-connected` every cycle is a duplicate-login eviction (post-spawn), NOT a login throttle (which
rejects pre-spawn) — and `[object Object]` in a reason field is always a stringified component, never the real
text.

**R67 — the curriculum must see the requesting villager's INVENTORY and the existing skills; and a
scenario mission outranks the warm-up default.** Live finding (2026-06-16, `scenarios/farm.json`): the farmer
was handed an `iron_hoe` + `wheat_seeds` and a `godPrompt` saying "doesn't need wood, a hoe and seeds are
provided — master a skill that loops hoe→sow→harvest→bake→store," yet God repeatedly proposed *exploring for
wood to craft a hoe it already held*. Two compounding gaps in the curriculum desk
([eden/src/god/curriculum.ts](../eden/src/god/curriculum.ts)). (1) **Blind proposal context:** `renderProposalContext`
rendered the ledger frontier + dossier but NOT the villager's inventory nor the existing reusable skills — the
prompt file even *claimed* both were given (S6 prompt/code drift). So God literally could not see what was in
hand and re-derived owned prerequisites (the single most common waste). (2) **Warm-up overrode the mission,
permanently:** with `completed < WARMUP_COMPLETED` the desk injected a hard-coded "propose a basic SURVIVAL
task (wood, food, simple tools)" directive into the *user* message — more salient than the `godPrompt` appended
to the *system* message. Worse, it never lifted: the loop task never converged, so R65 closed it `failed` (not
`completed`), `completed` stayed 0, and the village was stuck in warm-up being told to gather wood forever.
Fix (smallest correct): thread the requesting villager's live `Snapshot` into `proposeTask` →
`renderProposalContext` (a labelled `## INVENTAIRE ACTUEL` section + an explicit no-re-acquire guard);
inject the `SkillLibrary` so a `## COMPÉTENCES EXISTANTES` section lists the live MORTAL skills to compose
(divine filtered out — not villager work); and a `hasMissionDirective` flag (set in `main.ts` when a scenario
`godPrompt` is present) that flips the warm-up nudge to *serve the mission with the current inventory + skills*
instead of the generic survival default. The prompt file now states the mission outranks the defaults, says to
read the inventory before proposing acquisition, and carves a decompose exception: when the building blocks
already exist and the mission asks for one skill that chains them into a loop, that composing skill IS a
legitimate single goal (do not fragment work the village can already do into busy-work sub-tasks). Pinned by
`tests/god-curriculum.test.ts` (inventory awareness, mission-aware warm-up, library coverage hides divine).
Lesson: a desk that decides *what to do* must be shown *what is already true* — the inventory and the existing
library are not optional context, and a standing mission must win over a generic default, not lose to it
because the default sits in a more prominent message slot.

**R68 — a single-tool desk must FORCE its tool (`tool_choice`), never leave it on `auto`.** Live finding
(2026-06-16, from the admin LLM-call stream): the `god:curriculum` desk fired a burst of strong-tier (gpt-4o)
`proposeTask` calls ~7 s apart, each ~3000 tokens, "repeating itself" and producing no task. The journal showed
**54% of strong curriculum calls finishing `stop` with an empty `toolCalls`** — and the debug transcripts
(`.eden-data/llm/*.json`) showed exactly why: gpt-4o was *narrating* the `propose_task` arguments as a
```json``` block inside the assistant `content` instead of emitting a real tool call. `proposeTask` finds no
`propose_task` tool call → returns `undefined` → `RolloutCoordinator.runOnce` returns `undefined` → the
`VillageLoop` treats it as "curriculum proposed nothing," backs off `idleBackoffMs` (5 s), and retries the
**identical** context — getting the same narration. A 5 s spin burning the strong tier ~half the time, making
zero progress. The desk exposed its tools with the client default `tool_choice:'auto'`, which *permits* a
text-only turn; but the curriculum has exactly one job and one tool — there is no legitimate prose-only reply.
The critic (R52) already forces its `verdict` tool for this exact reason; the curriculum was the inconsistent
one. Fix (smallest correct): pass `toolChoice: { type:'function', function:{ name:'propose_task' } }` on the
`proposeTask` call and `{ …name:'decompose' }` on `decompose` (the `howTo` QA call has no tools — unchanged).
The client already supported the field (R52); this just uses it. Pinned by `tests/god-curriculum.test.ts`
(the request body pins `tool_choice` to the desk's one tool, never `auto`). Lesson: `tool_choice:'auto'` is a
*choice* — only correct when a text turn is a valid outcome. A desk whose entire purpose is to emit one
structured object must force that tool, or a chatty model will periodically answer in prose and any caller that
keys off "did a tool call come back?" will spin on the empty result. Diagnostic tell: same-desk LLM calls
repeating at your idle-backoff cadence with no downstream effect (no `god.task-proposed`, no `*.dispatch`) =
the desk is producing output the caller can't parse — read the transcript's `finish_reason`/`content` before
blaming the prompt.

**R69 — a SHARED, per-villager-stateless service must RESOLVE its per-villager dependency, never hold one
instance.** Report (2026-06-16): "villagers don't seem to be able to recall memory." The whole M6 memory
subsystem (`VillagerMemory`, summarizer, retrieval blend, R32 quarantine) was built and unit-tested, but
**orphaned in the composition root** — connected to nothing the brain uses. Two cuts, one root cause: (1) the
`ToolRegistry` is a SINGLE instance shared by all villagers (deliberation state lives in `ctx`, not the
registry), yet its memory option was typed `memory?: VillagerMemory` — a single store. `main.ts` never passed
it at all, so `recall`/`remember` always returned the `(mémoire non câblée)` stub; and even had it been
passed, one villager's memory would have served all ten. (2) Both `ContextPackInput` assembly sites (the
`RolloutCoordinator` authoring loop and the reactive-wakeup path) hardcoded `memories: []`, so the §6
`MÉMOIRE PERTINENTE` prompt section — explicitly labelled "Retrieved past (memory … full port M6)" — was
always empty. Net: the memory store was write-nothing/read-nothing except by the admin's relations readout.
Fix (smallest correct): the shared registry takes a RESOLVER `memoryFor?: (villager) => VillagerMemory |
undefined` and looks memory up per `ctx.villager` (the same shape `engine.resolveBot`/`snapshotFor` already
use); `main.ts` wires `(name) => memories.get(name)` and pre-loads §6 once per task from
`memory.retrieve(goal, k)`. Pinned by a `tests/villagers-tools.test.ts` regression: Firmin's `remember` is
invisible to Hortense through the same shared registry. Lesson: when a service is constructed ONCE but acts on
behalf of many identities (the identity arriving per-call in a context object), its collaborators must be
**resolved by that identity**, never injected as a single instance — and a subsystem with green unit tests is
not "done" until a `main.ts` wiring path actually reaches it. Diagnostic tell: a capability that "does
nothing" while its module's tests are green ⇒ grep the composition root for where it's constructed vs. where
it's consumed; an option that exists on the type but never appears at the `new X({…})` call site is a dead
wire.

**R70 — the autonomous loop must RESUME an open task, not propose a fresh one every turn; and the
curriculum's only cross-deliberation memory is the ledger, so a failed task must record WHY.** Follow-up to
R68 (2026-06-16): after the spin was fixed, God still proposed near-duplicate goals forever — the live
journal showed **18 tasks proposed, 2 completed, 0 ever closed `failed`, 14 unsuccessful verdicts**, and ~6
variants of "bake bread" all sitting open. Root cause is two compounding facts. (1) **No memory of past
deliberations:** each `proposeTask` is a stateless single-shot call; the desk reconstructs context from
`GodState` every time. The critiques that explain *why* a goal failed go to the villager's inbox + the
per-rollout `critiqueChain` — they never reach the curriculum. So God re-proposes a wall it has hit eight
times, blind to why. (2) **The R65 breaker was inert in production:** `RolloutCoordinator.runOnce` ALWAYS
called `proposeTask` (a new task id) every idle turn — it never resumed an open task — and the breaker is
keyed per task id, so no id was ever re-attempted, `noteExhausted` never reached its 2nd exhausted rollout,
and nothing closed `failed`. The failed-frontier signal that would steer proposals away stayed empty
precisely because the breaker that populates it never fired. Failures piled up as *open* duplicates. Fix
(two parts, smallest correct): (a) `runOnce` drains the backlog first — `curriculum.nextOpenTaskFor(villager)`
returns the oldest open, non-running task for that villager (FIFO; unassigned tasks claimable) and re-runs
that **same id**; on exhaustion `assignAndRun` clears the rollout pointer so the task is resumable next turn,
letting the breaker reach attempt 2 and fire. (b) `noteExhausted(task, lastCritique)` folds the last critique
into the close reason, persisted on `TaskRecord.reason`, and `renderProposalContext` renders the failed
frontier WITH each reason + an explicit "do not re-propose this without changing approach" guard — the
curriculum's memory of the obstacle, not just the goal. Pinned by `tests/god-curriculum.test.ts`
(`nextOpenTaskFor` selection; critique folded into the reason; the failed-frontier render) and
`tests/loop-integration.test.ts` (a non-converging task is RESUMED across `runOnce` — one proposal, not two —
and the breaker closes it `failed` through the real loop). Lesson: a give-up mechanism keyed on an id only
works if the same id is actually retried — an autonomous driver that mints a fresh id each turn silently
defeats it. And a planner with no conversational memory remembers only what you fold back into its context:
if "this failed because X" lives only in a sibling's inbox, the planner will propose X again forever.
Diagnostic tell: proposals climbing while `task-closed{failed}` stays at 0 and the open list accumulates
near-duplicate goals ⇒ the loop is proposing instead of resuming, and the breaker is starved.

**R71 — a thinking/reasoning model that defaults its reasoning ON must have it turned OFF, because Eden's
desks FORCE a single tool.** Live finding (2026-06-16): pointing the `deepseek` provider at the hybrid
`deepseek-v4-pro`/`deepseek-v4-flash` models made every rollout-driver turn die with `HTTP 400: {"message":
"Thinking mode does not support this tool_choice"}` — the village loop re-spun forever, zero progress. Root
cause: DeepSeek's v4 hybrid models default thinking mode ON (api-docs.deepseek.com/guides/thinking_mode), and
thinking mode rejects a forced `tool_choice`. But forcing the single tool is exactly Eden's design — R52
(critic→`verdict`) and R68 (curriculum→`propose_task`/`decompose`) make the desk call its one tool, never
narrate it. So thinking mode is structurally incompatible with the desks (and its reasoning tokens would only
burn the throughput budget, D-13). Fix (smallest correct): `LlmClient.chat` injects the top-level
`thinking:{type:'disabled'}` field for any DeepSeek endpoint, host-sniffed by `isDeepSeekBaseUrl`
(`*.deepseek.com`) — the same shape `isLocalBaseUrl` already uses to decide auth, because the behavior is a
property of the *endpoint*, not a user toggle. (Top-level is what the OpenAI SDK's `extra_body` puts on the
wire.) Pinned by `tests/llm-client.test.ts` (a DeepSeek base URL carries `thinking:{type:'disabled'}`; a
non-DeepSeek remote carries no `thinking` field — sending an unknown param to OpenAI would itself 400).
Lesson: when the orchestration design depends on forced tool calls, any reasoning model whose thinking mode is
default-on and tool-choice-incompatible must be normalized at the client seam, not left for each desk to
discover with a 400. Diagnostic tell: every desk call 400ing with a *parameter*-shaped message (`does not
support this tool_choice`, not an auth/rate message) ⇒ a provider-capability mismatch, fix it once at the
client, not per-caller.

**R72 — a clean run that makes no progress because a required INPUT is absent is BLOCKED, not buggy; the
critic must pivot the task, not drive endless revision.** Live finding (2026-06-16, follow-up to R70): a
farming run looped on `till-and-sow` "forever." The journal showed why — Harry's inventory was `iron_hoe×1`
and **zero `wheat_seeds`** (the village had consumed its seeds across the session and never learned to
harvest to replenish them). So `till-and-sow` ran cleanly and returned `{ok:true, tilled:0, sown:0}` — a
correct no-op — and the critic *correctly* failed it (zero world delta, R34), even diagnosing the cause in
prose ("the bot was never given wheat_seeds… seeds were consumed in a prior run"). But `success:false` means
`keep-draft` → REVISE, and the villager churned the skill v2→v5 fruitlessly: no code revision can conjure a
missing item. The critic's correct insight had nowhere to go — `Verdict.followUp` existed in the type but was
never emitted or acted on. Fix (smallest correct, wires the dead field end-to-end): the verdict gains
`blocked?:boolean` + a `followUp` TaskSuggestion (now with an optional `check`). The critic prompt teaches:
when a clean run made no progress *solely* because a required input is missing (not a wrong search, an
un-equipped tool, or a crash — those stay ordinary `keep-draft`), set `blocked:true`, `libraryAction:'none'`
(don't penalise a correct skill), and emit `followUp` = the task that ACQUIRES the resource (e.g. "Harvest
mature wheat to obtain wheat_seeds", `check:{item:'wheat_seeds',count:3}`). A deterministic rail forces a
blocked verdict to `success:false` and downgrades any admit/quarantine to `none`. The coordinator, on
`blocked`, STOPS the rollout immediately (no grinding the remaining retries — `revisions:1`, not 4), closes
the task `failed` with a `blocked-on-resource:` reason (feeds the R70 failed-frontier memory), and enqueues
the follow-up via `curriculum.addFollowUp`, which dedups against open + recently-failed goals so a
sow→harvest→sow pivot can't spawn duplicates or an endless chain. Pinned by `tests/god-critic.test.ts`
(blocked+followUp parsed; the rail; quarantine→none), `tests/god-curriculum.test.ts` (addFollowUp creates the
acquire-task + the anti-loop dedup), and `tests/loop-integration.test.ts` (★ R72: a blocked verdict fails fast
in one revision, closes the task, and the curriculum pivots to the acquire-task). Lesson: "the run didn't make
progress" has (at least) two causes — *the code is wrong* and *the world lacks an input the code needs* — and
they demand opposite responses (revise vs. acquire-then-retry). Collapsing both into `keep-draft` makes the
loop grind correct code against an impossible world. The judge that can tell them apart must also have a
channel to act on the difference. Residual gap: if the acquire-task is itself blocked (no mature wheat AND no
seeds — a truly bankrupt farm), the chain still needs an external seed source (grass drops, a chest, trade);
the dedup bounds the thrash but does not manufacture the resource.

## Reading failures (the debugging playbook, preserved)

- `act … FAILED after 0ms` → perception/availability check failed (thing absent or
  chunk unloaded) — not a real attempt.
- `… after ~30s` → pathfinder gave up (R6 bounds).
- `… after 45–120s` → the action wall-clock cap; suspect a stall upstream.
- Before declaring an operation "broken," grep the journal for ANY success of the
  same op across villagers/time — v1's playbook habit, now a journal query
  (`GET /journal?kinds=skill.run&…`).
- Simultaneous mass disconnects + server "Can't keep up! Running ~Nms behind"
  where N matches one of your timeouts = something blocked the *server or host*
  event loop that long. Look for synchronous work in-process, not network gremlins.
- A Java→Eden POST failing with `IOException: HTTP/1.1 header parser received no bytes`
  is NOT "connection refused" — the TCP connect SUCCEEDED, so something IS on the port;
  the peer closed the socket without writing a response. That's a process mid-restart/boot
  (or a wedged event loop), not an outage. Confirm: compare the command's timestamp to
  `/status` uptime and the journal's `system.boot` count — a boot a few seconds before the
  command (and no `scenario.start` row) means the request hit the restart window. The fix
  is operational (wait for the `Eden host up` log / a 200 from `/status`) ± a one-shot retry
  on the Java side.
