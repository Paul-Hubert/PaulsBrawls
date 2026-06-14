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
