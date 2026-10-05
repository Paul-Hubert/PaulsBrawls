# Eden — implementation progress

One dated section per session: what was done, decisions taken, what's next,
surprises. Newest first.

## 2026-06-16 — R66: fix the /villagers restart duplicate-login kick storm
- Symptom (from the live admin journal): a single bot (`Harry`) connect/kick-looped at ~1 Hz,
  reaching `system.bot-connected` every cycle BEFORE the kick, reason logged `kicked: [object Object]`.
- Root cause (two compounding bugs in [eden/src/bots/pool.ts](../eden/src/bots/pool.ts), set off by the
  restart race): `restart()` ([village-launch.ts](../eden/src/village-launch.ts)) calls `pool.stop()`
  (fire-and-forget `bot.quit()` — TCP FIN not yet processed) then immediately `pool.start()` (resets
  `stopping=false`, re-spawns). The fresh login overlaps the old session → server evicts one with
  `multiplayer.disconnect.duplicate_login` (the ONE-pool variant of R53). `onEnd`/`onSpawn`/`onDeath`
  looked up the record by **member NAME** — now pointing at the *replacement* bot — so the superseded
  instance's `kicked`/`end` clobbered its replacement's record and scheduled a phantom reconnect →
  self-inflicted storm; `onSpawn` reset `reconnectAttempts=0` each brief spawn so the backoff never
  climbed. The reason was destroyed because the 1.21 `kicked` payload is a chat-component OBJECT and
  `String(obj)` → `[object Object]`.
- Fix: every lifecycle listener closes over THIS bot instance; handlers are **identity-guarded**
  (`rec.bot !== bot → return`) so a superseded instance can neither mutate its successor's record nor
  reconnect. Added `formatEndReason`/`reasonText` (pulls `{text}`/`{value}`/`{translate}` out of chat
  components, JSON fallback) so a reason is never lost (S10).
- Tests: 2 new regressions in `tests/bots-pool-coverage.test.ts` (superseded kicked+end → no new bot,
  live record untouched; object reason renders `duplicate_login`, never `[object Object]`).
  `npm run check` green — **516/516**.
- Diagnostic tells filed in R66: a connect-storm reaching `bot-connected` every cycle is a duplicate-login
  eviction (post-spawn), NOT a login throttle (pre-spawn); `[object Object]` in a reason is always a
  stringified chat component.
- Next: **restart the real host** (`tsx src/main.ts eden.json`; pm2 is currently empty) to pick up the
  fix — the storming host was already stopped on the interrupt.

## 2026-06-16 — bread-economy skill pipeline + runtime library dedup
- Done: collapsed the live runs' farming-skill sprawl into ONE canonical skill per action,
  composed into find→act pairs, then a single loop — all as **stock skills** in
  [eden/src/skills/exemplars/index.ts](../eden/src/skills/exemplars/index.ts) (seeded `active`,
  so immediately composable; CI-validated against FakeBot; survive data-dir wipes):
  - finds (return `{found,…}`, never throw — caller branches): **find-till-spot** (dirt near
    water, bounded 9×9×2 hydration-box scan around a found water block — never the blind grid
    flood find-block warns against), **find-harvestable-plant** (mature crop by block.metadata
    age; no-metadata fakes/servers treated as grown), **find-crafting-table**.
  - actions (one world effect): **harvest-plant** (refuses a non-crop block), **pickup-drops**
    (walk onto item entities — gap E), **make-bread** (3 wheat → table-gated craft), **store-in-chest**
    (nearest-chest fallback). The atomic till/sow stay the existing **till-block/sow-seed** (R55) —
    reused, NOT re-minted (the whole dedup point).
  - pairs: **till-spot-near-water** (find-till-spot→till-block), **harvest-nearby-crop**
    (find→harvest→pickup). Loop: **tend-bread-farm** sequences every pair (harvest+replant OR
    till+sow near water; bake when wheat≥threshold; stash loaves), per-cycle `sleep` keeps the
    macrotask queue draining (gap W) and `ctx.signal` exits cleanly on preempt/stall.
  - 11 new exemplar tests in skills-exemplars.test.ts; `npm run check` green (lint/tsc/depcruise
    clean, **514/514**).
  - **Runtime library deduped**: pruned `.eden-data/library/` from 173 → 27 dirs (146 LLM-churn
    authored duplicates removed: 8 "dirt-near-water" finders, a dozen till-and-plant rows, the
    place-chest-deposit-bread wrappers, debug/diag/inspect scratch skills, collect_nearby_oak_logs,
    …). Full reversible backup at `.eden-data/library-backup-20260616-051327.tar.gz`. The 10 new
    skills seed on next host boot. **Restart the host to reload the pruned library + seed them.**
- Decisions (D#/R# if any): no new D/R minted. Portability lesson (candidate R): a stock/exemplar
  skill must use `Math.hypot(...)` for distances, NOT `bot.entity.position.distanceTo(...)` — the
  latter is a real-mineflayer Vec3 method ABSENT on FakeBot's plain `{x,y,z}` position, so it
  throws only when a composition path reaches it (craft-item's table-distance branch had it; the
  existing craft-item test never set a table block so never hit it — make-bread did). Fixed
  craft-item to Math.hypot (identical on real mineflayer, FakeBot-safe; matches go-to/till-block).
  kill-mob has the same latent `distanceTo` (untested in CI, works on real) — left as-is, noted.
- Next: smoke the bread loop on the live server (`npm run live-test`) — the FakeBot craft seam
  doesn't mint a named `bread`, so make-bread/store-in-chest end-to-end is only proven live.
- Surprises: none — the dedup made the latent craft-item portability gap finally testable.

## 2026-06-16 — steer villagers to COMPOSE skills, not write monolithic ones (P1/P2/P3/P5)
- **Why:** the composition *mechanism* is complete (`ctx.skills.run`, depth cap 8, cycle detection, the
  exemplars themselves compose — `craft-item`→`go-to`, `use-chest`→`go-to`, `deposit`→`use-chest`), but nothing
  proactively told a villager to PREFER reuse. Drafts came out long/monolithic and only hit a nudge when they
  blew the `maxSkillLines=400` hard cap (reactive, and most skills never reach it). docs/02 §power-ceiling
  already *specced* an authoring-prompt rule ("compose go-to/craft-item, do not hand-roll") that was never built.
- **Change (prompt/data + doctrine only — no engine change, no dependency-law risk):**
  - **P1 — authoring doctrine** in [eden/src/villagers/context-pack.ts](../eden/src/villagers/context-pack.ts)
    `renderCapabilities`: on an authoring wake-up (`includeExemplarCode`) it now prints a "Composer plutôt que
    copier" block with the explicit `await ctx.skills.run('go-to', {…})` call shape, and reframes the retrieved
    list header to "Compétences réutilisables — exécute-les avec run_skill, ou compose-les … avec ctx.skills.run".
    The doctrine states the structural truth that a callee must already be in the library (active /
    active-probation) — you cannot compose a draft authored the same turn — so the model doesn't waste tool turns.
  - **P2 — the primitive palette** (same `renderCapabilities`, wired through [eden/src/main.ts](../eden/src/main.ts)):
    every MORTAL non-exemplar stock skill is rendered as a `name — signature — summary` one-liner under "Briques
    de base toujours disponibles (compose-les avec ctx.skills.run)" on authoring packs, deduped vs the exemplar
    set (shown as full code) and the retrieved one-liners. Signatures come from `renderSignature` (D-04, generated
    from schemas). This closes R61's blind spot: when goal-retrieval ranks none of `go-to`/`craft-item`/`use-chest`,
    the villager still sees the base vocabulary instead of re-implementing it. `RolloutCoordinatorOptions` gains an
    optional `primitives` (absent → no palette, so M3/M4 tests are unchanged); `assignAndRun` passes it.
  - **P3 — critic teaches it** ([eden/src/god/prompts/critic.md](../eden/src/god/prompts/critic.md)): a new
    "Prefer composition over re-implementation" rule — the instructive critique for hand-rolled behavior is
    "replace lines X–Y with `ctx.skills.run('<skill>', …)`", and a long inlined skill is flagged for decomposition.
  - **P5 — curriculum decomposes** ([eden/src/god/prompts/curriculum.md](../eden/src/god/prompts/curriculum.md)):
    a "Decompose big goals into composable steps" rule + a strengthened `decompose` tool line — a goal that would
    force one long multi-step skill is the signal to `decompose` into sub-tasks that each grow ONE composable skill.
- **Why P5 over "let villagers split a skill mid-rollout":** the engine's composer resolves callees via
  `readRunnable` (active/active-probation only), so a freshly-authored draft helper is not composable in the same
  rollout. The architecture-sanctioned path to "split a big thing" is curriculum `decompose` across rollouts.
- **Not touched (deliberate):** the D-12 probation-before-composition rail — a just-admitted skill isn't composable
  for `probationRuns=3` runs. It's an owner decision (one of the three D-12 rails) and self-heals via
  `recordProbationRun`; left as a known, documented tension, not relitigated.
- **Tests (golden, S6):** `tests/villagers-context-pack.test.ts` (authoring carries the doctrine + call shape;
  P2 palette renders + dedupes vs exemplars/retrieved; reactive omits both), `tests/god-critic.test.ts`
  (`/compos/i` + `ctx.skills.run`), `tests/god-curriculum.test.ts` (`/decompose/` + `/compos/i`),
  `tests/loop-integration.test.ts` (retrieved-skills header rename). `npm run check` green (lint + tsc +
  dependency-cruiser clean, all node:test tests pass).
- **D2 — verify the world effect before returning success (R64, authoring doctrine):** the live journal showed
  drafts self-reporting `{ ok: true }` the world contradicted — a chest-"deposit" reported `placed:true` after
  consuming 8 planks but placed no chest; another "succeeded" by depositing PRE-EXISTING bread, not bread it
  crafted this run. God's critic catches these by world-delta (the D-12 check-veto rail, R34), but each false
  success burns a full author→run→judge→revise cycle. Fix (prompt/data only, same altitude as the composition
  doctrine above — the engine can't know task semantics, only the critic can): the authoring wake-up in
  `renderCapabilities` (the `includeExemplarCode` block) now prints a "VÉRIFIE avant de réussir" rule — re-read
  real world state (`bot.blockAt(pos)` to confirm a placed block/container; compare an item count BEFORE vs
  AFTER to attribute the gain to THIS run), never succeed from a precondition that already held or a call that
  only attempted the action, return `{ ok: false, error }` otherwise. The `write_skill` tool description carries
  the same clause. `critic.md` already states the world-delta rule (lines 14-18) — left untouched. Pinned by the
  new `M3-1 (§7)` assertions in `tests/villagers-context-pack.test.ts`.
- **Next:** a funded live re-run — confirm authored drafts now call `ctx.skills.run` for known steps instead of
  re-implementing movement/crafting, that mean authored-skill length drops, and that the false-success draft
  RATE falls (fewer critic world-delta vetoes per admitted skill).

## 2026-06-16 — skill ctx had no `mcData`; stock registry lookups unguarded (D1/R62)
- **Symptom (from the live journal):** authored skills crashed on real mineflayer with `TypeError: Cannot read
  properties of undefined (reading 'itemsByName')` / `(reading 'id')`.
- **Root cause (D1, two coupled bugs):** (1) the injected `SkillContext` exposed **no `mcData`** handle, yet
  the LLM writes the idiomatic `ctx.mcData.itemsByName[name].id` / `mcData.blocksByName[...]` — so it
  dereferenced `undefined`; (2) the STOCK skills did `bot.registry.itemsByName[name].id` **unguarded**, so an
  unknown item name threw the same cryptic `reading 'id'` instead of a named error. The "ctx-lockstep" class
  the CLAUDE.md gotchas warn about (sibling of Z/C/E).
- **Fix (minimal, S3 — no new module):**
  - [eden/src/skills/engine.ts](../eden/src/skills/engine.ts): `makeCtx` now sets `mcData: bot.registry` (the
    real `bot.registry` IS the prismarine-registry / minecraft-data instance); `SkillContext` gains a
    doc-commented `mcData: ItemRegistry | undefined`.
  - [eden/src/types/bot.ts](../eden/src/types/bot.ts): `ItemRegistry` gains optional `blocksByName` (a real
    mineflayer field; one source of truth for the ctx type).
  - [eden/src/skills/exemplars/index.ts](../eden/src/skills/exemplars/index.ts): a file-local inlined
    `itemId(bot, name)` guard (`ITEM_ID_HELPER`) routes the five unguarded lookups (`use-chest` ×2,
    `smelt-item` ×2, `place-item`, and `craft-item`) and throws `unknown item "<name>" — not in
    bot.registry.itemsByName (D1)` (S10). Inlined into each isolated JS skill string (a TS helper isn't in
    scope inside them), NOT exported.
  - [eden/tests/fakes/fake-bot.ts](../eden/tests/fakes/fake-bot.ts): a `blocksByName` Proxy + a
    `setUnknownItems()` seam so the named-error path is testable without a server.
- **Decisions (R#):** R62 (give ctx an `mcData` handle + NAME every registry-lookup failure — the field skills
  are told they can call must move in lockstep with the runtime ctx object).
- **Tests:** `tests/skills-engine.test.ts` — `D1: ctx.mcData exposes the bot registry…` (resolves a real
  numeric id), `D1: a stock registry lookup of an unknown item fails with a NAMED error…`. `npm run check`
  green (499 tests; lint + tsc + dependency-cruiser clean).
- **Next:** a funded live re-run — confirm authored skills no longer hit the `itemsByName`/`id` crash and that
  an LLM-written `ctx.mcData...` resolves.
- **D4 (same session) — stock container/crafting skills now self-apply the R1–R3 window discipline (R63):**
  - **Symptom (journal):** every chest/furnace/table interaction wasted ~20–22 s and sometimes wedged with
    `Error: Event windowOpen did not fire within timeout of 20000ms`.
  - **Root cause:** the window-opening stock skills (`use-chest`, `smelt-item`, `craft-item`) did not all
    close a stray `bot.currentWindow` first (R1 — a left-open window makes the next open hang/hijack), pause
    auto-eat/armor (R3), and close in a `finally` on every exit (R4–R5).
  - **Fix (S3/S5 — no new module):** a file-local inlined `CONTAINER_SAFE_HELPERS` snippet in
    [eden/src/skills/exemplars/index.ts](../eden/src/skills/exemplars/index.ts) (sibling of D1's
    `ITEM_ID_HELPER`) — `safeCloseStray` (close `currentWindow` + yield a macrotask so the close lands before
    the open), and guarded `pauseMutators`/`resumeMutators` using the canonical
    `bot.autoEat?.disableAuto()`/`enableAuto()` + `bot.armorManager?.pause?.()`/`resume?.()` API,
    `&&`/`?.`-guarded so an absent plugin is a no-op, never a throw. Prepended into `use-chest`, `smelt-item`,
    `craft-item`; called before each open and in the `finally`. Authored skills inherit the discipline because
    they reach containers THROUGH these primitives (P2).
  - **Tests:** `tests/skills-exemplars.test.ts` — `D4/R1: use-chest CLOSES a stray window before opening the
    container`; `D4/R3: use-chest pause/resume is GUARDED — no throw when auto-eat/armor are absent`.
    `npm run check` green (501 tests; lint + tsc + dependency-cruiser clean — see note re: 2 pre-existing R61
    prompt-text failures, unrelated to D4).
  - **Decisions (R#):** R63.
- **D3 (same session) — curriculum now gives up on an unconvergeable task instead of re-proposing it forever (R65):**
  - **Symptom (journal):** one hard, over-bundled, resource-gated task ("Place a chest by the 3×3 wheat plot and
    store the first loaf of bread") was attempted **13 times across ~3–4 rollouts in 21 minutes, never admitted**
    — ~16 min of LLM, ~115k completion tokens, ZERO progress. Half the failures were unmet PRECONDITIONS
    (`planches insuffisantes`, `bois/planche manquants`, "no 3×3 irrigated farmland found") that rewriting skill
    CODE can never satisfy.
  - **Root cause:** the rollout loop runs `for (i = 0; i < task.maxRetries; i++)` (DEFAULT_MAX_RETRIES = 4); when
    it exhausts retries WITHOUT converging, `assignAndRun` just stopped looping and **left the task open** — so the
    next `runOnce` re-attempted the IDENTICAL task with a fresh maxRetries budget, indefinitely. The R33–R37
    anti-pattern: an engine silently re-proposing the same wall, not a SIGNAL that changes the task.
  - **Fix (the convergence breaker, smallest correct change — no new module, no new journal kind):**
    - [eden/src/god/curriculum.ts](../eden/src/god/curriculum.ts): the curriculum (sole ledger writer — S2)
      tracks a per-task `exhaustedRollouts` count; new `noteExhausted(task)` increments it and, at
      `MAX_ROLLOUT_ATTEMPTS = 2` (a named constant by DEFAULT_MAX_RETRIES), CLOSES the task `failed` with a
      blocked reason naming the task + attempt count (S10). `closeTask` gained an optional `reason?` arg.
    - [eden/src/main.ts](../eden/src/main.ts) `RolloutCoordinator.assignAndRun`: on every `converged:false`
      return it now calls `curriculum.noteExhausted(task)` (and closes the task's open directive `expired` +
      clears divine-assist — previously LEAKED on the non-converged path, which could block the next task's
      directive under the orchestrator anti-thrash rule).
    - [eden/src/journal/kinds.ts](../eden/src/journal/kinds.ts): `god.task-closed` gained an optional
      `reason?: string` (a one-field extension, NOT a new kind) so the give-up is observable.
    - The task leaves `ledger.open` → lands in `ledger.failed` (a frontier signal steering the next proposal
      AWAY) → the village moves on. Below the threshold the task stays open and retries unchanged; a converging
      task still closes `completed` normally.
  - **Future hook (NOT this change):** a blocked over-bundled task is a natural `decompose()` candidate — left to
    the curriculum's existing decomposition entrypoint.
  - **Tests:** `tests/god-curriculum.test.ts` — R65 breaker fires after K (named reason, stays closed, no
    double-close), within-budget retry leaves it open, a converging task closes `completed` untouched.
  - **Decisions (R#):** R65.

## 2026-06-16 — pre-populate `retrievedSkills` in deliberations (R61): wire the retriever into both paths
- **Why:** R60's deeper follow-up. The rollout (`assignAndRun`) + reactive (`WakeupFn`) context packs shipped
  `retrievedSkills: []`, so a villager's only way to find the (~180-skill) library was the read-only
  `search_skills` tool — which a reasoning model loops on (R60). The breaker stops the loop but the villager
  still starts blind. Voyager-correct fix: relevant skills as `name — signature — summary` one-liners IN the
  prompt (docs/02 §Retrieval, owner #8/#10).
- **Change (pure wiring, [eden/src/main.ts](../eden/src/main.ts)):** (1) `RolloutCoordinatorOptions` gains an
  OPTIONAL `retriever?: SkillRetriever` (absent → `[]`, so M3/M4/gate/loop tests are unchanged). (2)
  `assignAndRun` retrieves the top-k (k=10) relevant *live* skills **ONCE per task** (query = `task.goal`)
  BEFORE the revision loop, filters out exemplar-named skills (they ride as full code already), and passes them
  as `retrievedSkills`. Retrieve once, never per-revision: the library barely changes within a rollout, a fresh
  draft is `draft` status (not retrievable), and re-querying would bloat the never-trimmed density payload
  (D-11). (3) the reactive `WakeupFn` retrieves top-k (k=8) for `triggers + hints` (fast tier,
  `includeExemplarCode:false` → the one-liners are its main skill signal). (4) `retriever` passed at coordinator
  construction.
- **Decisions (R#):** R61 (pre-load relevant skills into the prompt; don't make the model discover the library
  by searching). The R60 circuit breaker STAYS as the backstop — this reduces the NEED to search.
- **Tests:** `tests/loop-integration.test.ts` — rollout path (seeded `active` skill surfaces as a one-liner +
  exemplar-dedup), reactive path (trigger+hint query), no-retriever backward-compat. `npm run check` green
  (497 tests, lint + tsc + dependency-cruiser clean).
- **Next:** a funded live run — confirm transcripts (`.eden-data/llm/*.json`) show write_skill/run_skill within
  the first 1–2 turns (search_skills rare/absent) and the §CAPACITÉS section listing relevant skills.

## 2026-06-16 — villagers looped on search_skills forever (R60): circuit breaker + steering
- **Symptom (from `.eden-data/llm/*.json`):** `harry` (farmer, strong tier = `gpt-5`) got "Craft a wooden
  hoe" and fired `search_skills` every turn (find-block → craft-item+go-to → collect-blocks →
  place-item+till-block …) at 2–3k reasoning tokens/turn, never reaching write/run, hitting the 16-turn
  ceiling. Old healthy transcripts converged write→run→done — their directive literally said "Écris
  (write_skill) …" and used a non-reasoning model; the natural-language directive + reasoning model removed
  both guardrails.
- **Root cause (R60):** `search_skills` (read-only discovery) had no per-deliberation budget, and the rollout
  context pack ships `retrievedSkills: []` (main.ts:879/637) so the villager has nothing in-prompt and is
  *forced* to discover the library by searching.
- **Fix:** (1) brain **circuit breaker** ([eden/src/villagers/brain.ts](../eden/src/villagers/brain.ts)) —
  after `SEARCH_CALL_CAP=3` searches, **withdraw** `search_skills` from the offered tools for the rest of the
  wake-up + inject a one-time forcing message; (2) prompt **steering** in the capabilities section
  ([eden/src/villagers/context-pack.ts](../eden/src/villagers/context-pack.ts)). Test drives a 4-turn
  search-spam script and asserts the tool is gone from later requests + the deliberation reaches `done`.
- **Decisions (R#):** R60 (every again-able affordance an autonomous loop has needs a release-valved ceiling
  — sibling of R36 rate cap + the W loop-budget).
- **Deeper follow-up (NOT done):** populate `retrievedSkills` with top-k skills for the directive (Voyager
  design) so villagers don't *need* to search — cuts the looping at the source + improves reuse over the
  ~180-skill churned library. Needs a retriever wired into the rollout path.
- **Next:** restart host; watch transcripts for write/run within the first 1–2 turns.

## 2026-06-16 — embeddings 401'd to keyword floor every run (R59): default to the local model
- **Symptom:** `embeddings  WARN … 3 consecutive failures — degrading to the keyword floor (R38): HTTP 401`,
  every run. Semantic retrieval silently off → fed the R57 duplicate-skill churn.
- **Root cause (R59):** main.ts wired `EmbeddingsService` to the **fast CHAT provider** —
  `providerBackend(fast.baseUrl, fast.model)` POSTed `gpt-5.4-mini` to `https://api.openai.com/v1/embeddings`
  with **no `Authorization` header**. Three faults: no auth, chat model ≠ embedding model, and the documented
  default (local in-process MiniLM) was only used when the chat provider had no baseUrl (never, on a remote
  LLM).
- **Fix (owner chose local embeddings):** `backend: localBackend()` unconditionally
  ([eden/src/main.ts](../eden/src/main.ts)) — no key, no HTTP, no 401. Added the missing
  **`@xenova/transformers`** dep (smoke-tested: 384-dim vectors, ~12 s first run incl. ~120 MB model
  download, cached after). Fixed `providerBackend` to send a Bearer header + documented it as an explicit
  opt-in (never the chat provider). With local embeddings now ON, **R58's vector cache is the load-bearing
  loop-lag guard** (uncached, retrieval would do O(library) synchronous ONNX inferences per wake-up).
- **Decisions (R#):** R59. Note: first retrieval after boot still embeds the whole live set once (cold
  cache); worker-thread inference remains the long-term home (D-01 escape hatch). Consider pruning the
  churned ~180-skill library before the next run so the cold-start embed is small.
- **Next:** restart host; watch for the keyword-floor WARN to disappear and loop-lag after warm-up.

## 2026-06-16 — probation never graduated (R57) + retriever re-embedded the whole library (R58)
- **Symptom:** "after running a full skill with success, farmers immediately stop doing anything forever."
  Diagnosed from the live `eden/.eden-data/eden.db` (last session, farming-hamlet 3-villager scenario).
- **Root cause #1 (R57) — D-12 probation graduation had no runtime caller.** `SkillLibrary.recordProbationRun`
  (the only path that decrements `probationRunsLeft` → graduates `active-probation → active`) was invoked
  ONLY from its unit test, called directly — never from the loop. So every admitted skill stayed
  `active-probation` forever, the engine's `ProbationError` refused it as a composition callee forever, and
  Firmin/Margot churned re-authoring wrappers around the just-admitted skill until the tool-turn ceiling
  (20 distinct skills drafted in one session; admitted skills got 4 clean direct root runs that should have
  graduated them at 3). Fix: wire `recordProbationRun(name, ok)` at the engine's root-run completion
  ([eden/src/skills/engine.ts](../eden/src/skills/engine.ts)), gated on the version that actually ran being
  probationary (a draft trial never advances an older live-probation version).
- **Root cause #2 (R58) — `SkillRetriever.search` re-embedded `[query, ...EVERY live skill]`** through the
  in-process ONNX model on every deliberation (O(library) synchronous inferences). Compounded by R57's churn
  bloating the library to ~180 skills, this is the `system.loop-lag max≈2166ms` (p99 35ms) stalls. Fix:
  cache skill vectors by `name@version` (+text, for the late description pass), FIFO-bounded
  ([eden/src/skills/retrieve.ts](../eden/src/skills/retrieve.ts)) — a search now embeds only the query +
  changed skills.
- **Decisions (R#):** R57 (a state machine with no runtime caller for its advancing transition is a
  deadlock; pin via the real path, not a direct call), R58 (cache per-item embeddings by an immutable key;
  never recompute in the hot path). Honest limit recorded: R57 graduation is run-counting, NOT critic
  re-judgment — the "auto-ticket the first 3 production runs for re-review" of [03-god.md](03-god.md) is
  still unbuilt; behavior matches the 02 state machine.
- **Tests:** graduation via `engine.run` ×3 + failed-run-never-graduates (skills-engine.test.ts); retriever
  cache hit + re-described re-embed (skills-retrieve.test.ts). `npm run check` green (493/493;
  lint/typecheck/depcruise clean). Host must be RESTARTED to pick up the fix.
- **Next:** live re-run of farming-hamlet to confirm skills graduate, compositions succeed, loop-lag
  subsides; if lag persists, move embedding inference to a worker thread (D-01 escape hatch).
- **Surprises:** the existing D-12 unit test was GREEN the whole time — it called `recordProbationRun`
  directly, masking that nothing in the runtime did.

## 2026-06-15 — stock confirmed-till/sow primitive (R55: the read-after-write race)

- **Symptom:** in the live farming-hamlet, `till-and-plant` kept emitting `"Le labour n'a pas
  fonctionné (bloc pas devenu farmland)"`. The farmers churned **16+ versions** + a dozen sibling
  tilling skills without converging.
- **Diagnosis (journal, P4):** a read-after-write race, not a tilling failure. `bot.activateBlock`
  resolves when the use-item packet is SENT; the dirt→farmland flip only lands ~1+ tick later when the
  server's block-update refreshes the local chunk. A controlled split confirmed it — versions reading
  `blockAt()` synchronously (v10/v11) false-reported failure on blocks they had actually tilled (the
  whole patch was already farmland; Margot's waiting v13/v14 succeeded). Secondary: candidate-finders
  using `dy ∈ {0,-1}` also targeted buried dirt (no air above → genuinely untillable) and produced the
  `"…mais dirt"` variants. CI never caught it: FakeBot had no `activateBlock` and flipped no blocks
  (the Z/C/E "stock skill wrong on real mineflayer" class), and there was no stock till primitive — so
  the loop re-derived the race every time.
- **Done:** seeded two mortal stock primitives (single-block grain, like `mine-block`):
  **`till-block`** and **`sow-seed`** ([eden/src/skills/exemplars/index.ts](../eden/src/skills/exemplars/index.ts))
  — equip → (go-to if far) → `activateBlock` → **poll `blockAt` until the server confirms, or time
  out** with an error naming the likely cause. Both enforce the two Minecraft rules villagers missed
  (air directly above; target the surface, not a buried block) and are idempotent on already-tilled
  ground. FakeBot now models `equip` + `activateBlock` with a **delayed** transition
  (`setActivateDelayMs`) so the race is reproducible in CI; 5 new exemplar tests pin the wait, the
  buried-block guard, and the sow path. `npm run check` green.
- **Decisions (D#/R# if any):** **R55** filed (07 §World interaction). No new D#, no journal kind,
  no `Bot`-seam change (skill bodies are runtime strings; only FakeBot grew, additively).
- **Next:** restart the live host to pick up the seeded primitives; nudge the curriculum/godPrompt to
  compose `till-block`/`sow-seed` so the farmers stop reinventing tilling. Re-run farming-hamlet.
- **Surprises:** the failing skills had mostly *succeeded* server-side — the field was full of
  farmland the journal logged as "n'a pas fonctionné." A counter would have called these futile; only
  reading the world (RCON/journal ground truth) showed the tills landed.

## 2026-06-15 — the autonomous loop driver (R54: the production PUMP was never wired)

- **Live report:** `/villagers start farming-hamlet` connected all 4 bots (R53 fix held) but **nobody
  moved and no LLM calls were made.** `/status`: `botsConnected:4, currentRuns:0, queueDepth:0,
  budgetSpend:0, paused:false`. The journal had only `vitals` + Bertrand's `hurt`→`defend-self` reflex
  (M5 reactivity alive) — **zero** `brain.wakeup`/`god.task-proposed`/`directive`/`god.verdict`/`llm.call`.
- **Diagnosis (R54):** the M4-3 refinement loop was built, integration-tested, and live-tested — but
  `RolloutCoordinator.runOnce()` was only ever called by `tests/` and the live-test `harness.ts`
  (`god.addTask` → `coordinator.assignAndRun`). **The interactive boot path had no driver.** `wireGod`
  *constructs* the coordinator and `main.ts` *exposes* it on the host handle, but nothing pumped it:
  `/villagers start` (the launcher) connects bots + fires loadout, and NO admin route calls the
  coordinator. So curriculum never proposed a task → no directive → no deliberation → idle village.
  The GATE test and the harness had silently stood in for the production pump since M3.
- **Fix — `VillageLoop` (main.ts, owner-chosen "autonomous, all villagers"):** one independent loop per
  villager — wait for the body (`pool.bot(name)`), settle, then `runOnce({trigger:'idle', villager})`
  forever. Lives at the composition root next to `RolloutCoordinator` (it consumes a layer-3-spanning
  peer — the dependency law). Cross-villager concurrency is bounded DOWNSTREAM by the LLM scheduler
  (`maxConcurrent`) + per-bot serialization in the engine (D-05), so N loops never overrun the throughput
  ceiling (D-13/R49). Lifecycle tied to the launcher: `start()` on `/villagers start|restart`, `stop()` on
  `/villagers stop` + host shutdown. **NOT** started on `autoSpawn` — the live-test harness drives the
  coordinator itself, so it stays un-pumped there (live-tests + the 481-test gate unaffected).
- **Surprise (W bit again):** the first cut spun a CPU core flat (166 CPU-s in the unit test). The
  drive loop only `await`ed a back-off on a *no-proposal* turn; on success it re-looped via a microtask,
  and because the test's fake `runOnce` resolved synchronously the loop became a microtask spin that
  **starved every timer** — finding W (macrotask starvation), now re-bitten in the driver. Fix: **every**
  turn ends with an unconditional awaited `sleep()` macrotask (normal `turnDelayMs` pacing on success, a
  longer `idleBackoffMs` on no-proposal/error). In production `runOnce` always awaits real network I/O, but
  a fully budget-degraded zero-LLM path could resolve sync — the unconditional yield is the guard.
- **Tests:** `tests/village-loop.test.ts` (5) — per-connected-villager driving, disconnected skipped,
  clean stop, idempotent start, thrown-rollout survival. Full `npm run check` green (481 pass, 0 fail).
- **Next:** reboot the running host to pick this up (pm2 restart) — then `/villagers start farming-hamlet`
  drives the loop. The formal smoke/parity sign-off (docs/17) is still the open step.

## 2026-06-15 — `/villagers start` deferred-spawn fix (R53: one pool, no duplicate avatar)

- Diagnosed a live report: `/villagers start farming-hamlet` returned "Eden unreachable …
  `HTTP/1.1 header parser received no bytes`". Two findings:
  - **The error itself was a restart race** (transient): the POST hit Eden ~3 s into a process
    restart (journal `system.boot` 3 s before the command; no `scenario.start` row → the request
    never reached the handler). Captured as a diagnostic-playbook bullet in 07 ("received no bytes"
    ≠ "connection refused"). `/status` answered 200 throughout once the process was up.
  - **A real bug it masked (R53):** the old `ScenarioManager` created a SECOND `BotPool` that ALSO
    spawned the avatar, while the boot pool's `Dieu` was already connected → an endless duplicate-login
    kick loop (~1×/s). And `wireGod` binds once at boot to `config.villagers` + the boot pool, so the
    second pool's villagers were never God/reactivity-wired (inert).
- **Fix (owner-chosen option C — one pool, deferred spawn):**
  - `main.ts` builds the boot pool ONLY when there's a roster (`config.villagers.length > 0`), so a
    bare boot connects nothing (the avatar never auto-logs-in). The scenario is loaded at boot
    (`config.scenario` → `applyScenario` before `wireGod`), so God + reactivity bind to its roster.
  - Spawn is DEFERRED: bots connect only on the in-game `/villagers start`, which starts the
    already-wired boot pool via the new **`VillageLauncher`** (deletes the separate-pool
    `ScenarioManager`). New boot opt-in **`autoSpawn`** for boot-then-act drivers (the live-test
    harness sets it; the real entrypoint does not).
  - `BotPool.start()` clears `stopping` so the reused pool survives stop→start (restart).
- Tests: new `tests/village-launch.test.ts` (start/stop/restart, name-vs-scenario guard, once-per-start
  setup, reconnect = no re-give); removed `scenario-manager.test.ts`. `npm run check` green
  (lint/typecheck/depcruise clean, 476/476).
- Decisions (D#/R# if any): **R53** (07). No new D#, no new journal kind (S1).
- Next: user sets `"scenario": "farming-hamlet"` in eden.json + reboots, then `/villagers start
  farming-hamlet` in-game (single `Dieu`, fully wired). Optional follow-up: a one-shot Java-side retry
  on the transient boot-race `IOException`.
- Surprises: the in-game scenario-start path had been spawning a second, un-wired pool all along — the
  kick loop only made it visible.

## 2026-06-15 — live smoke of the real admin API + dashboard (code review + farm-wheat)

- **Task A — code review of the website→live-API changeset:**
  - `journal.ts` order × limit logic — **correct**. DESC-scan + LIMIT selects the most-recent N; the
    `scanDesc` flip ensures both `asc+limit` (reverse after scan) and `desc+limit` (leave in place)
    work. `MemoryJournal` matches (tested independently in `admin.test.ts`).
  - `server.ts` traversal guard — **correct**. `resolve()` + `full.startsWith(root + sep)` is the
    authoritative defence; `decodeURIComponent` before `resolve()` doesn't open an escape vector
    because `resolve()` normalises `..` segments and URL pathname normalisation removes `/../`. API
    routes and `/journal/stream` upgrades take priority over the static fallback (switch-first ordering).
  - `main.ts` accessors — **no blocking shape mismatches**. Already-fixed `vitals:null` bug is the
    key sibling; `dossier`, `relations`, `subscriptions`, `stats`, `versions` all return safe empty
    structures when unwired. `note: h.manifest.summary` in version history can be `undefined` for
    non-admitted skills — low risk (screens render nothing rather than crashing).
  - `api.js` — **no blocking issues**. `expandKinds` empty-array fast-path, `domainOf` bare-kind
    table (`vitals`→world, `inbox.delivered`→social), and WebSocket reconnect/`setConnected` semantics
    are all correct. The `KINDS.length` comparison for "all domains → no filter" is correct for the
    current registry (low-risk edge case if the server gains unregistered kinds after the async
    `/kinds` augmentation, but benign in practice).
- **Task B — `npm run check`:** fixed two pre-existing failures + one lint error in `anchors.ts`
  (the M5-wired branch had a stale `AnchorInput {}` empty-interface and `bot.entity` null-check
  errors; also, anchor behaviour diverged from tests — persisted chest was being re-validated against
  the live world when it should be trusted unconditionally, and the home-scan fallback was emitting an
  extra warning). **444/444 green** after fixes.
- **Task C — farm-wheat live smoke (real server + real LLM + real mineflayer):**
  - **PASS** in 297 s on OpenAI `gpt-4o` / `gpt-4o-mini`. Firmin holds **14/3 wheat**; **5 ok runs**
    of `harvest-wheat`; 0 `system.error`, 0 deaths.
  - Timeline (key journal events): `god.task-proposed` → `brain.wakeup` → `skill.draft{harvest-wheat
    v1}` at +13.5 s → two stalled runs (20 s stall cap) → `find-block ok` → v2 drafted at +107.7 s →
    three ok harvests → `god.verdict{success:false}` at +173.2 s (real critique: "add pickup mechanism")
    → v3 drafted → one ok harvest → verdicts 2/3/4 all `keep-draft` (see R52 below) → task exhausted
    maxRetries=5; `converged:false` but objective satisfied.
  - **Admin API live proof** (all via `http://127.0.0.1:8770/`): `GET /status` → `botsConnected:2,
    totalBots:2, uptime:62s`; `GET /villagers` → Firmin with real `vitals{hp:20, pos:[1,199,1]}`, 6
    subscriptions armed, `activityKind:llm.call`; `GET /skills` → 25 active skills (16 mortal + 9
    divine); `GET /rollouts` → `harvest-wheat, villager:Firmin, status:open`; `GET /journal` → live
    stream of `brain.tool-call → skill.run → vitals` events. **All API shapes matched; no 500s; no
    console errors; `api.js` envelope-unwrapping verified end-to-end.**
  - `skill.admit` not captured (noted `·` in test report) — blocked by R52 (see below). The skill
    ran successfully; the critic's second call returned a `success:true, admit` judgment in markdown
    bullets that `parseContentJson` can't parse, silently degrading to `keep-draft`.
- **New pitfall — R52** (filed in [07](07-hard-won-lessons.md)): `tool_choice: 'auto'` lets gpt-4o
  skip the `verdict` tool call and return markdown text; `parseContentJson` only rescues JSON code
  blocks — a `success:true, admit` verdict was lost. Fix: add `toolChoice` option to `LlmRequest`,
  set to `{ type: 'function', function: { name: 'verdict' } }` in `CriticDesk.judge`.
- **Deepseek key expired** — the `DEEPSEEK_API_KEY` in `api-keys.env` returned HTTP 401; the smoke
  succeeded with `--provider openai`. Update the key or switch default provider to `openai`.
- Next: implement R52 fix (`toolChoice` in `LlmRequest` + critic uses it); re-run farm-wheat to
  confirm `skill.admit` lands.

## 2026-06-15 — website on the live admin API (API stabilized + tested)

- Done: pointed `eden/website` at the real admin API (was `mock-api.js` fixtures). API hardened
  **tests-first**, then the website client swapped in — screens untouched.
  - **API additions (each pinned with tests):**
    - **`order` on `GET /journal`** (`'asc'|'desc'`) — `JournalQuery.order` + `Journal.query` +
      `MemoryJournal` + admin parse; the dashboard feeds request newest-first. Tests in
      journal.test.ts (real) + admin.test.ts (HTTP).
    - **Same-origin static serving** — `AdminServer` gained `webRoot`: GETs that match no API route
      serve `website/*` (`/`→index.html), correct content-types, **path-traversal guard**, API routes
      win. New `tests/admin-static.test.ts`. `main.ts` passes `webRoot` (default = real boot; new
      `serveWeb` opt). No CORS — the host serves the dashboard (owner #9).
  - **Rich accessor enrichment (main.ts wiring; admin server stays a dumb pass-through):** villager
    summary now folds latest `vitals` (actor `bot:<name>`) + the real subscription list + `activityKind`/
    `currentRun` + relations + dossier; skills list/detail carry signature/description/tags/`usedBy`
    (CompetenceView)/version history with source (`library.history`/`versionCount`); verdicts flatten
    `god.verdict` events; tasks map the ledger; `/status` carries the mission-control shape.
  - **Website client** `website/api.js` (new) re-implements the exact `window.EdenAPI` surface over
    fetch + a real `/journal/stream` WebSocket: unwraps envelopes, expands DOMAIN facets → concrete
    kinds (the server filter is exact-match), kind→domain table for the bare kinds (`vitals`→world,
    `inbox.delivered`→social). `index.html` loads it (`?mock=1` still loads the fixture client).
  - Verified: `npm run check` green (lint/typecheck/depcruise, **442 tests**); live smoke (God wired,
    bots off, `serveWeb`) — every route/envelope/POST-verb round-trips; in-browser the dashboard renders
    real data (overview/villagers/detail/skills), the WS feed live-updates on pause/prompt, zero console
    errors.
- Decisions (D#/R# if any): no new D/R; NO new journal kind (S1). `eslint.config.js` gained a
  `website/**/*.js` block (browser globals; the dashboard is glue, not part of the TS gate).
- Next: smoke against a live Minecraft server so vitals/subscriptions/runs populate from real bots.
- Surprises: the browser proof caught a bug the unit tests couldn't — screens call `v.vitals.hp`
  unconditionally, so the honest `vitals:null` (bots off) blanked the villager screens; the accessor now
  always returns a usable vitals object (real snapshot, else a nominal baseline).

## 2026-06-15 — M5 reactivity wired into the live host (the guard hurt reflex)

- Done: assembled the M5 reactivity system — built + unit-tested in M5-1/2/3 but **never wired in
  `main.ts`** — so a SEEDED reflex now fires in the running host. Symptom it fixes: in the last live
  `cooperative-mob-defense` run a guard (Alban) **died at +11.7 s** while his first combat `skill.run`
  was at **+16.9 s** — he stood passive ~16 s while the LLM authored combat. Five pieces:
  1. **Per-bot signal adapter** ([`bots/signals.ts`](../eden/src/bots/signals.ts)) — translates native
     mineflayer events into the router's synthetic shapes on a DEDICATED bus: `hurt` is synthesized from
     the `health` delta (damage) + nearest hostile (`byEntity`); `health`/`death` are forwarded. The bus
     (not the bot) is what the router attaches to, so the bot's native `entityHurt(entity)` (every entity,
     no damage) can't leak spurious damage-0 hurts (R51). Scope this pass: `hurt`/`health`/`death` only.
  2. **Per-villager assembly** ([`villagers/reactivity.ts`](../eden/src/villagers/reactivity.ts)) — a
     `VillagerReactivity` that, per villager, wires adapter → `EventRouter` → `SubscriptionRouter`
     (engine/journal/live `vitals()`/wake-up), reconnect-safe (re-attach drops the stale router).
  3. **`main.ts` wiring** — gated on a live bot pool: a SHARED `SubscriptionStore`, `seedRoleDefaults`
     per villager at first boot, a fast-tier reactive wake-up (swallows its own LLM errors — never a host
     `system.error`), `vitalsFor` read off the live bot, the 30 s `tick()`, detach on `stop()`. The pool
     gained an `onBotSpawn` hook (fires on spawn AND reconnect) the host attaches reactivity through.
  4. **Reflex stock skills** ([`skills/exemplars/index.ts`](../eden/src/skills/exemplars/index.ts)) —
     `flee-to-safety`, `defend-self`, `go-home`, `harvest-field` (the names `roles.json` references; all
     ran inert/MISSING before). All degrade gracefully (no anchor/hostile/field → clean RunReport).
  5. **`engine.runningSkills(name)`** — tracks the in-flight root skill so `notWhileRunning` (and vitals
     `currentRun`) read live truth.
- **Live PROOF** (`npm run live-test cooperative-mob-defense`): **PASS** (98 s, all 4 checks). Timeline:
  both guards `subscription.fired{on:hurt, outcome:skill, target:defend-self}` at **+9.2 s** (the instant
  the hit landed, ZERO tokens) → `defend-self skill.run ok` at **+12.0 s** → the FIRST `brain.wakeup` only
  at **+13.1 s**. The reflex defended BEFORE the LLM woke; **0 deaths** (was a death at +11.7 s), 0
  `system.error`, ≥2 combat runners. Re-hits mid-fight were `subscription.suppressed{not-while-running}`.
- Decisions (D#/R# if any): **D-15** (a role reflex OVERRIDES the everyone reflex on the same event —
  `seedRoleDefaults` dedup is now per-`on`, not `on`+kind — so a guard's `hurt → defend-self` wins over
  everyone's `hurt → flee-to-safety`; [04](04-villager-runtime.md)); **R50** (a reflex is only a reflex
  once WIRED into the host — time-to-first-defensive-action < survival-time) and **R51** (derive
  damage+attacker from the health delta; don't let the router hear native `entityHurt`) in
  [07](07-hard-won-lessons.md). No new journal kind (the M5 kinds already exist). The live harness's
  `journal-report.txt` timeline now keeps `subscription.fired`/`-suppressed`/`brain.wakeup` so the proof
  is legible. Finding **G** logged in [19](19-live-test-suite.md).
- Tests: 9 new FakeBot host-wiring tests ([`tests/villagers-host-reactivity.test.ts`](../eden/tests/villagers-host-reactivity.test.ts))
  — adapter delta/attacker derivation, zero-token hurt→flee, guard D-15 override fires before any
  wake-up, health-low → one coalesced wake-up, idempotent first-boot seeding, reconnect-safety,
  `runningSkills`. `npm run check` green (lint/typecheck/depcruise, **419/419**).
- Next: extend the pool's synthetic-signal emission (entity-spotted / item-received / block-broken /
  run-finished / inbox / time) so the rest of the role-default reflexes (night-falls → go-home, farmer
  new-day → harvest-field, guard entity-spotted → deliberate) can fire — a clean follow-up now the seam
  exists. Consider a `behavior.reactivity` config gate if a peaceful scenario ever takes chip damage and
  an unwanted flee fires.
- Surprises: the EventRouter was already DESIGNED to consume a synthetic `entityHurt(self, info)` shape
  (the unit test emits exactly that), so the only real architectural choice was where the translation
  lives — a dedicated per-bot bus, not the raw bot. The first hit in the arena lands at +9.2 s (zombies
  must path to the guards), so the whole reflex story plays out well inside the 360 s budget.

## 2026-06-14 — Live villager test suite (real server + real LLM)

- Done: built [`eden/live-tests/`](../eden/live-tests/) — a reusable, parameterized live-scenario harness
  (the tracked successor to the throwaway `.smoke/` run) + the first three scenarios. `runScenario()`:
  read `run/server.properties` (R28) → assemble config (no secret; key env-only) → apply an RCON arena →
  boot a REAL host (`spawnBots`+`enableGod`+`installProcessGuards`) → wait for assignees to connect →
  `prepare` (tp/clear/give/summon) → `god.addTask` + `coordinator.assignAndRun` (concurrent for cooperative
  scenarios) → assert on journal + world → preserve evidence. New `npm run live-test [name]`. Modules:
  typed multi-packet-safe `rcon.ts`, `arenas.ts` (`litBox`/`combatArena`), `checks.ts` (inventory via
  non-destructive `clear … 0`, mob presence via `execute if entity`, the draft→run→ticket→verdict→admit
  chain, deaths/errors), `config.ts`, `catalogue.ts`.
- Scenarios: **farm-wheat** (crop-break + pickup — baseline, should reach a clean `admit`),
  **craft-wooden-tools** (`bot.craft` + crafting-table windows, R1–R3 — the likely next gap),
  **cooperative-mob-defense** (`bot.pvp` + armor + multi-villager; cooperation dispatched as one task per
  guard run concurrently — decision documented). All authoring-demanding (French `write_skill` phrasing) so
  the full chain fires; objective `check` is the hard pass.
- Docs: [docs/19-live-test-suite.md](19-live-test-suite.md) (suite reference: architecture + assertion
  vocabulary + findings log W/C/D1/D2/E), [docs/20-live-test-process.md](20-live-test-process.md) (the
  run→diagnose→fix→re-run process + diagnostic playbook: reading the journal, RCON ground truth,
  symptom→cause patterns, the worked example), [`eden/live-tests/README.md`](../eden/live-tests/README.md)
  (prereqs/run/evidence), indexed 18/19/20 in docs/README.md.
- Decisions/notes: live scenarios are EXCLUDED from `npm run check` (server + paid key, non-deterministic),
  mirroring `eden/eval/`. The harness is typed + lint-clean and `tsc`-included; a CI test
  ([`tests/live-tests-catalogue.test.ts`](../eden/tests/live-tests-catalogue.test.ts)) pins the catalogue
  STRUCTURE (names/assignees/idempotent arenas/valid rosters) with no Minecraft. Broadened the ESLint ignore
  to `**/.eden-data*/**` + `live-tests/.runs/**` (matching the gitignore's `.eden-data*/`) so preserved run
  snapshots' generated skill `.js` don't fail the lint gate. `npm run check` GREEN — **383 → 396** (+13:
  7 catalogue tests; existing 389 unchanged).
- First live run + **gap W (CRITICAL), found and FIXED**: the suite booted against the live dev server and
  immediately surfaced a serious hole. farm-wheat authored `harvest_wheat`, ran it, **collected 9 wheat**
  (real `bot.dig`/Vec3 works), critic revised — then on revision 5 the villager wrote a `while(true){ await
  noop(); }` loop. The `await` of an immediately-resolved promise **resets the loop budget every iteration**
  (`__aw`) AND starves the macrotask queue, so the loop budget, the 3 engine supervisors (StallDetector /
  wallTimer / sampler) and the harness `setTimeout` deadline — all macrotasks — were ALL defeated. The host
  wedged 23 min; bots kicked `Timed out`. A villager can freeze the whole village. Fix (2 layers, `npm run
  check` green @ **396 → 399**): (1) engine — a macrotask-starvation canary (`setInterval` heartbeat +
  synchronous `checkProgress` guard injected into `createLoopBudget`) that throws `EngineAbort('stalled')`
  from inside the loop when `now()−lastTick > macrotaskStallMs` (8 s; below the 30 s keep-alive kick, above
  any legit sync burst; heartbeat scaled to the window so legit macrotask-yielding loops never false-trip);
  (2) harness — process isolation (each scenario in a killable child, parent SIGKILLs a wedge from its own
  healthy event loop). Filed in [docs/19](19-live-test-suite.md) findings log (W).
- Re-runs + more fixes: run-2 (W fixed) → **farm-wheat PASS with `skill.admit`** (first clean end-to-end
  convergence the project has captured), and surfaced gap **C** (stock `craft-item` passed the item NAME to
  `bot.recipesFor` which needs a numeric id + the crafting-table block → crafting wholly broken — the craft
  analog of Z) plus D1 (defense `difficulty hard` → zombie reinforcement swarm killed the guards) and D2
  (peaceful fall death). Fixed all three (C in stock-skills, D1 `difficulty easy`, D2 shorter litBox);
  run-3 → **2/3 PASS** (farm + defense; defense now 0 deaths, both guards fight). craft still FAIL but for a
  NEW deeper reason (gap **E**, OPEN): stock `collect-blocks` (`bot.dig`) doesn't reliably pick up the drop
  (lands out of the ~1-block auto-collect range), so there are no logs to craft from — plus LLM
  non-convergence (skills return `{status:'échec'}` with `ok=true`). All filed in [docs/19](19-live-test-suite.md).
- Next: gap E (collect-blocks walk-onto-drop pickup) + craft tuning (more oak, higher maxRetries) is the
  next fix to chase craft → green. `npm run check` green @ 399 throughout.
- Surprises: (1) `ctx.log` pulses the stall detector, so a logging wedge masks any pulse-based guard — the
  canary had to measure the macrotask queue itself, not progress. (2) leftover smoke run-dirs
  (`.eden-data.run1/2/3`) were already breaking `eslint .` (the old `.eden-data/**` ignore didn't cover the
  `.run*` variants) — fixed alongside.

## 2026-06-14 — Test-validity + coverage audit — completed

- Goal: make the M0–M7 test suite **trustworthy**, not bigger — every test must actually exercise the real
  code and fail if it regresses; fakes must faithfully model the real contracts; the highest-value
  uncovered branches filled; flaky tests made deterministic. **No feature work.** `npm run check` GREEN
  throughout (lint clean, tsc clean, dependency-cruiser **0 violations / 74 modules / 209 deps**).
- Test count: **367 → 383** (+16, all in existing test files; no new test file). Tests audited:
  every `tests/**/*.test.ts` (54 files); tests strengthened/added: 16 added + 1 weak assertion tightened.
- **Coverage** (Node built-in `--experimental-test-coverage`; a `test:coverage` npm script was added):
  - Overall **before → after**: line **93.72 → 93.90 %**, branch **82.12 → 83.30 %**, func **93.84 → 93.95 %**.
  - Worst non-type file `villagers/tools.ts`: branch **58.8 → 71.3 %**, line 97.2 → **99.7 %**.
  - `god/orchestrator.ts`: branch **77.6 → 83.1 %**, line **100 %**. `villagers/memory-summarizer.ts`:
    branch **66.7 → 92.5 %**, line **100 %**. `llm/client.ts`: branch **82.7 → 85.5 %**.
  - The `types/*.ts` files show low LINE % (9–25 %) — that is tsx instrumenting interface/type declaration
    lines that compile to nothing. They are pure types (zero executable logic); not a real gap.
- **Validity audit (the important part — did any test lie?).** The suite is, overall, genuinely
  mutation-resistant. Three mutation spot-checks confirmed load-bearing mechanisms are really tested:
  break the R47 oversize cap (`if(false)`) → the R47 tools test FAILS; disable the StallDetector trigger
  → D-10(iii) no longer passes (hangs/fails, never green); the critic D-12 check-veto + voidDivineOverreach
  tests script the LLM to *wrongly* admit and assert the SUT's rail overrides it (would fail if the rail
  were removed). All mutations reverted; **zero source edits left from the audit's probing.**
  - **Vacuous/weak assertions found + fixed:**
    - `admin.test.ts` `assert.ok(status.uptimeMs >= 0)` was vacuous (uptime is always ≥0). Tightened to
      `Number.isFinite(...) && >= 0` so a NaN/Infinity from a broken `Date.now()-startedAt` is now caught.
    - `skills-instrument.test.ts:59` `assert.ok(true)` — INSPECTED, kept: it is the documented
      "host process is still alive after `process.exit(0)`" half of D-08 (reaching the line IS the proof;
      the real work is the preceding `assert.rejects`). Not vacuous in intent.
  - **No "testing-the-fake-not-the-SUT" tests found.** The integration tests (gate, loop-integration,
    main-full-wiring) drive the REAL Brain / SkillEngine / CriticDesk / GodService / SkillLibrary and only
    fake the LLM (ScriptedLlm) and the bot (FakeBot) — the correct seams.
  - **Fake-faithfulness cross-check (all four fakes vs the real modules):**
    - `MemoryJournal.query` vs `Journal.query`: kinds/actor/since/until/ref/limit semantics MATCH (ref =
      match against refs *values*; limit = most-recent-N returned chronological). One faithful difference
      noted, NOT relied on by any test: the real journal orders by `at,id` whereas MemoryJournal keeps
      insertion order — identical for monotonic clocks (every test uses one), divergent only under a
      backwards-injected clock. Left as-is (fixing it would risk the shared M0–M7 seam for zero test gain).
    - `ScriptedLlm` wire shape vs `LlmClient` parser: `choices[0].message.{content,tool_calls[].{id,
      function.{name,arguments(string)}}}`, `finish_reason`, `usage.{prompt,completion,total}_tokens` —
      FAITHFUL. `FakeBot` craft/window/`_client` packet/pathfinder/dig seams match what `bots/hardening`,
      `skills/engine`, and the exemplars require (R1–R3 window hijack, D-10 dig/path pulses) — FAITHFUL.
      `FakeSettlement` matches the SettlementClient POST contract — FAITHFUL. **No fake fixes were needed.**
- **Genuine `src/**` bug uncovered:** NONE. Every added test exercised an existing-but-untested branch and
  every one passed on first correct run — no assertion exposed wrong behaviour. (This is an honest null
  result, not a skipped search — the mutation checks above confirm the existing tests would catch real
  regressions.)
- **Flaky tests made deterministic** (node:test runs ~20 files concurrently):
  - `fakes.test.ts` "emits path_update on a timer": WAS a wall-clock-window flake (counted ticks in a fixed
    90 ms window — a saturated event loop starves it below the bar). REWRITTEN to wait for the 3rd event to
    ARRIVE with a generous 2 s cap — the seam (emits repeatedly without moving) is preserved, the tick-rate-
    under-contention dependency removed. The companion never-resolving-`dig` race widened 40→200 ms (a
    longer window only makes the "pending" verdict more robust, since the dig can never win the race).
  - The ScriptedLlm-server tests (`villagers-brain`, god desks, gate, …): re-audited; they resolve the
    server URL only inside `listen`'s callback and `close()` in `finally`, so they cannot race a not-ready
    server or leak the loop. Confirmed stable.
  - **10 clean full-suite runs** (5 normal + 5 under heavy CPU contention with 6 busy-spinners): 383/383
    every time. The timer fix is the decisive change — it can no longer fail from a starved sampling window.
- **Gaps filled (highest-value error/abort/degrade branches, house style, fakes-only, deterministic):**
  - `villagers/tools.ts` (+8): every input-validation `ok:false` branch the brain leans on — empty
    name/code on write_skill, empty name on run_skill, empty text/query on remember/recall, missing-`on` /
    invalid-handler on subscribe, missing-id / not-yours on unsubscribe, the filter+disabled rendering in
    list_subscriptions, empty-store recall-is-not-an-error.
  - `god/orchestrator.ts` (+4): `intervene` SOFT-FAIL when the avatar action THROWS (theatrics-never-a-
    dependency → ok:false, still flags divineAssisted, journals `god.appearance{ok:false}`); intervene
    without a taskId; `clearDivineAssist` (one-shot per verdict); `expireStale` (expired directives closed
    `god.directive-closed{expired}`, fresh ones survive).
  - `villagers/memory-summarizer.ts` (+3): ```json-fenced reply with surrounding prose parses
    (extractJson); a reply with no `summary` degrades to null (never a partial); an empty eviction batch
    returns null with ZERO LLM calls.
  - `llm/client.ts` (+2): a connection-reset that NEVER recovers gives up after exactly `maxRetries`
    (no infinite loop, no success journaled); a direct (non-wrapped) `UND_ERR_SOCKET` code is also retried.
- **Still weak / honestly deferred (not fixed, by design):**
  - `bots/pool.ts` reconnect-backoff ESCALATION (1→2→5→10→30 s) and `reconnectAttempts`-reset-on-respawn
    remain wall-clock-bound (the schedule is a non-injectable module constant). PROGRESS already deferred
    these as integration/smoke concerns; a 6 s+ wall-clock test would slow CI for marginal value and the
    `stop()-cancels-reconnect` test already proves the timer machinery. Left deferred, not papered over.
  - `tools.ts` line 174 + a few `String(a['x'] ?? '')` default-arg coercions stay uncovered — they only
    fire on malformed LLM args and all funnel through the dispatch-level try/catch, which IS tested.
- Decisions (D#/R#): **none** (no new D-/R-number; an audit implements no new mechanism). The R23
  no-`console.*` rule and the `journal-kinds.test.ts` pinning list (all M0–M7 kinds) are untouched and
  still complete. No `src/**` behaviour changed; the only `src` edit considered (MemoryJournal ordering)
  was deliberately NOT made.
- Next: Eden remains feature-complete (M0–M7); the operational smoke gates in 17-parity-signoff.md are
  unchanged. If the reconnect-backoff escalation ever needs CI proof, make `RECONNECT_BACKOFF_MS`
  injectable via `BotPoolOptions` (an add-a-config-seam change, S8) rather than a wall-clock test.

## 2026-06-14 — M7 — parity+ (admin API + derived views + rebuild-stats + eval harness + decommission) — completed

- Done (all TDD, test authored before each module; `npm run check` GREEN — **367 tests** (was 333; **+34
  M7**, +32 net new test cases across 5 new test files plus 2 added scheduler cases), lint clean, tsc clean,
  **0 dependency violations** (74 modules, 208 deps)). M7 is the FINAL milestone — it converges all branches:
  admin API complete + derived `views/` + the `eden rebuild-stats` CLI + the eval-harness port + the full
  `main.ts` composition + the v1 decommission / parity sign-off.
  - **M7-1a** [`views/index.ts`](../eden/src/views/index.ts) — the LAYER-1 derived folds (11 §8). A
    `DerivedView<V>` abstract base (`fold(event)` + `rebuildByReplay(journal)` + `value()`), and four
    concretes: `SkillStatsView` (from `skill.run`: runs/successes/failures/stalls/running-mean avgMs/
    lastError), `CompetenceView` (per-villager × skill from `skill.run`), `RelationsView` (from
    `conversation.started`/`.ended` leave opinions, accumulated per (villager, other)), `TradeLedgerView`
    (one entry per trade id from `trade.proposed/settled/failed`). A NEW `views-only-journal-types`
    dependency-cruiser rule pins views/ to journal/ + types/ ONLY — so admin/, skills/library, god/ read
    views UPWARD without importing each other. PROOF (`tests/views.test.ts`, 7): each fold's math + the
    **rebuild-by-replay == live fold** invariant over a MemoryJournal stream (iterates `ALL_VIEWS`).
  - **M7-1b** [`admin/server.ts`](../eden/src/admin/server.ts) — the COMPLETE admin surface. Extended the
    M0 skeleton with `/villagers[/:name]`, `/skills[/:name]?version=&code=`, `/tasks`, `/verdicts`,
    `/directives` (GET) and `/pause`, `/resume`, `/skills/:name/quarantine`, `/villagers/:name/prompt`
    (POST). The admin holds only NARROW ACCESSOR FUNCTIONS + a journal (S5: no concrete subsystem class) —
    stays deletable. **Every mutating verb journals (actor:'admin' | player:<from>) BEFORE acting** (05):
    pause/resume journal a `system.config-warning` then gate the scheduler; quarantine journals
    `skill.quarantine{actor:'admin'}` then calls the library; prompt journals `inbox.delivered{kind:'tell'}`
    (actor `player:<from>`) BEFORE delivery — zero engine machinery. Unknown subject → 404 WITHOUT a stray
    journal entry; unwired control → 503. Added `LlmScheduler.pause()/resume()/isPaused()` (M7): pause HOLDS
    the whole queue (skills/subscriptions, which don't route through the scheduler, keep running). PROOF
    (`tests/admin-routes.test.ts`, 8 + 2 scheduler cases): every route; prompt-before-delivery;
    quarantine-before-action; pause-gates-the-real-scheduler; graceful 503 when unwired.
  - **M7-1c** [`cli/rebuild-stats.ts`](../eden/src/cli/rebuild-stats.ts) + `npm run rebuild-stats` — a
    CONSUMER (new `no-import-cli` rule, like `no-import-admin`). `rebuildStats(journal)` is the pure core
    (replays the journal into all four views); `main(dataDir)` opens the real SQLite journal, rebuilds,
    prints via logger (R23). PROOF (`tests/rebuild-stats.test.ts`, 2): over a REAL on-disk `Journal`,
    `rebuildStats` == the live fold (the deliverable); empty journal → empty views.
  - **M7-2** [`eval/`](../eden/eval/) — the eval-harness port (R42), CI-tested on LOGIC only (no Minecraft).
    `roster.ts`: the reserved `EvalBot` username prefix (R12 — can't collide with v1 `LLMBot`/`GodBot` or
    Eden `Dieu`), the ambient-suppression eval roster (drives off, embeddings off, 3600 s heartbeat, no real
    provider baseUrl), and the `ScenarioRegistry` collision guard (per-bot EXCLUSIVE seeds — R42's sharpest
    edge: a duplicate bot claim THROWS naming the prior owner; an out-of-roster bot throws).
    `fixtures.ts`: RCON-idempotent world fixtures (`fixtureCommands` lowers a declarative fixture to absolute
    SET commands; `isIdempotentFixture` flags relative `~`/`summon`/`destroy`). `mock-llm.ts`: the scripted
    mock LLM on its own ephemeral port (runtime twin of the test fake). `run.ts`: the smoke-time entrypoint
    (`npm run eval`) — wipes `.eden-eval-data/` at start, builds the reflex+trade scenario catalogue (each
    claiming an exclusive bot), documents the PaulsBrawlsVanilla smoke steps (R28/R29), dry-runs safely
    without a server. PROOF (`tests/eval-harness.test.ts`, 7): collision guard rejects a duplicate seed;
    reserved prefix; ambient suppression; fixture idempotency; scripted-LLM determinism.
  - **M7-3** [`main.ts`](../eden/src/main.ts) — completed the live composition. Built + journal-subscribed
    the four derived views (unconditional, pure consumers); wired the COMPLETE admin accessor bundle
    (villagers/skills/tasks/verdicts/directives reads; pause→scheduler, quarantine→library, prompt→inbox;
    status now reports `queues.paused`). `wireGod` now also builds the SOCIETY: one `VillagerMemory` per
    villager (S2 sole writer) + a `MemorySummarizer` (fast-tier, eviction) + a `SettlementClient` from
    `settlement.url`. **`spawnBots` stays default false** so CI/host-readiness never blocks on Minecraft;
    `enableGod` defaults to `spawnBots` but can be turned on independently (the full-graph boot test does
    exactly that). PROOF: `tests/main-full-wiring.test.ts` (2) — the FULL host boots with God wired but NO
    Minecraft, the complete admin surface answers, pause gates the live scheduler, prompt journals the tell;
    and the no-God default boot returns empty GETs + 503 controls. `tests/parity.test.ts` (6) — R12 identity
    (Dieu ≠ v1 names; villager==avatar rejected; LLMBot warns) + R24 ports (admin 8770 never reuses 8765/6;
    settlement is the shared :8767) + the eval namespace is disjoint from production.
- New journal kinds: **NONE** (S1 honored exactly as the brief scoped). M7 READS + FOLDS existing kinds;
  the registry + the pinning test are byte-unchanged from M6. The R44 word-boundary guard is untouched.
- Decisions (D#/R#):
  - **No new D- or R-number** (S8 — flag if a genuine gap appeared; none did). M7 implements existing
    resolved mechanisms: R42 (eval-harness patterns — verbatim port of the sharp edges), R12/R24 (identity +
    port law — already enforced in config.ts, now also asserted in parity.test.ts and namespaced in eval/),
    R32 (world-stamp — carried into the decommission doc), P4/S2 (derived-state — the views fold, never
    primary; rebuild==live). Nothing arose the docs don't already capture.
  - **The `views/` layer rule** (`views-only-journal-types`, mirroring `journal-only-types`/
    `render-only-types`) is the structural seam the IMPL-PLAN §3.3 predicted: views/ at LAYER 1 so
    skills/library + god/ + admin/ read it UPWARD legally. Placing it any lower would make those reads
    illegal upward imports.
  - **CompetenceView keys by SKILL, not by TAG.** The plan said "per-tag success from god.verdict/skill.run",
    but skill TAGS live on the live manifest, which the journal does NOT carry — a journal-pure, rebuild-by-
    replay-safe fold can only key by the dimensions the journal HAS (villager × skill × outcome, 11 §9). The
    *tag* competence still exists: God's dossier folds it from the live library at verdict time
    (`god/god.ts updateDossier`). Flagged here as the one deliberate deviation; it keeps the deliverable
    (rebuild==live) honest, which a tag-fold could not (tags drift across versions).
  - **`pause` gates the LLM scheduler, fully.** docs/05 says "skills/subscriptions keep running" — they do,
    because zero-token skill runs + subscription matching never route through the scheduler. The scheduler
    pause holds even god/rollout-immune work (a paused village should make NO LLM calls); resume drains the
    held queue. No new config key (the pause is runtime state, not config).
  - **The admin journals its OWN intent event with actor:'admin'/player:<from> BEFORE the action**, even
    though the underlying subsystem (library.quarantine, inbox.deliver) ALSO journals mechanically. Both are
    legitimate: the admin event is the audit trail of WHO poked (05's rule), the subsystem event is the
    mechanical record. For prompt, an existence pre-check (via the villager accessor) means an unknown
    villager 404s WITHOUT a stray journal entry.
  - **main.ts wires society memories + a settlement client, but NOT live conversation/trade SERVICES.**
    Those need bot-backed sinks (Conversant `sayInGame`/`playerInEarshot`, ReachStrategy `walkTo`) that only
    exist with a live bot — they're constructed per-interaction at run time, kept out of the host-construction
    path so the no-Minecraft boot stays clean (the same `spawnBots` discipline as M3–M6).
- SMOKE: **not run — no dev server available in this environment** (consistent with M1–M6). The parity
  sign-off has three smoke gates (documented in [17-parity-signoff.md](17-parity-signoff.md) §4): (1) loop
  convergence with a real provider vs the dev port from `run/server.properties` (R28); (2) trade settlement
  via :8767 — **stop `./gradlew runServer` first, it steals 8767** (R29); (3) `npm run eval` scenarios vs
  PaulsBrawlsVanilla (the `EvalBot` prefix means it can't collide with a running v1 — R12). Plus the
  side-by-side v1+Eden coexistence check (distinct usernames, Eden 8770 vs v1 8765/8766, shared 8767 — R24).
- Next: **Eden is feature-complete (M0–M7).** Remaining work is operational: run the three parity smoke
  gates, soak v1+Eden side-by-side, then walk the [decommission checklist](17-parity-signoff.md#5-v1-decommission-checklist).
- Surprises:
  - **`tsconfig.json` had to gain `eval` in `include`.** The eval modules are imported by tests (so tsc
    followed them anyway), but adding `eval` makes the typecheck + eslint scope explicit so `eval/run.ts`
    (not imported by any test) is still checked. The depcruise scope stays `src` only — eval/ is a harness,
    not part of the dependency graph.
  - **A journal fold subscribed in main.ts must never throw into the writer.** It can't — `Journal.fan()`
    already swallows consumer errors (P4: a bad consumer never breaks the write path) — but it's worth
    restating: the live views ride that same guarantee, so a malformed payload in one view can't stall the
    journal or starve the other views.

## 2026-06-14 — M6 — society (memory + conversation + trade + drives) — completed

- Done (all TDD, test authored before each module; `npm run check` green — **333 tests**, of which
  **35 are M6** across 4 new test files: `villagers-memory` (14), `social-conversation` (8), `social-trade`
  (7), `villagers-drives` (5), plus a +1-net change to `villagers-tools` — the M3 remember/recall stub
  test became a wired test). M6 is the third independent branch off M3-GATE (∥ M4/M5); it adds the social
  layer — memory, conversation, trade — on top of the M0–M3 substrate.
  - **M6-1** [`villagers/memory.ts`](../eden/src/villagers/memory.ts) + [`villagers/memory-summarizer.ts`](../eden/src/villagers/memory-summarizer.ts) —
    the full memory port. A ~200-entry episodic WINDOW → evicted batches fold into a persisted per-bot
    ARCHIVE (cap 2 000) AND into a rolling LIFE SUMMARY via ONE **fast-tier** `MemorySummarizer` call
    (D-13) that also returns keyword-tag enrichment, per-entry importance bumps, and up to two `lesson`
    insight memories (seeded into the live window so insights survive eviction). Summarization runs OFF
    the hot path (`flushSummary()` awaits it) and is **best-effort** — a bad/parse-fail reply degrades
    silently, the batch still archives (modeled on `skills/describe.ts`). The **MemoryRetriever**
    (`retrieve`) ranks `0.5·relevance + 0.25·recency(2 h half-life) + 0.25·importance`, relevance =
    `max(embedding cosine, keyword overlap)`, embeddings lazy + batched off the hot path and degrade to
    the keyword floor (R38: `embed` → null). Relations (per-other score + note, `moveRelation`) carry
    over. **R32**: a persisted store whose world-id ≠ the current world is QUARANTINED behind an admin
    decision (`resolveQuarantine('wipe' | 'migrate')`) — not silently used (the live window starts empty),
    not silently dropped (held for the admin), and journaled as a `system.config-warning`. **R37 DROPPED**:
    no `refuteBlockedBeliefs` (a test asserts the method is absent) — the critic owns belief retirement.
    `remember`/`recall` in [`villagers/tools.ts`](../eden/src/villagers/tools.ts) are now wired to the
    real store (the M3 stubs are gone; they degrade gracefully when no store is injected). PROOF:
    eviction → archive + summary (fast LLM, ScriptedLlm); retrieval ranking (the 0.5/0.25/0.25 blend +
    recency half-life + max(cosine,keyword)); R32 quarantine-behind-admin (+ wipe/migrate).
  - **M6-2** [`social/conversation.ts`](../eden/src/social/conversation.ts) — bot↔bot speech (v1's design
    wholesale). Alternating turns with a hard **turn cap** + a **per-turn deadline** (a slow turn ends the
    conversation, `reason:'deadline'`, R39 valve). Speech is mirrored to the GAME chat **only when a player
    is in earshot of the speaker**, **rate-limited** per speaker. `leave_conversation{opinion, note,
    headline}` moves the leaver's relation toward the partner AND seeds the headline as a **high-importance
    social memory for BOTH parties**. **Eavesdroppers** in earshot but not party to the conversation get a
    free memory entry per overheard line (`chat.heard{eavesdrop:true}`); the addressee hears it too
    (`eavesdrop:false`). PROOF: turn cap + deadline enforced; the mirror gate (no player → no mirror; player
    → mirrored + rate-limited); `leave` feeds relations + memory for both; eavesdropper memory.
  - **M6-3** [`social/trade.ts`](../eden/src/social/trade.ts) — `SettlementClient` (POSTs a typed offer to
    `{settlement.url}`, default `127.0.0.1:8767/trade/execute`; **`coin` → `paulsbrawls:coin`** so Gibber is
    the village currency for free; 2xx → `trade.settled`, non-2xx/network/timeout → `trade.failed` with the
    cause named, S10 — inventories UNTOUCHED because the mod swaps atomically or not at all) + `TradeService`
    (orchestrates: **R33 walk-then-talk** — an out-of-range partner is walked to FIRST via an injected
    `reach.walkTo()` that composes the go-to skill in production, then `trade.proposed` → settle; an
    unreachable partner is a failed trade, never a settle). PROOF against a **FakeSettlement** server
    (ephemeral localhost, modeled on ScriptedLlm): proposed→settled happy path; failed settlement (422 →
    `trade.failed`, no `trade.settled`); network-error → `trade.failed` (never throws); coin alias in the POST
    body; R33 out-of-range → walks first / in-range → no walk / unreachable → fail.
  - **M6-4 (OPTIONAL, done minimally)** [`villagers/drives.ts`](../eden/src/villagers/drives.ts) — a
    `DriveTracker` decays rest/social per `tick()`; gated on `behavior.drives`. With `drives:true`, crossing
    a low threshold fires a one-shot `tired`/`lonely` wake-up (hysteresis: re-arms only after recovery);
    with `drives:false` the tracker is inert (architecture unchanged). The mood string is already a
    side-output of `done` (M3). PROOF: `drives:true` decay → exactly one wake-up (+ hysteresis hold/recover);
    `drives:false` → zero wake-ups, ever.
- New journal kinds registered (S1) in [`journal/kinds.ts`](../eden/src/journal/kinds.ts) + the pinning
  test + the docs/05 as-built note — exactly the **8** the plan scopes to M6, all already named in the
  docs/05 Social table row, so **no doc-drift**: `chat.said`, `chat.heard`, `conversation.started`,
  `conversation.turn`, `conversation.ended`, `trade.proposed`, `trade.settled`, `trade.failed`.
  `inbox.delivered` was already M3 — deliberately NOT re-added. The R44 word-boundary guard still passes
  (no `tick`/`pulse`/`position`/`pathfinder`/`physic` substring in any of the 8).
- Decisions (D#/R#):
  - **No new D- or R-number.** M6 implements existing resolved mechanisms — R32 (world-stamp belief
    quarantine), R33 (recover-in-tool walk-then-talk), R37 (critic owns belief retirement → drop
    `refuteBlockedBeliefs`), R38 (keyword floor), R39 (timeouts are valves), D-13 (fast-tier summarization)
    — and nothing new arose they don't already capture (S8). The R32/R33/R37 trio covered M6 exactly as the
    docs predicted.
  - **The cross-layer-3 seam is `types/social.ts`** (new layer-0 module). `social/{conversation,trade}` is
    layer 3 and may NOT import `villagers/memory` or `villagers/inbox` (the `social-no-peers` rule). So
    social/ depends on three types/ interfaces — `MemoryWriter` (remember + moveRelation), `Conversant`
    (name + memory + sayInGame sink + playerInEarshot gate), and `TradeItem`/`MemorySeed`/`Relation`
    shapes — whose concrete instances (VillagerMemory + a bot-backed chat sink) main.ts wires. This is the
    SAME discipline that keeps god/ out of villagers/ via the Inbox. `villagers/tools.ts` ↔ `villagers/memory`
    is an intra-layer-3 import (both under `villagers/`), which is legal and direct.
  - **R32 quarantine is the SUBJECT of the admin decision, not a silent default.** A world-id mismatch
    starts the live window EMPTY (bots never reason from a dead world) but holds the persisted state aside;
    `resolveQuarantine('wipe')` drops + adopts the new stamp, `'migrate')` adopts the memories + the new
    stamp. The pool's M1 stamp shout becomes an actionable decision here (M1's TODO is now closed).
  - **M6-4 was done MINIMALLY, deliberately NOT touching M5's events.ts.** The plan's M6-4 sketch said to
    add `tired`/`lonely` ROWS to M5's emitter registry. Doing so would extend the **frozen `EdenEvent`
    union** (types/events.ts) and the FilterEvaluator's name/distance tables, touching M5's events.ts +
    subscriptions.ts contract. The plan's own escape hatch ("if M6-4 risks destabilizing M5's events.ts,
    implement it minimally") applies: `DriveTracker` fires the wake-up through an INJECTED callback (the
    exact decoupling M5's `SubscriptionRouter` uses via `WakeupFn`), so drives are self-contained, the
    frozen union + M5's registry are untouched, and every M5 test stays green byte-unchanged. The drive
    wake-up is NOT a new `JournalKind` and NOT a per-tick stream (R44).
  - **`MemoryEntry` gained a `'lesson'` kind** (types/memory.ts) so distilled insights are first-class +
    rank highest by the importance heuristic; the existing five kinds are unchanged. A new `Relation` type
    + a `types/social.ts` module landed (the seam above). These are the only types/ extensions — flagged
    per the brief ("extend types/ only if truly necessary").
  - **Wiring the live society into main.ts was NOT done** (optional, like M3–M5): M6 proves entirely on the
    fakes. main.ts is unaffected (it imports none of the new modules); the live wiring (one VillagerMemory +
    DriveTracker per villager, a bot-backed Conversant chat sink, a SettlementClient from `settlement.url`)
    is a composition-root step for M7/integration, kept out of M6 to avoid risk.
- SMOKE: **not run — no dev server available in this environment** (consistent with M1–M5). The REAL :8767
  settlement integration (POST against the paulsbrawls mod's `VillageHttpListener`) is a **smoke-time
  concern (R29: stop `./gradlew runServer` first — it steals 8767)**: CI proves proposed→settled + failed
  against the ephemeral `FakeSettlement` server, no Minecraft. The real-bot smoke would attach a Conversant
  chat sink + earshot check to each villager and run a live trade through the mod.
- Next: **M7 (parity+) converges all branches** — admin API complete (`/villagers`, `/skills`, `/tasks`,
  `/verdicts`, `/directives` + the POST verbs) + derived `views/` (SkillStats/Competence/Relations/
  TradeLedger — Relations + TradeLedger now have M6 journal streams to fold) + `eden rebuild-stats` + the
  eval-harness port (R42) + v1 decommission. M6's social wiring into main.ts lands there.
- Surprises:
  - **A leaked HTTP server in ONE test hangs `node --test`.** The "coin alias" trade test created a
    FakeSettlement but didn't `await server.close()` — node's test runner waits for the loop to drain, so
    the process never exited and the harness backgrounded every run. Closing the server in every test that
    opens one fixed it (the ScriptedLlm/FakeSettlement fakes MUST be closed). Flagged for the eval-harness
    discipline (R42) — every ephemeral-server fake needs a matching close.
  - The retrieval blend pools BOTH the live window and the archive, so a high-importance archived memory can
    still surface — exactly what makes the rolling summary + archive useful rather than write-only. Recency
    naturally down-weights old archived entries (2 h half-life), so the live window dominates for fresh
    queries without a hard window/archive split in the ranker.

## 2026-06-14 — M5 — events (EventRouter + subscriptions + routing) — completed

- Done (all TDD, test authored before each module; `npm run check` green — **298 tests**, of which
  **48 are M5** across 4 new test files: `villagers-events`, `villagers-subscriptions`,
  `villagers-routing`, `villagers-role-defaults`, plus 2 wired-tool tests added to `villagers-tools`).
  M5 is one of three branches off M3-GATE (∥ M4/M6); it adds reactivity — "when X (filtered), do Y" as
  DATA (P5) — on top of the M0–M3 substrate.
  - **M5-1** [`villagers/events.ts`](../eden/src/villagers/events.ts) `EventRouter` — normalizes one
    bot's raw mineflayer/world signals into the closed `EdenEvent` set via an **EMITTER REGISTRY** (S1:
    one ROW per emitter — `buildRegistry()` — never an if/else fork). **Hysteresis lives IN the emitter**
    (04): `health-low` fires ONCE on the cross below the threshold and re-arms only after health recovers
    ≥ threshold (a per-router latch); the day/night phase fires `night-falls` on day→night and `new-day`
    on night→day, tracking the last observed phase so staying in a phase produces no event (the first
    observation just records the phase — no spurious boot edge). A `tick-30s` coarse clock is pumped by an
    injected `tick()` (deterministic in CI — no real timer; coarse, so R44-safe). PROOF: per-event emitter
    tests on FakeBot + the hysteresis edge test (cross-once / hold-no-refire / recover-and-refire).
  - **M5-2** [`villagers/subscriptions.ts`](../eden/src/villagers/subscriptions.ts) — `SubscriptionStore`
    (the **SOLE WRITER** of subscription state, S2: add/remove/setEnabled journal + persist to per-villager
    JSON under the data dir; per-subscription cooldown bookkeeping) + `FilterEvaluator` (a **CLAUSE
    REGISTRY**, S1/P5: `CLAUSES` is one ROW per Filter key — within/entityKind/nameMatches/timeOfDay/
    healthBelow/foodBelow/notWhileRunning — AND-composed over only the keys present; **no predicate
    code**) + `substituteArgs` (`$event.*` ArgTemplate resolution at fire time, an unresolved path → `undefined`,
    never throws). The `subscribe`/`unsubscribe`/`list_subscriptions` tools in
    [`villagers/tools.ts`](../eden/src/villagers/tools.ts) are wired to the real store (the M3 stubs are
    gone); `unsubscribe` is **new** (plan §4 lists subscribe/unsubscribe/list_subscriptions). PROOF: the
    filter-matching matrix (each clause pass+fail + AND-composition), ArgTemplate substitution, persistence
    round-trip, cooldown suppress-then-clear.
  - **M5-3** [`villagers/events.ts`](../eden/src/villagers/events.ts) `SubscriptionRouter` +
    [`villagers/role-defaults.ts`](../eden/src/villagers/role-defaults.ts) + [`eden/roles.json`](../eden/roles.json) —
    the two routing OUTCOMES (04): `kind:'skill'` → a **ZERO-TOKEN** `SkillEngine.run` (no LLM; a FAILING
    handler still files a normal `RunReport` so the critic tripwire owns it — never silently swallowed);
    `kind:'deliberate'` → a brain wake-up on the right lane (the router reaches the brain through an
    injected `WakeupFn`, so events.ts needn't build a full ContextPackInput — stays decoupled +
    fakes-testable). **R36 one-incident-one-wake-up**: one event matching N deliberate subscriptions
    escalates EXACTLY ONE coalesced wake-up (all hints, highest lane) — the router OWNS the escalation;
    every match still journals `subscription.fired` (everyone journals, the owner escalates once). A
    matched-but-throttled handler (disabled / cooldown / notWhileRunning) journals `subscription.suppressed`;
    a filter MISS is a SILENT skip (the event simply doesn't apply). `notWhileRunning` is treated as a
    refractory/suppression clause (not a match clause) so it journals a reason. `roles.json` seeds each
    villager's defaults (everyone + role block, role-dedup'd) at **first boot only** (idempotent — a
    villager already holding any subscription is left untouched). PROOF: skill fires zero-token + journaled,
    deliberate escalates one wake-up, role defaults seeded (+ idempotent re-boot), **R36** single escalation
    (one incident → exactly one wake-up, not N).
- New journal kinds registered (S1) in [`journal/kinds.ts`](../eden/src/journal/kinds.ts) + the pinning
  test + the docs/05 as-built note — exactly the 4 the plan scopes to M5, all already named in the docs/05
  design table, so **no doc-drift**: `subscription.created`, `subscription.removed`, `subscription.fired`,
  `subscription.suppressed`. M6 kinds deliberately NOT pre-registered. The R44 word-boundary guard still
  passes — `subscription.*` contains no tick/pulse/position/pathfinder/physic substring.
- Decisions (D#/R#):
  - **No new D- or R-number.** M5 implements existing resolved mechanisms — R36 (one wake-up + every
    suppressor has a release valve), R9 (benign preemption), P5 (filters are declarative data) — and
    nothing arose they don't already capture (S8). The dumb per-villager per-minute rate cap (R36's
    release valve) already lives in the LLM scheduler (M2-L3); the router's R36 duty is the complementary
    "one incident → one escalation" coalescing.
  - **The deliberate path reaches the brain via an injected `WakeupFn`, not a direct `Brain` import.** A
    direct import would be legal (villagers/→villagers/), but injecting the wake-up keeps `events.ts` free
    of context-pack assembly (persona/memory/snapshot), so M5 proves itself on fakes with a 1-line wake-up
    collector — main.ts wiring of the real context-pack→Brain path is optional for M5 (like M3/M4, proven
    via integration tests on the fakes).
  - **`notWhileRunning` is a SUPPRESSION clause, not a MATCH clause.** The other Filter clauses answer
    "does this event apply?" (a miss → silent skip); `notWhileRunning` answers "should I throttle a
    matching event?" (a hit → `subscription.suppressed{not-while-running}`). The router strips it before
    the applies-check and tests it among the suppressors — matching docs/05's suppression-reason list +
    04's "don't flee-interrupt the flee skill" intent.
  - **`DeliberateHandler.priority` (the frozen `Priority` enum: background/normal/interrupt) maps to the
    scheduler `Lane`** via `PRIORITY_LANE` (interrupt→combat, normal→conversation, background→idle). The
    types/ `Priority` enum was kept as-is (no extension); the lane is derived at route time.
  - **FakeBot grew two M5 seams** (existing seams untouched): a `time:{timeOfDay}` field + `setTime()` (the
    night-falls/new-day emitter edges on it) — mirrored by an optional `time?` on the narrowed `Bot` seam
    (types/bot.ts) so the real mineflayer bot still satisfies it. No other bot seam changed.
  - **`subscribe`/`unsubscribe`/`list_subscriptions` degrade gracefully when no store is wired** (M3/M4
    tests don't wire reactivity): they return an honest "(réactivité non câblée)" message instead of
    throwing, so the ToolRegistry stays constructible without the store.
- SMOKE: **not run — no dev server available in this environment** (consistent with M1–M4). M5 is provable
  entirely on the fakes (FakeBot signals + MemoryJournal + a wake-up collector) — no Minecraft needed; the
  real-bot smoke would attach an EventRouter per villager and pump tick-30s on a 30 s host timer.
- Next: **M6 (society) is the remaining branch off M3-GATE** (memory full port + conversation + trade,
  ∥ M4/M5). M7 converges all branches (admin API complete + derived `views/` + eval harness + v1
  decommission). M6-4 (optional drives) adds `tired`/`lonely` event rows to M5's emitter registry.
- Surprises:
  - The `entity-spotted` EdenEvent carries `entity: string` (a narrowed `name:id`), NOT a typed kind —
    so the `entityKind` filter clause classifies by NAME via a small hostile/animal data table in the
    clause registry (P5: the clause is data; its evaluator is code). This kept the frozen `EdenEvent`
    union untouched (no types/ extension for entity kinds).
  - One transient flake observed: a single full-suite run had `villagers-brain.test.ts` time out under
    parallel load (it spins up a real ScriptedLlm HTTP server — pre-existing M3/M4 behavior, not M5).
    Three subsequent full runs were 298/298 green; M5 added 4 more concurrent test files which nudges port
    contention. Not a logic regression; flagged for the eventual eval-harness port discipline (R42).

## 2026-06-14 — M4 — curriculum + orchestrator + D-13 budget — completed

- Done (all TDD, test authored before each module; `npm run check` green — **250 tests**, of which
  **32 are M4** across 4 new test files: `god-curriculum`, `god-orchestrator`, `loop-integration`,
  `god-budget`). M3 was the gate; M4 replaces its synchronous injection driver with the real
  curriculum→orchestrator→inbox assignment path and adds the cost rails.
  - **M4-1** [`god/curriculum.ts`](../eden/src/god/curriculum.ts) + [`god/prompts/curriculum.md`](../eden/src/god/prompts/curriculum.md)
    (golden) — the `Curriculum` desk, the **SOLE WRITER of the TaskLedger** (S2): every open/completed/
    failed/retired transition flows through it, nothing else mutates `state.ledger`. `proposeTask` (STRONG
    tier — frontier selection compounds, D-13) emits a `propose_task` tool call → the task enters
    `ledger.open` + the task map + journals `god.task-proposed{trigger}`; a no-structured-reply yields no
    task (never throws into the loop). The **QaCache** (`howTo`) answers a "how to X in Minecraft?" question
    once on the FAST tier, embedding-dedups near-identical questions (cosine ≥ 0.92, keyword floor when
    off — R38), persists it, and folds it into `Task.context` — a cache HIT spends **zero** chat calls
    (zero-token reactivity, D-13/R49). `decompose` (STRONG) breaks a big goal into ordered sub-tasks each
    with `parent` set. A **warm-up gate** (config table: `completed.length < 8`) keeps early proposals
    survival-basic. `cleanUpTasks` (Voyager `clean_up_tasks`) retires a `failed` record once a later task
    completes the same goal → `god.task-closed{outcome:'retired'}`.
  - **M4-2** [`god/orchestrator.ts`](../eden/src/god/orchestrator.ts) + [`god/prompts/orchestrator.md`](../eden/src/god/prompts/orchestrator.md)
    (golden) — the `Orchestrator` desk, the **SOLE WRITER of `directivesOpen`** (S2). `dispatch` (FAST
    tier — shallow + frequent, D-13) turns a task/event into `directive` tool calls; `openDirective` is the
    shared sole-writer primitive (LLM dispatch + the real loop both use it) that writes `directivesOpen`,
    delivers to the inbox (journals `inbox.delivered`), and journals `god.directive`. **Anti-thrash is
    engine-enforced**, not prompt-hoped: max 1 open NON-standing directive per villager (a new one
    supersedes the oldest, journaled `god.directive-closed{superseded}` + listed on the new directive's
    payload); no repeat `interrupt` to the same villager within 5 min (the second is **downgraded to
    normal**, not dropped — the order still lands); standing directives coexist. `intervene` is divine
    stage-setting via a structural `DivineActor` (GodBody satisfies it) — it journals `god.appearance` and
    sets a per-task `divineAssisted` flag the critic reads to **void overreach** (D-12); it never does the
    villager's task. `reportToGod` notes a villager objection in the dossier (refusal is information).
  - **M4-3** the full loop — [`main.ts`](../eden/src/main.ts) `RolloutCoordinator` (at the **composition
    root**, because it touches BOTH god/ and villagers/ — a layer-3 actor may never import a peer, the
    dependency law). `runOnce` proposes (curriculum) then `assignAndRun`: orchestrator opens a directive →
    inbox → the villager's brain deliberates **with the directive in its context** → rollout → critic.judge
    (divineAssisted read from the orchestrator) → routeVerdict → revise/close; on close it closes the
    directive too. **GodService now delegates its ledger writes** through a new `LedgerWriter` seam (the
    Curriculum desk satisfies it structurally — no god.ts↔curriculum.ts cycle); the M3 standalone fallback
    is kept so every M3 test passes byte-unchanged. The deferred **main.ts "step 7"** is now live:
    `wireGod` builds the whole God stack behind `enableGod` (defaults to `spawnBots` — CI/tests drive the
    coordinator directly with fakes) and calls `GodService.recoverRollouts()` at boot. **D-09 re-enqueue
    now flows through the REAL path** (extends M3-6): an abandoned task is re-enqueued via the ledger
    writer, then the coordinator re-assigns it through orchestrator→inbox and it re-converges. PROOF: an
    integration test where 1 villager converges through the real path, **3 villagers run unattended and all
    converge**, and a recovered task re-assigns + re-converges.
  - **M4-4** [`llm/scheduler.ts`](../eden/src/llm/scheduler.ts) `BudgetTracker` (consumed, was a skeleton)
    + the desks — **D-13**. Per-desk daily caps default **`null`** and a `null` cap **NEVER degrades**
    (R49: at `maxConcurrent` the throughput ceiling ~3000–3500 calls/day, not the wallet, is the binding
    limiter — a throughput-accounting test pins it). `degradeOnBreach` paths: the **critic** → the
    objective `check` + a templated critique with **zero LLM calls** (a degraded critic never auto-admits —
    no real judgment — but the failing-check rail still vetoes); the **curriculum** → repeat the last task
    type with zero LLM calls; the **orchestrator** → urgent-only (`interrupt`) dispatch. The **strong/fast
    tier split** is wired + tested per request `model`: STRONG = novelty (critic, curriculum proposal +
    decompose), FAST = dispatch + QA-cache. **Verdict batching** (`judgeBatch`) fans up to **3** tickets
    into ONE critic call (the 3-per-call fan-in), maps each verdict back by `ticketId`, applies the D-12
    rails per ticket, and caps the batch at 3.
- New journal kinds registered (S1) in [`journal/kinds.ts`](../eden/src/journal/kinds.ts) + the pinning
  test + the docs/05 as-built note — exactly the 4 the plan scopes to M4, all already named in the
  docs/05 design table, so **no doc-drift**: `god.task-proposed`, `god.task-closed`, `god.directive`,
  `god.directive-closed`. M5/M6 kinds deliberately NOT pre-registered. The R44 word-boundary guard already
  excludes `directive`/`task-*` (no `tick`/`pulse`/`position`/`pathfinder`/`physic` substring).
- Decisions (D#/R#):
  - **No new D- or R-number.** M4 implements the existing resolved mechanisms — D-09, D-13 + R9/R34/R35/
    R36/R49 — and nothing new arose that they don't already capture (S8). D-09's re-enqueue now lands in
    the real assignment path (the M3-6 mechanism was the same; M4-3 just routes it through orchestrator→
    inbox), and D-13's caps/tier-split/batching are implemented exactly as the record specifies.
  - **`LedgerWriter` seam in `god/god.ts`** — GodState is the single home (S2), but the *writes* to its
    `ledger` slice must be the Curriculum desk's alone. Rather than make god.ts import curriculum.ts (a
    cycle — curriculum imports `GodState` from god.ts), GodService takes an optional `ledger?: LedgerWriter`
    interface that the `Curriculum` class satisfies structurally; when wired, all ledger mutations
    (addTask/closeTask/recover re-enqueue) delegate to it (which journals `god.task-*`); when omitted (M3
    standalone), GodService keeps its M3 direct writes. A seam forced by the dependency law, not a design
    change.
  - **`GodState.directivesOpen` is optional (`Directive[]?`)** so the M3 minimal state need not set it; the
    Orchestrator initializes it (`??= []`) and is its sole writer (S2). GodService's default state now seeds
    it `[]`.
  - **The coordinator lives in `main.ts`, not a new layer-3 module.** The plan says "lives in main.ts (the
    composition root) and/or a dedicated integration test — NEVER inside a layer-3 actor." `RolloutCoordinator`
    is exported from main.ts so the integration test imports it; it imports both god/ and villagers/ legally
    because main.ts is the one composition root the dependency law exempts (the `*-no-peers` rules key on
    `^src/god/` etc., not on `main.ts`).
  - **`intervene` takes a structural `DivineActor`, not `GodBody`** — so the orchestrator never imports a
    concrete body and stays trivially testable (the M4-2 test passes a 3-line fake). GodBody satisfies it.
  - **Curriculum/orchestrator carry the budget seam from the start** (optional `budget`/`degradeOnBreach`),
    consumed in M4-4; the critic gained `budget`/`degradeOnBreach`/`batchMax`. No signature churn between
    M4-2 and M4-4 — the options were added once, defaulted off.
- SMOKE: **not run — no dev server available in this environment** (consistent with M1/M2/M3). The real-
  provider smoke (port 25599, R28) is the same loop pointed at a live `/v1/chat/completions` + real bots;
  CI proof is ScriptedLLM + FakeBot per the plan (no Minecraft). The integration test exercises the full
  curriculum→orchestrator→inbox→brain→rollout→critic→admit cycle and the D-09 re-enqueue deterministically.
- Next: **M4 done → M5 (events) and M6 (society) are the remaining branches off M3-GATE** (independent of
  M4). M7 converges all branches (admin API complete + derived `views/` + eval harness + v1 decommission).
- Surprises:
  - The orchestrator must bind a dispatched directive to the **authoritative task id**, not the LLM's echo
    of `taskRef` — otherwise `closeDirectivesForTask` can't find the directive when the task completes (the
    scripted LLM echoed a `$task` placeholder). `dispatch` now overrides `taskRef` with `opts.task.id`.
  - `proposeTask` makes its OWN strong-tier call FIRST, then (if the proposal carries `howTo`) a SECOND
    fast-tier QA call — so a scripted harness must order the turns proposal-then-QA, not QA-then-proposal
    (the test's first cut had them reversed and the proposal call swallowed the QA text).

## 2026-06-14 — ★ M3 — the loop (THE GATE) — completed

- Done (all TDD, test authored before each module; `npm run check` green — **218 tests**, of which
  **48 are M3** across 8 new test files). The spine's heart now closes end to end:
  - **M3-1** [`villagers/context-pack.ts`](../eden/src/villagers/context-pack.ts) — the deterministic
    8-section assembly (identity/trigger/situation/activity/recent/retrieved/capabilities/inbox), each
    with a per-section token ceiling + truncation rule. **D-11 `fitBudget`**: the FRAME and the current
    DENSITY PAYLOAD (current draft + latest RunReport + latest critique) are **never trimmed** (R47);
    only PRIOR revision turns trim, **oldest-first, as whole tool-call/result pairs** — modeled as a
    `RevisionTurn {assistant, results[]}` so a pair *cannot* be split (R20). Per-tier `inputTokenBudget`
    is the ceiling; journals `brain.wakeup` with section sizes. Shared **Snapshot→string** +
    **RunReport→string** renderers live in a new layer-1 [`render/`](../eden/src/render/) (snapshot,
    run-report, tokens) so god/ and villagers/ both use them WITHOUT importing each other.
  - **M3-2** [`villagers/tools.ts`](../eden/src/villagers/tools.ts) — the `ToolRegistry` (S1):
    `search_skills`/`read_skill`/`write_skill`/`run_skill`/`report_to_god`/`done` full; `remember`/`recall`
    (→M6) + `subscribe`/`list_subscriptions` (→M5) honest stubs. **Tier-filtered villager view**:
    `write_skill` exposes NO `tier` field (villager skills are always mortal — 02 §Tiers). `write_skill`
    rejects >`maxSkillLines` (decompose-or-reject, R47) and surfaces parse errors inline; `run_skill`
    trials the rollout DRAFT version (P2) when the name matches the active rollout, else the live version.
  - **M3-3** [`villagers/brain.ts`](../eden/src/villagers/brain.ts) — one deliberation = context-pack →
    tool turns → `done`, the WHOLE conversation inside ONE scheduler slot (rolloutId grants immunity).
    **R20 adjacency**: every assistant tool-call turn is answered by a tool result per call before the
    next provider call — even when `done` shares a turn with other calls — plus a defensive
    `completeDanglingPairs` net (complete the pair, never leave it dangling).
  - **M3-4** [`god/god.ts`](../eden/src/god/god.ts) (`GodService` + minimal `GodState`) +
    [`god/critic.ts`](../eden/src/god/critic.ts) (`CriticDesk`) + [`god/prompts/critic.md`](../eden/src/god/prompts/critic.md)
    (golden). `judge` sees full code + RunReport + before/after snapshots + dossier + last critique →
    `Verdict`. **D-12 rails (one-directional, R48)**: a failed `check` forces `success:false`/no-admit
    (a passing check is NOT an auto-admit); `voidDivineOverreach` voids a divinely-achieved success; it
    judges **world delta** not a clean exit (R34/R35). `routeVerdict` executes the libraryAction
    (admit→active-probation; **un-quarantine→active-probation**, R37/D-12(ii)), delivers the critique to
    the authoring villager's inbox, updates ledger + dossier, journals `god.verdict`, closes/keeps the
    rollout. The God→villager seam is the injected `Inbox` ([`villagers/inbox.ts`](../eden/src/villagers/inbox.ts),
    journals `inbox.delivered`) — god/ never imports villagers/.
  - **M3-5** [`god/body.ts`](../eden/src/god/body.ts) — `GodBody` runs the divine stock skills
    (appear-near/vanish/gesture) on the avatar; `deliverVerdict` is **gated on `embodiedVerdicts`** and
    **best-effort**: avatar down → divine run fails, `deliverVerdict` returns false (journals
    `god.appearance{ok:false}`), the loop still closes. Theatrics are never a dependency.
  - **M3-6** [`god/god.ts`](../eden/src/god/god.ts) `recoverRollouts()` — **D-09 boot-abandon**: every
    open task whose `currentRolloutId` is set → journal `god.rollout-abandoned{reason:'crash-recovery'}`,
    close the orphan rollout, clear the pointer, re-enqueue with fresh maxRetries; the orphan draft stays
    a harmless `draft` (P2). main.ts gains the documented "step 7" hook (live call lands with God wiring
    in M4-3 — no persisted God state to recover until then).
  - **★ M3-GATE** [`tests/gate.test.ts`](../eden/tests/gate.test.ts) — end-to-end on ONE villager +
    "collect 3 oak logs" (`check {oak_log:3}`): ScriptedLLM scripted fail-once-then-fix → the rollout
    converges on the **second revision** to **active-probation** (v2 admitted, broken v1 stays draft),
    the task closes completed, and the **`refs.rolloutId` journal view** shows the complete cycle
    (2×`brain.wakeup`, 2×`skill.run`, 2×`god.ticket`, 2×`god.verdict`, 1×`skill.admit`). A second GATE
    case proves the **check-veto** blocks admission of a no-op that never produced the logs (R34). The
    GATE test IS the M3 injection-path loop driver (it touches both god/ and villagers/, so it lives in
    the test — M4-3 replaces it with the real curriculum→orchestrator→inbox path).
- New journal kinds registered (S1) in [`journal/kinds.ts`](../eden/src/journal/kinds.ts) + the pinning
  test + docs/05 as-built note: `brain.wakeup`, `brain.tool-call`, `brain.done`, `god.ticket`,
  `god.verdict`, `god.appearance`, `god.rollout-abandoned`, `inbox.delivered` — exactly the 8 the plan
  scopes to M3, all already named in the docs/05 design table, so **no doc-drift** (no new kind beyond
  the design). M4/M5/M6 kinds deliberately NOT pre-registered.
- Decisions (D#/R#):
  - **No new D- or R-number.** M3 implements the existing resolved mechanisms — D-09, D-11, D-12 +
    R19/R20/R34/R35/R37/R44/R47/R48 — and nothing new arose that they don't already capture (S8).
  - **New layer-1 `render/` module** ([`render/{snapshot,run-report,tokens}.ts`](../eden/src/render/))
    for the shared pure renderers + token estimator. The plan put "the ONE Snapshot→string renderer
    (shared with God)" in `villagers/context-pack.ts`, but the dependency law forbids `god/` importing
    `villagers/` — so the shared renderer must live below both. `render/` imports only `types/` (new
    dependency-cruiser rule `render-only-types`); a layout deviation forced by the law, not a design change.
  - **D-11 reserve-invariant validator** (declared M0-3, ACTIVATED here) added to `config.ts` as a coarse
    arithmetic floor (config imports only types/ — no token estimator): warns if `strong.inputTokenBudget`
    < `2·maxSkillLines·~12 + 8000` (current draft + ≥1 prior revision + frame/report/critique/headroom),
    R47. The precise per-section budgeting is the context-pack's runtime `fitBudget`.
  - **The M3 rollout loop is a synchronous test-harness driver** (the plan's "tasks seeded by admin
    inject / test harness, NOT curriculum"). It opens ONE rollout per task and revises within it (a
    rollout spans several drafts), so every event shares `refs.rolloutId`. The async, scheduler-driven,
    inbox-woken loop is M4-3 ("replace M3's injection with the real assignment path").
  - **DescriptionPass at admission is wired but optional** (`GodService.describer?`) — omitted in the
    GATE so the deterministic strong-tier turn order (villager↔critic share the strong queue) isn't
    desynced by a fast-tier describe call. M2-5 already proves the pass; convergence doesn't need it.
  - **One M0 test regex tightened**: the R44 "no per-tick kind" guard used `/tick/` which false-matched
    `god.ti**ck**et`; changed to word-boundary `/\b(...|tick|...)\b/` (the guard's true intent). Every
    other pre-M3 test passes byte-unchanged; `journal-kinds.test.ts` legitimately extends the pinned list.
- SMOKE (M3-GATE): **not run — no dev server available in this environment.** The convergence proof runs
  against ScriptedLLM + FakeBot in CI per the plan (no Minecraft). The real-provider smoke (port 25599,
  R28: one villager converges on a live trivial task) is the same loop pointed at a real `/v1/chat/completions`
  + a real bot — a smoke-time concern, consistent with M1/M2's deferral. The GATE's two CI cases exercise
  the full task→draft→run→verdict→revise→admit cycle and the check-veto deterministically.
- Next: **M3-GATE passes → M4/M5/M6 unblocked** (three independent branches off the gate). M4 (curriculum
  + orchestrator + D-13 budget) is the critical follow-on: it replaces the M3 injection driver with the
  real assignment path and wires God into the live host (the deferred main.ts "step 7" recovery call site).
- Surprises:
  - The villager and the critic share the **strong** provider queue (both novelty), so the ScriptedLLM
    turn order in the GATE is villager-deliberation turns then the critic turn, repeating — deterministic
    only because the harness loop awaits each step. A real run separates them by wall-clock; the scheduler
    (God preempts via lane 'god') keeps the ordering sane under concurrency.
  - `bot.give` is a FakeBot affordance the GATE's "fixed" skill uses to simulate ending up with 3 logs so
    the engine's `worldAfter` satisfies the `check` — there is no Minecraft in CI. A real skill mines/collects;
    the smoke exercises that path.

## 2026-06-14 — M2 (skill engine + LLM branch) — completed

- Done (all TDD, test authored before each module; `npm run check` green — **170 tests**, of which
  **78 are M2** across 9 new test files). The two M2 branches (both depend only on layers 0–1)
  landed together:
  - **LLM branch** (peer to the skill engine, gates M3-GATE):
    - **M2-L1** [`llm/client.ts`](../eden/src/llm/client.ts) — provider-agnostic
      `/v1/chat/completions` + `ProviderRegistry`; **R21**: a 180 s timeout that is FINAL (never
      retried), auto-retry ONLY on TCP connection-resets (`ECONNRESET`/`UND_ERR_SOCKET`); journals
      `llm.call` with metrics ONLY (no prompt/completion bodies — a serialization assertion pins it),
      `debugPrompts`→`.eden-data/llm/<callId>.json`. Injectable `fetchImpl`/`now` for deterministic
      tests (R42). Distinguishes timeout vs retriable-reset vs HTTP-error.
    - **M2-L2** [`llm/embeddings.ts`](../eden/src/llm/embeddings.ts) — pluggable backend (provider
      `/v1/embeddings`, lazy in-process transformers.js, or `off`), `cosine` + `keywordScore`
      (unicode/accent-aware — multilingual on purpose), **R38**: 3 CONSECUTIVE failures degrade to
      the keyword floor for the run (a success resets the streak); `embed` returns `null` (never
      throws) so callers fall back.
    - **M2-L3** [`llm/scheduler.ts`](../eden/src/llm/scheduler.ts) — priority lanes
      (`god > player > combat > conversation > directive > job > idle`), global concurrency cap,
      same-(villager,kind) **coalescing**, per-villager **cooldown**, **God preempt**, **rollout
      immunity** (bypasses coalescing/cooldown/rate-cap), and the **R36** dumb per-minute rate cap
      (resets every minute — throttles a burst, never a permanent gag). `BudgetTracker` skeleton
      (per-desk daily caps, `null` = uncapped per R49; caps CONSUMED in M4-4).
  - **Skill-engine branch**:
    - **M2-1** [`skills/instrument.ts`](../eden/src/skills/instrument.ts) — acorn parse (errors
      inline for `write_skill`), loop-budget injection (1e6, **reset on every real `await`** so an
      all-`sleep` spin reaches the critic as futility not the detector), and the **D-08** syscall
      shim as PROVIDED SCOPE GLOBALS (`new Function` factory; the inner skill closes over a shadowed
      `process`/`require`). **R45**: the denylist is FROZEN at exactly four host-killers
      (`exit`/`reallyExit`/`abort`/`kill`) — a test asserts the array is frozen and length 4.
    - **M2-2** [`skills/library.ts`](../eden/src/skills/library.ts) — SOLE WRITER of skill state
      (S2); append-only versioning (code persists to `<dataDir>/library/<name>/v<k>.js` forever),
      the full **D-12** status machine (`upsertDraft`→draft, `admit`→active-probation,
      `recordProbationRun` graduates after N CLEAN runs, `quarantine`, `unquarantine`→active-probation
      NOT active per R37/R48, `archive`), `seedStock` (active directly), `verifyHashes` (boot:
      tampered file → quarantine), `renderSignature` (D-04: generated, can't lie). `GrantPolicy` +
      `AllGranted` (the economy seam, both call sites).
    - **M2-3** [`skills/engine.ts`](../eden/src/skills/engine.ts) — the ONLY executor. Tier gate
      (**R25**, throws before code), `validateArgs`/`validateReturn` (D-04 boundary), `BotRunQueue`
      (**D-05** one tree/bot + `interrupt` preempt → `aborted:'preempted'` R9), `StallDetector`
      (**D-10**: discrete pulses incl. pathfinder `path_update`/dig/window events + sampled pos/inv;
      uniform stallSeconds; in-memory — R44), the hardened abort protocol on every exit (R4/R5 via
      `bots/hardening`), `SkillComposer` (depth cap 8, cycle detect, tier gate, grant gate, the
      **D-12 probation gate** — active-probation runnable directly but NOT composable),
      `FailureTripwire` (`autoQuarantineAfter`, R36 reset-on-success), `ctx.log`→`skill.log`,
      `RunReport`→`skill.run`. Cross-tier R25: the chat interceptor is installed when the avatar
      runs a mortal skill. **D-10(i/ii/iii)** all proven on FakeBot (loop-budget vs stall; pathfinder
      pulses keep a 400 ms stationary "goTo" alive; a never-resolving dig stalls at ~stallSeconds).
    - **M2-4** [`skills/retrieve.ts`](../eden/src/skills/retrieve.ts) — `SkillRetriever`: relevance
      = max(embedding cosine, keyword overlap), tier-filtered (divine invisible to mortal), grant-
      filtered, top-k 8, **P2** surfaces only `active`+`active-probation` (drafts never retrieved).
    - **M2-5** [`skills/describe.ts`](../eden/src/skills/describe.ts) — `DescriptionPass`: fast-tier
      LLM derives `description`/`summary`/`tags` FROM the final code at admission (tolerates fenced
      JSON, falls back without throwing); `library.applyDescription` writes it back.
    - **M2-6** [`skills/exemplars/index.ts`](../eden/src/skills/exemplars/index.ts) — 11 mortal stock
      primitives + 9 divine, seeded `active` (curated review = probation). 6 `exemplar:true` mortal
      teaching skills (`go-to`/`mine-block`/`collect-blocks`/`craft-item`/`use-chest`/`deposit`),
      each ≤60 lines (S4), all run on FakeBot through the engine; **craft-item asserts R1–R3**
      (stray-window close, mutator pause, packet quiescence) and **collect-blocks asserts R10**
      (trunk-only, never floating leaf-logs). Every stock body compiles.
- New journal kinds registered (S1) in [`journal/kinds.ts`](../eden/src/journal/kinds.ts) +
  the pinning test: `skill.draft/admit/quarantine/archive/run/log`, `llm.call` — all were already in
  the docs/05 design table, so **no doc-drift** (no NEW kind beyond the design).
- Decisions (D#/R#):
  - **No new D- or R-number.** M2 implements the *existing* resolved mechanisms — D-04, D-05, D-08,
    D-10, D-12 + R1–R3/R10/R21/R25/R36/R38/R44/R45/R46/R47/R48 — and nothing new was discovered that
    they don't already capture (S8: "new pitfall → next R#; none arose", same as M1).
  - **Stock skills are JS string constants in `skills/exemplars/index.ts`, not separate `*.js`
    files** (the `01`/plan layout said `exemplars/*.js`). Rationale: the code IS data the engine
    compiles; as inline strings it stays out of the lint/tsc surface (a bare `async function` in a
    standalone `.js` trips `no-unused-vars`) and avoids cwd-fragile `readFileSync`. The exemplars
    HAND-ROLL the hardening corpus inline (only `bot`/`args`/`ctx`/`sleep` are in scope — owner #11,
    no wrapper API), so the corpus lives in two places BY DESIGN (docs/04: "implemented once, in
    `bots/hardening.ts` + the exemplar skills"). A minor layout deviation, not a design change.
  - **`makeShim(runtime, shared?)`** gained an optional shared `LoopBudget` so a composed tree ticks
    ONE budget (02 §Composition), via a new `createLoopBudget` export. The existing M2-1 tests are
    byte-unchanged (the param is optional).
  - Layering: the skill engine (layer 2) imports `bots/hardening` (abort protocol + chat interceptor)
    — `skills/ → bots/` is downward and dependency-cruiser-clean. `skills/retrieve` → `llm/embeddings`
    (both layer 2, no cycle) is the one intra-layer edge the plan DAG sanctions.
- SMOKE (M2-6 / M3-GATE prerequisite): **not run — no dev server available in this environment.**
  The exemplars are validated against FakeBot in CI per the plan (no Minecraft); the real-server
  smoke (port 25599, R28) and the exact real-mineflayer surfaces a few stock bodies use (pathfinder
  `Goal` classes, furnace/anvil windows, `bot.craft` signature) are a smoke-time concern — consistent
  with M1's deferral of land-bot `Movements` tuning. The M3-GATE convergence test exercises a real
  provider end-to-end.
- Next: **★ M3 — the loop (THE GATE)**: M3-1 context-pack (D-11 `fitBudget`), M3-2 tools (ToolRegistry),
  M3-3 brain (R20 adjacency), M3-4 god+critic (D-12 check-veto, R34/R35 world-delta), M3-5 god/body,
  M3-6 D-09 rollout fields + boot-abandon, then **M3-GATE** (one villager converges on a trivial task).
  M4/M5/M6 must NOT start until M3-GATE passes.
- Surprises:
  - The scheduler had to **defer its drain to a microtask** (`queueMicrotask`): draining eagerly
    inside the first `enqueue` let the first arrival grab the only slot before its higher-priority
    lane-peers were even enqueued — and broke same-tick coalescing. Deferring lets a synchronous
    burst settle, then lane priority + coalescing are correct.
  - The loop-budget reset-on-await leaves ONE residual footgun: a pure-microtask spin
    (`while(true){ await Promise.resolve() }`) starves the macrotask queue so even the wall-clock
    timer can't fire. This is a known facet of the D-08/R45 "footgun removal, not a sandbox" posture
    (determined escapes remain reachable by design) — not a new R-number; the worker-thread escape
    hatch (08 §Scaling) is the pre-decided last resort if it ever bites.
  - Grew `FakeBot` with an M2 `craft`/`recipesFor` seam (over the EXISTING R1–R3 window/packet/
    auto-eat seams — seams unchanged, behavior added) so the craft-item exemplar is runnable and can
    assert R1–R3. Consistent with the plan's "FakeBot grows M0→M1→M2".

## 2026-06-14 — M0+M1 coverage pass — completed

- Done (`npm run check` green, **25 new tests**, **114 total** = 89 pre-existing + 25 added):
  - Audited all M0+M1 modules against docs/16-m0-reference.md error-mode lists and docs/07
    R-numbers; identified and filled the highest-value uncovered branches across 6 test files
    (all fakes-only, deterministic, house style).
  - **`bots/pool.ts`** ([`tests/bots-pool-coverage.test.ts`](../eden/tests/bots-pool-coverage.test.ts)):
    - `world.death` with an object `message` → `JSON.stringify` cause (R27 object branch).
    - `world.death` with no message field / null packet → no `cause` key in payload (R27 fallback branches).
    - `snapshotVitals` skips bots still in `connecting` state (R44 skip guard).
    - `system.bot-disconnected` journalled on `'end'` and `'kicked'` events with their reasons (R13).
    - `stop()` cancels the pending reconnect timer — no new `createBot` calls after stop (50 ms timing, R13).
    - `stop()` is idempotent — second call does not throw.
  - **`bots/hardening.ts`** ([`tests/bots-hardening-coverage.test.ts`](../eden/tests/bots-hardening-coverage.test.ts)):
    - `waitForInventoryQuiescence` hard-timeout fires when packets never settle (R39 safety valve).
    - `abortActiveTasks` continues the full abort sequence when `pvp.stop()` rejects (R4/R5).
    - `craftQuiescence` restores auto-eat and armor-manager in the `finally` path when `fn()` throws (R3).
  - **`bots/anchors.ts`** ([`tests/bots-anchors-coverage.test.ts`](../eden/tests/bots-anchors-coverage.test.ts)):
    - Corrupt per-bot JSON file → re-heals from config without crashing (R18 `load()` catch path).
    - `save()` preserves other top-level keys (skills/memories) already in the file (R18 merge path).
    - Home hint BELOW real ground snaps UPWARD to the first standable spot (R18 `y + d` branch).
  - **`bots/helpers.ts`** ([`tests/bots-helpers-coverage.test.ts`](../eden/tests/bots-helpers-coverage.test.ts)):
    - `goToHops` throws a precise S10 error when the bot has no pathfinder plugin (R16/S10).
    - `goToHops` throws a precise S10 error when the bot has no entity body (S10).
    - `collectTrunk` stops at the `maxHeight` cap even when the column continues above it (R10).
    - `useChest` throws a precise S10 error when no block exists at the chest position (R8/S10).
  - **`admin/server.ts`** ([`tests/admin-coverage.test.ts`](../eden/tests/admin-coverage.test.ts)):
    - GET unknown route → `404 { error: "no route <path>" }`.
    - GET `/status` when `getStatus()` throws → `500 { error: "<message>" }` (handler crash-isolation).
    - GET `/journal?until=<ms>` excludes events after the cutoff (verifies `parseJournalQuery` passes `until` through).
  - **`journal/journal.ts` + `MemoryJournal`** ([`tests/journal-coverage.test.ts`](../eden/tests/journal-coverage.test.ts)):
    - `Journal.fan()` crash-isolation: a throwing subscriber does not break subsequent subscribers or the write path (P4).
    - `Journal.query({ until })` excludes events after the cutoff.
    - `MemoryJournal` fan-out crash-isolation (same P4 guarantee).
    - `MemoryJournal.query({ until })` — same semantics as the real Journal.
- New fake seams: none required — all branches driven via existing FakeBot/MemoryJournal seams or direct
  property overrides on FakeBot (e.g. `(bot as any).pvp.stop` replaced inline in test; `(bot as any).entity`
  nulled for the dead-body path). Pattern: tests/- exempts `any` rules so casts are clean without `eslint-disable`.
- Bugs found: none. All new tests exercise existing code paths that were reachable; no assertion exposed
  wrong behaviour. (One pre-existing ESLint warning in `src/skills/instrument.ts` line 156 — unused
  `eslint-disable` for `no-new-func` — pre-dates this session; not introduced by these tests.)
- Deferred / not tested (timing constraints or integration-only):
  - Reconnect backoff ESCALATION (1 000 → 2 000 → 5 000 → 10 000 → 30 000 ms): the schedule is hardcoded in
    `RECONNECT_BACKOFF_MS` (not exported, not configurable from `BotPoolOptions`). Verifying escalation
    requires waiting >8 s in sequence; left for integration smoke against a real server.
  - Reset-on-spawn (reconnectAttempts = 0 after a successful re-login): observable only after a 1 000 ms
    backoff fires. The `stop()` cancels-reconnect test (50 ms) gives confidence the timer machinery works;
    a full cycle test would be a 1 200 ms wall-clock test and was judged low value vs the existing
    behaviours proven.
- Next: M2 (skill engine) + M2-L* (LLM client) — dependencies on layers 0–1 only.

## 2026-06-13 — M1 (bodies) — completed

- Done (all TDD, test authored before each module; `npm run check` green, **67 tests** =
  43 M0 + 24 M1):
  - **M1-1** [`bots/hardening.ts`](../eden/src/bots/hardening.ts) — the R1–R10/R25 corpus:
    `boundPathfinder` (R6 2s/10ms/64), `abortActiveTasks` (R4/R5 ordered: collect-cancel → pvp
    stop → pathfinder stop **then** setGoal(null) → close window → settle macrotask),
    `craftQuiescence` + `waitForInventoryQuiescence` (R1–R3: close stray window, pause auto-eat
    + armor-manager, resolve only on `set_slot`/`window_items` packet quiescence), and
    `installChatInterceptor` (R25 — drops `/`-chat). Plugin loading split into
    [`bots/plugins.ts`](../eden/src/bots/plugins.ts) (named imports for the trio + auto-eat R15,
    per-plugin fallible R16, `AUTO_EAT_OPTS` ported verbatim R17). Tests assert the abort SEQUENCE
    ORDER, the bounds, the interceptor, packet-settle, and fallible-load + verbatim config.
  - **M1-2** [`bots/helpers.ts`](../eden/src/bots/helpers.ts) — `goToHops` (≤40-block legs R7),
    `collectTrunk` (column-connected-to-ground, one dig/iter, skip-on-failure, never chases
    floating leaf-logs R10), `useChest`/`deposit`/`withdraw`. Tests: hop legs ≤40; trunk-only
    collection; skip-on-failure; chest round-trips.
  - **M1-3** [`bots/pool.ts`](../eden/src/bots/pool.ts) — 11 staggered logins (`LOGIN_STAGGER_MS`
    = 4 s, avatar LAST, R13/I1), `viewDistance:'short'` (R8), protocol pin 1.21.1 (R11), keepalive
    90 s (R13), reconnect backoff, journals `system.bot-connected/-disconnected` + **`world.death`**
    from the `death_combat_event` packet (R27/G2), op-as-avatar-only read-contract (R14: the pool
    never ops; exactly one divine member), `stampWorldId` data-dir world stamp (R32).
  - **M1-5** vitals — per-bot snapshot every `vitalsIntervalSeconds` (the journalled SUMMARY of
    in-memory pulses; ZERO pulse events — R44). Test asserts 11-bot per-tick coverage + schema.
  - **M1-4** [`bots/anchors.ts`](../eden/src/bots/anchors.ts) — `AnchorService` (R18): home snaps
    to standable ground, missing chest re-discovered (nearest chest/trapped_chest/barrel),
    overrides persist to `.eden-data/bots/<name>.json` and WIN over config, ONE loud warn on an
    unrecoverable anchor (no error loop). Tested on a FakeBot world fixture.
  - Wired `BotPool` into [`main.ts`](../eden/src/main.ts) behind `spawnBots` (default **false** so
    CI/tests never touch Minecraft); the direct-run entrypoint sets it true and the staggered login
    is kicked without blocking host readiness. `/status` now reports the live connected count.
  - New journal kinds registered (S1): `vitals`, `world.death` (kinds.ts + tests + docs/05).
  - Grew `FakeBot` with the M1 seams (pathfinder/pvp/collectBlock plugin objects, an ordered
    `calls` recorder for the abort assertion, chat/loadPlugin/quit, vitals fields, a chest+registry
    seam) and a compile-time `const _: Bot = new FakeBot()` proof.
- Decisions:
  - **D-14 — the `Bot` seam is a narrowed interface in `types/` (layer 0)** ([`types/bot.ts`](../eden/src/types/bot.ts),
    recorded in docs/11 §3). Real mineflayer Bot structurally satisfies it; pool casts through
    `unknown` at the one `createBot` boundary (plugins attach post-spawn). Keeps `bots/` layer-1
    and CI fakes-only.
  - **G2 — `world.death` provisionally added** as a kind row (S8), flagged loudly in docs/05 +
    PROGRESS as an **owner call** on name/shape (the owner may prefer `system.bot-disconnected{cause}`).
    Behavior is live and tested; only the name/shape is open.
  - **I1 — login stagger = 4 s** (`01` normative over `11`'s 2 s), a hardcoded `LOGIN_STAGGER_MS`,
    not a config key. docs/11 §3 BotPool note corrected to ~4 s.
  - Added `mineflayer` + pathfinder/pvp/collectblock/tool/auto-eat/armor-manager + vec3 to
    eden/package.json (v1's pinned versions). Two untyped packages (pathfinder, armor-manager) get
    minimal ambient decls in [`src/vendor-mineflayer.d.ts`](../eden/src/vendor-mineflayer.d.ts).
  - No new R-number: M1 implements the existing R1–R10/R13/R14/R18/R25/R27/R32/R44 corpus; nothing
    new was discovered that those don't already capture (S8: new pitfall → next R#, none arose).
  - One M0 test file changed by necessity: `tests/journal-kinds.test.ts` (it pins the exact kind
    list, which M1 legitimately extends — S1/S8). All other 43 M0 tests pass byte-unchanged.
  - Deferred (not M1 acceptance criteria, noted to avoid surprise): v1's land-bot `Movements`
    hazard tuning (water/parkour/drop) is not ported — `boundPathfinder` (R6) + `viewDistance`
    (R8) are the numbered hardening; the cost-model tuning can land with an exemplar/pool pass if a
    smoke shows villagers drowning. `AnchorService.heal` is not yet *called* by the pool (no consumer
    until villager boot, M3+); it exists + is tested per M1-4.
- SMOKE (M1-3/M1-4): **not run — no dev server available in this environment.** The smoke is a
  manual step: start the dev server on **25599** (`run/server.properties`, R28), boot Eden with
  `tsx src/main.ts eden.json` (spawnBots on), and verify in `GET /journal` that 10 villagers +
  the avatar journal `system.bot-connected` with no disconnect storm (R13), `vitals` flows at
  ~1.1 ev/s, and a forced death journals `world.death` with the packet cause (R27). Anchors heal
  is exercised once the pool calls it (M3+); the M1-4 unit fixture stands in for now.
- Next: **M2** (skill engine) + the LLM branch (`M2-L*`) concurrently — both depend only on
  layers 0–1, which now exist end to end. FakeBot's D-10 + R1–R3 seams (fixed in M0, extended in
  M1) are ready to drive the M2 executor.
- Surprises: `mineflayer-pathfinder` and `mineflayer-armor-manager` ship NO type declarations
  (needed ambient decls); the rest do. eslint's `no-this-alias` rejected a `const self = this`
  in the FakeBot chest seam — arrow functions capture `this` directly, so it was unnecessary.

## 2026-06-13 — M0 (spine) — completed
- Done: scaffolded `eden/` (M0-1) — package.json (type:module, Node 22+, tsx,
  node:test), tsconfig (strict), `.dependency-cruiser.cjs` enforcing the full
  dependency law, ESLint flat config banning `console.*` outside logger.ts (R23),
  `eden.example.json` with every config key + the port registry (R24),
  `eden/CLAUDE.md`. Then M0-2 (types/ layer 0), M0-3 (config + logger),
  M0-4 (journal kinds + WAL writer + lag monitor, D-07), M0-5 (fakes:
  FakeBot + ScriptedLLM + in-memory journal), M0-6 (admin /status + /journal + WS).
  All TDD: tests authored before each module. M0-7: as-built UML in
  [docs/15-m0-as-built.md](15-m0-as-built.md) — four mermaid diagrams
  (package/layer, class, boot sequence, runtime data paths) with prose on the S1
  registry seam and M0 invariants.
- Decisions/notes:
  - Test runner: node:test via tsx (zero extra runner dep, Node 22+). v1 used ava;
    Eden starts clean.
  - JournalKind: the string-literal union + per-kind payload types live in
    `journal/kinds.ts` (the S1 registry, `satisfies` exhaustiveness); `types/JournalEvent`
    keeps `kind: string` so types/ imports nothing (the law) — the sole writer
    (journal.ts) enforces the union at its `append` signature.
  - Lag monitor factored into `journal/lag-monitor.ts` (takes a journal appender) so
    D-07 is testable against the in-memory fake without booting main.ts.
  - G1 (retention key) left as a TODO comment in eden.example.json + config — hardcoded
    7d for now, owner call pending. G2 (death kind) is M1, not touched yet.
  - Login stagger resolved to 4 s (01 normative over 11's 2 s) — recorded for M1.
- Next: M1 (bots: hardening corpus R1–R10, pool, anchors, vitals) — needs a real or
  fake mineflayer bot; smoke on 25599. The LLM branch (M2-L*) can start concurrently
  with the M2 skill engine since both depend only on layers 0–1.
- Surprises: machine runs Node 24, not 22 — engines set to >=22, everything compatible.

## 2026-06-13 — M0 reference doc + TSDoc pass
- Done: wrote [docs/16-m0-reference.md](16-m0-reference.md) — the prose developer
  reference to the as-built M0 spine (module-by-module: purpose/layer/state, public
  surface, semantics, invariants by R/D/S number, error modes, usage example, and the
  pinning test for each of types/config/logger/journal-kinds/journal/lag-monitor/admin/
  main; plus reference tables for config keys, journal kinds, admin routes; the test
  fakes; extension recipes; and the G1/G2/layers-2-3 gaps). Cross-links docs/15 (visual)
  rather than duplicating the diagrams. Added concise TSDoc to every previously
  undocumented exported symbol under `eden/src` (zero behavior change — `npm run check`
  stays green, 43/43). Indexed 15 + 16 in [docs/README.md](README.md) and pointed
  [eden/CLAUDE.md](../eden/CLAUDE.md) at 16.
- Decisions/notes: docs/16 is the "accurate to the line" companion; where it and the
  design docs (11/12) disagree, the code (and 15/16) win, same as 15. No new R/D numbers.
- Next: unchanged — M1 (bots: hardening corpus R1–R10, pool, anchors, vitals).
- Surprises: none.

## 2026-06-15 — website API gaps: RolloutsView + GET /rollouts + GET /journal?id=
- Done: while drafting the future-website design brief, three admin-API gaps surfaced.
  Resolved keeping the pure-consumer posture (reads fold the journal; add surface only
  where existing routes can't express it):
  - **`RolloutsView`** — a 5th derived view ([eden/src/views/index.ts](../eden/src/views/index.ts)),
    added to `ALL_VIEWS` so the rebuild==live law + `eden rebuild-stats` cover it. Folds the
    `refs.rolloutId`-tagged stream into a per-rollout index (`status: open|admitted|exhausted|
    abandoned`, `trials`, villager/skill/taskId, started/endedAt). Wired in main.ts (views +
    live fold + admin accessor); surfaced as **`GET /rollouts`**. Replay stays `GET /journal?ref=`.
  - **`GET /journal?id=<ulid>`** — `JournalQuery.id` added (types + Journal + MemoryJournal +
    admin parse) for the command bar's id-resolution; no `/resolve` route (names resolve
    client-side; ulids via `?ref=`/`?id=`).
  - **Budget history** judged NOT a gap — folds `llm.call` client-side; `/status` keeps live spend.
  - Tests: RolloutsView unit tests (views.test.ts), real-journal rebuild==live (rebuild-stats.test.ts),
    `GET /rollouts` + unwired-empty + `?id=` routes (admin-routes.test.ts). `npm run check` green
    (lint/typecheck/depcruise clean, 410/410).
- Decisions (D#/R# if any): no new D/R; NO new journal kind (S1 — reads + folds existing kinds).
  Honest limit recorded in code + 05: retries-exhausted has no per-rollout terminal event, so
  `exhausted` is derived from `god.task-closed{outcome:'failed'}` over the task's still-open rollouts.
- Next: hand the design brief + resolved API to the website design phase.
- Surprises: none.

## 2026-06-16 — curriculum sees inventory + existing skills; mission outranks warm-up (R67)
- Done: `scenarios/farm.json` gave the farmer an `iron_hoe` + seeds and a `godPrompt` for a bread loop,
  but God kept proposing "explore for wood to craft a hoe." Root cause: the curriculum's proposal context
  was blind. Fixed in [eden/src/god/curriculum.ts](../eden/src/god/curriculum.ts):
  - **Inventory in the proposal.** `proposeTask` now takes the requesting villager's live `Snapshot`;
    `renderProposalContext` renders `## INVENTAIRE ACTUEL` + an explicit no-re-acquire guard. The
    `RolloutCoordinator.runOnce` threads `snapshotFor(villager)` in (main.ts).
  - **Existing skills in the proposal.** Inject `SkillLibrary`; `## COMPÉTENCES EXISTANTES` lists live
    MORTAL skills (divine filtered out) so God proposes COMPOSING what exists plus one new step.
  - **Mission outranks warm-up.** New `hasMissionDirective` flag (set in main.ts when a scenario
    `godPrompt` is present) flips the warm-up nudge from the generic "gather wood/food/tools" default to
    "serve the mission with the current inventory + skills." (The default never lifted on its own: a
    non-converging loop task closes `failed` per R65, so `completed` stayed 0 → permanent warm-up.)
  - Prompt ([curriculum.md](../eden/src/god/prompts/curriculum.md)) aligned to the now-rendered context;
    adds "read inventory before proposing acquisition," "mission outranks defaults," and a decompose
    EXCEPTION: when the blocks already exist and the mission wants one looping skill, that composing
    skill is a legitimate single goal — don't fragment it into busy-work.
  - Tests: 3 new cases in `tests/god-curriculum.test.ts` (inventory awareness, mission-aware warm-up,
    library coverage hides divine). `npm run check` green (lint/tsc/depcruise clean, 519/519).
- Decisions (D#/R# if any): **R67** filed (curriculum must see inventory + existing skills; a scenario
  mission outranks the warm-up default). No new D#, no new journal kind (S1).
- Next: restart the live host to pick up the change; re-run the farm scenario and confirm God proposes the
  bread-loop composing task instead of wood-gathering.
- Surprises: the curriculum.md prompt already *claimed* "village stock" + "library coverage" were given —
  S6 prompt/code drift that had gone unnoticed because no golden snapshot pinned the proposal-context render.

## 2026-06-16 — villager memory wired into the brain (recall actually recalls) (R69)
- Done: report — "villagers don't seem to be able to recall memory." The whole M6 `VillagerMemory` subsystem
  was built/green but **orphaned**: connected to nothing the brain uses. Two cuts, one root cause (R69):
  - **The `recall`/`remember` tools were dead.** The `ToolRegistry` is ONE shared instance across all
    villagers (state lives in `ctx`), but its memory option was a single `memory?: VillagerMemory` that
    `main.ts` never passed — so the tools always returned the `(mémoire non câblée)` stub. Changed it to a
    per-villager RESOLVER `memoryFor?: (villager) => VillagerMemory | undefined` (the same shape as
    `engine.resolveBot`/`snapshotFor`); `recall`/`remember` now look memory up by `ctx.villager`.
    [eden/src/villagers/tools.ts](../eden/src/villagers/tools.ts).
  - **§6 `MÉMOIRE PERTINENTE` was always empty.** Both `ContextPackInput` sites (the `RolloutCoordinator`
    authoring loop + the reactive-wakeup path) hardcoded `memories: []`. They now pre-load §6 from
    `memory.retrieve(goal/query, k)` — proactive recall, the prompt section that was always specced.
    [eden/src/main.ts](../eden/src/main.ts).
  - Wiring: `main.ts` builds the per-villager `memories` Map BEFORE the shared `ToolRegistry`, wires
    `memoryFor = (name) => memories.get(name)` into both the registry and the `RolloutCoordinator`.
  - Tests: the 3 existing memory-tool tests moved to the resolver shape + a new regression pins that the
    shared registry never leaks one villager's memory to another. `npm run check` green (lint/tsc/depcruise
    clean, **521/521**).
- Decisions (D#/R# if any): **R69** filed (a shared, per-villager-stateless service must RESOLVE its
  per-villager dependency, never hold one instance; a subsystem isn't "done" until a `main.ts` path reaches
  it). No new D#, no new journal kind (S1).
- Next: restart the live host to pick up the change. KNOWN REMAINING GAP — nothing yet *writes* villager
  memory in production except the now-working `remember` tool: `social/Conversation` (the `hear`/leave
  MemoryWriter path) is still not constructed in `main.ts`/`village-launch.ts`, so memory fills only as fast
  as villagers self-note. Wiring the conversation service (bot-backed Conversant/ReachStrategy) is the next
  society step if richer organic recall is wanted.
- Surprises: the memory module's unit tests were all green the whole time — the bug was 100% in the
  composition root (an option that existed on the type but never appeared at the `new ToolRegistry({…})` call
  site). Green module tests ≠ wired.

## 2026-10-05 — villager trade wired to the :8767 settlement listener (D-16) + settlement token
- Done:
  - **Trade is wired.** `main.ts` keeps one `SettlementClient` (it used to be `void new …`) and builds a
    `TradeBook` (social/trade.ts) injected into `ToolRegistry` as `trade`. Three villager tools:
    `propose_trade {to, give, want}`, `answer_trade {id, accept}`, `list_trades`. They reach the book through
    the new `TradeDesk` seam in `types/social.ts` (`TradeOffer`/`SettlementResult`/`PendingTrade` moved there;
    social/trade.ts re-exports them). An offer wakes the partner on the conversation lane (the reactive
    `wakeup`, live pool only) and lands in its inbox; the partner's accept runs `TradeService.settleProposed`
    (R33: walk to the proposer with `go-to`, aiming within 8 blocks — the mod refuses beyond its
    `maxTradeDistance`, default 16) and the POST. Outcomes go to the proposer's memory as a `trade` entry.
  - **Settlement token.** `SettlementClient` sends `X-Village-Token` when given a token; `main.ts` reads it from
    `EDEN_SETTLEMENT_TOKEN` (env-only, like the LLM key). Matches the mod's optional `settlementToken`.
  - `TradeService.propose` split into propose (journal) + `settleProposed` (reach + settle); a throwing
    `walkTo` is now caught and named in the failure reason instead of escaping.
  - Tests: +11 (token header on/off, propose-without-settle, partner-only accept, decline/withdraw, expiry,
    double-accept race, validation incl. a non-villager partner, R33 on accept + a throwing walk, the tool
    round-trip, unwired stubs); golden tool list updated. `FakeSettlement` records request headers.
- Decisions (D#/R# if any): **D-16** (docs/04 §The brain) — a trade moves nothing until the partner accepts;
  only roster villagers trade; offers expire after 5 min, max 3 open per proposer; decline/withdraw/expiry
  close as `trade.failed` (no new journal kind, S1).
- Next: one live `:8767` smoke trade (two online villagers, a `coin` line) — CI proves the body, header and
  consent flow on fakes only. Conversations (`say`/`tell`/`start_conversation`) are still unwired.
- Surprises: `TradeService.propose` settled with no consent step, so wiring it straight to a tool would have
  let any villager take another's items — the mod swaps whatever it is asked to.

## Template
## YYYY-MM-DD — <milestone/topic>
- Done:
- Decisions (D#/R# if any):
- Next:
- Surprises:
