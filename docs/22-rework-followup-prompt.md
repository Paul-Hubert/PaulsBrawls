# 22 — Finish the `rework` branch: fix the open bugs, wire what's designed, re-verify `docs/system` — agent kickoff prompt

> Hand this whole file to an agent. It picks up the `rework` branch after the trade fixes landed
> (VERIFICATION-NOTES bugs #1–#3 are fixed and villager trade is wired, D-16). Three jobs, in order:
> **(A)** make the test gates trustworthy, **(B)** fix the remaining ranked bugs and wire the designed-but-unwired
> Eden pieces, **(C)** analyse every code change since the `docs/system` corpus was verified and bring the
> corpus back in line with the code. Work on `rework`. `cd eden ; npm run check` and the Java tests MUST end
> green, and every commit must leave them no worse than it found them.

---

## 0. Where things stand (checked at `413cd4a`, 2026-10-05)

**Branch history since the corpus was verified** (`docs/system/**` all say `verified_at: 4a8081f`):

| Commit | What changed |
|---|---|
| `6a0ea7e` (merged via `56f3796`) | Java: settlement + `/accept` duplication fixes, `TradeMath` + `TradeMathTest` (bugs #2, #3) |
| `0699f9e` (merged via `31c3fea`) | Eden: settlement body `{botA,botB,aGives,bGives}`; `FakeSettlement` ports `validateShape` (bug #1 shape) |
| `31c3fea` | merge resolution: docs combined; `FakeSettlement` same-party check made case-insensitive to match Java |
| `ecd7ca0` | root + `eden/CLAUDE.md` corrected against the code |
| `413cd4a` | Eden: `TradeBook` + `propose_trade`/`answer_trade`/`list_trades`, `X-Village-Token` from `EDEN_SETTLEMENT_TOKEN` (D-16) |

Code files changed since `4a8081f` (`git diff --stat 4a8081f HEAD -- . ':!docs'`): `build.gradle`,
`eden/eden.example.json`, `eden/src/{journal/kinds.ts,main.ts,social/trade.ts,types/social.ts,villagers/tools.ts}`,
`eden/tests/{fakes/fake-settlement.ts,social-trade.test.ts,villagers-tools.test.ts}`,
`src/main/java/com/paul/brawl/{ChatBotActions,ChatBotFunctions,TradeMath,TradeOffers,VillageConfig,VillageHttpListener}.java`,
`src/test/java/com/paul/brawl/TradeMathTest.java`.

**Test baseline** (Node 22.22; the owner's machine runs Node 24 — re-measure there if you can):

- `npm test`: 545 tests, 516 pass, **29 not ok**:
  - 1 fails: `tests/live-tests-catalogue.test.ts` needs the gitignored `eden/providers.json` (bug #4).
  - **28 are cancelled**, deterministically, even when the file runs alone:
    `tests/fakes.test.ts` (7), `tests/skills-engine.test.ts` (13), `tests/llm-scheduler.test.ts` (4),
    `tests/skills-exemplars.test.ts` (4). The error is `cancelledByParent` / *"Promise resolution is still pending
    but the event loop has already resolved"*. **Not in the bug table.** Working hypothesis (verify, don't
    assume): those tests await promises that only `.unref()`'d timers resolve (`tests/fakes/fake-bot.ts:304,464`,
    `eden/src/llm/scheduler.ts:191`, `eden/src/skills/engine.ts:268-311,510,568`), so `node:test` sees an empty
    event loop and cancels them. Check whether Node 24 behaves differently before blaming the version.
- Java: `gradle test` → `TradeMathTest` 11/11. **No Gradle wrapper is committed** (`gradlew*` and `gradle/` are
  gitignored); use `./gradlew` if it exists locally, else a system `gradle` (8.14.3 works with Loom 1.11.8).
  Pass `-Pmods_folder=path/to/your/mods -Pclient_mods_folder=path/to/your/mods` so the copy tasks are skipped.
- `node docs/system/build-index.mjs --check` passes — **but that proves nothing about drift.** The validator only
  checks that a cited line *exists*, not that it still *says* what the doc claims (`docs/system/README.md`
  §"Keeping it valid"). `eden/src/main.ts` grew ~43 lines around `:550` in `413cd4a`, so most `main.ts:<n>`
  citations past that point now point at the wrong line and still validate.

**Doc fan-out of the changed files** (docs whose `sources:` list them — recompute with
`grep -rl <file> docs/system --include=*.md`): `eden/src/main.ts` alone is cited by 20 docs; the Java trade files by
the `aigod/*`, `gibber/money-system`, `platform/entrypoints-and-wiring`, `reference/*` and `eden/java-integration`
docs. Roughly 30 of the 34 docs need a citation pass.

---

## 1. Hard rules — bake these in

1. **Reproduce before you fix.** For every bug: re-read the code at HEAD (the bug table cites `4a8081f`, lines have
   moved), write a failing test that pins it where the code is testable, then fix. If the bug no longer reproduces,
   say so in VERIFICATION-NOTES instead of "fixing" it.
2. **One bug (or one wiring item) per commit.** Behaviour + the docs it touches change in the same commit (S8). The
   final corpus-wide pass (§5) is its own commit(s).
3. **Runtime boundaries.** An Eden commit touches only `eden/` and `docs/`. A Java commit touches only `src/`,
   `build.gradle` and `docs/`. Never touch `minecraft-mcp-server/` (an empty gitlink here — its claims stay
   `⚠ Unverified`).
4. **Eden rules** (`eden/CLAUDE.md`, `docs/08`): dependency law (dependency-cruiser must stay at 0 violations;
   layer-3 actors reach each other only through `types/` seams, the way `TradeDesk` and `memoryFor` do); no
   `console.*` outside `logger.ts`; every error names its subject + args (S10); additions are registry rows, not
   branches (S1); a new pitfall gets the next `R#` in `docs/07` (latest is R72), a new design choice the next `D#`
   (latest is D-16, in `docs/04`); append one dated section to `docs/PROGRESS.md` per session.
5. **"Wired" means a `main.ts` path reaches it** (R69). A module test passing proves nothing about wiring; add a
   test that drives the behaviour through the composition root (see `tests/main-full-wiring.test.ts`), or say
   explicitly that only a live run can prove it.
6. **Never** skip, `.skip`, delete or loosen a test to get green; never change an asserted value without saying
   why the old one was wrong. A golden snapshot change (S6) is a deliberate schema change and the commit says so.
7. **Player-facing and LLM-facing strings stay French**, matching the surrounding code.
8. **Owner decisions are not yours.** §4 lists the items where the "fix" changes intended behaviour or needs a
   secret. Flag them in the final report; don't silently change them.

---

## 2. Phase A — make the gates trustworthy (do this first; everything after depends on it)

### A1. The 28 cancelled tests (new finding)
Diagnose the cancellation in the four files above. Find the root cause (the unref'd-timer hypothesis, or
whatever it really is), then fix it **in the tests or fakes**, not by removing the production `unref()`s: those
exist so a real host's timers don't keep the process alive. Typical shapes of a right fix: a test-only keep-alive
handle for the duration of the awaited promise, injected fake timers, or the fake exposing a ref'd mode. Prove it:
all four files run with 0 cancelled, alone and in the full run. File it as the next `R#` if it is a real pitfall
(it is one if production code could hit the same "awaited promise only an unref'd timer can resolve" shape).

### A2. Bug #4 — `npm test` fails on a clean checkout
`tests/live-tests-catalogue.test.ts` loads gitignored `eden/providers.json`. Make the test independent of the
user's real file (validate the catalogue against `providers.example.json`, or skip the provider-dependent assertion
**with a visible reason** only when the real file is absent — but a skip-to-green is exactly what rule 6 forbids,
so prefer the example file). Then update `eden/CLAUDE.md` (it currently tells people to copy the file to make tests
pass) and `docs/system/eden/testing-eval-live.md`.

**Gate:** `npm run check` fully green on a clean checkout with no `providers.json`. Commit.

---

## 3. Phase B — fix the rest

Work in this order. Re-verify each item at HEAD first (rule 1); the bug numbers are
`docs/system/VERIFICATION-NOTES.md` §1.

### B1. Eden correctness bugs (`eden/` + `docs/`)
| # | Item | Notes |
|---|---|---|
| — | Subscription tools are stubs in the live host | `ToolRegistry` is built before the `SubscriptionStore` exists, so `subscribe`/`unsubscribe`/`list_subscriptions` return `(réactivité non câblée…)`. Construct the store first and pass `subscriptions` (VERIFICATION-NOTES §6). Small, high value. |
| 14 | `use-chest` / `smelt-item` disable auto-eat/armor-manager on a failed open | `pauseMutators` sits before the `try`. Move it inside so `finally` always resumes. Pin with a FakeBot test whose window open fails. |
| 13 | Aborted skill code keeps running after timeout/stall/preempt; skill names aren't sanitised as directory names | Two separate commits. The first breaks D-05 (one tree per body) — the abort must actually stop the next tree from starting on a still-running body (an abort flag the instrumented loop budget checks, plus serialisation that waits for the old tree to settle). The second is a path-traversal fix: reject names with `/`, `\`, `..` or leading dots at `upsertDraft`, with a named error. |
| 12 | Stock skills re-seeded as a new version every boot | Seed only when the stored code hash differs; never shadow an admitted override. Pin: two boots → no new versions, no new `skill.draft` rows. |
| 17 | Admin: double journaling, `/scenario/start` journals before its guard, uncapped `GET /journal`, no SIGINT/SIGTERM handler, `redactSecrets` masks token budgets | One commit per sub-item. A default cap for `GET /journal` is fine (document it); auth is an owner decision (§4). |
| 16 | `/villagers restart` vs memory rewrite; restart retried on timeout although not idempotent | The Java side does the retry (`VillagersCommand`) → that half is a Java commit (B2). |

### B2. Java bugs (`src/` + `docs/`)
| # | Item | Notes |
|---|---|---|
| 5 | `/godbody off` and shutdown leave the avatar invulnerable | Queue `restoreAvatar` on both paths (`ChatCommand`, `ServerEntryPoint` stop hook). |
| 9 | `/prove` can't run (`.executes` on the literal, not the argument); `/build` image discarded | Client side (`src/client/`). |
| 7 | Text-mode placement calls `setBlockState` off the main thread; sub-builds have no cap/cancel | Route through `GodActionQueue` like every other world mutation; cap concurrent sub-agents. |
| 8 | Idle watchdog killed mid-chain; MCP tools have no session gate | Reset the watchdog on every tool dispatch of the owning session. |
| 6 | `Reward`/`Punishment`/`SpawnCreature` unclamped; `Reward` item-component syntax always fails | Clamp via `BridgeConfig`-style limits; fix `getItemFromString` splitting on `:`. Extract Minecraft-free logic into a testable helper like `TradeMath`, with JUnit tests. |
| 11 | CTF: Flag in offhand/armour bypasses rules; `setGlowing(false)` clobbers other glow | Scan all inventory slots; only clear the glow the mod set. |
| 10 | Gibber: `giveItemStack` result ignored (coins lost), int overflow, negative `/gib` | Fix the lost-coins + overflow + negative-amount parts. **"Every new player receives the full historical total" may be the intended backlog design — §4, don't change it.** |
| 18 | Console NPEs (`/prompt`, `/block`, `/construction`, `ChatMessageHistory`); `/mcp reload` blocks the server thread; TEMP chat echo in `QueryTerrain`; malformed `getBlockInfo` JSON | One commit per sub-item. |
| 16 | `VillagersCommand` retries a non-idempotent `restart` on timeout | Don't retry `restart`. |

Add JUnit tests wherever the logic can be made Minecraft-free (the `TradeMath` pattern); say plainly where only an
in-game check can prove a fix.

### B3. Wire what's designed but not wired (`eden/`; VERIFICATION-NOTES §6, root CLAUDE.md §"Designed vs wired")
Each item is a `main.ts` change plus a test that reaches it through the composition root (rule 5). Do them in this
order and **stop after each with a green check**; if one needs a design choice the spec doesn't make, record a `D#`
or put it in §4.

1. **Villager events** — the live signal adapter (`eden/src/bots/signals.ts`) forwards only health/death/hurt + a
   30 s tick. Add chat, entity-spotted, night-falls, new-day and inbox, with the hysteresis the spec puts in the
   emitter. Half of `roles.json` is inert until this lands.
2. **Conversations** — `Conversation` + `say`/`tell`/`start_conversation`/`leave_conversation` tools, through a
   `types/` seam exactly like `TradeDesk` (see `eden/src/types/social.ts`, `eden/src/social/trade.ts` `TradeBook`,
   and how `main.ts` wires it). Build `Conversant`s from `VillagerMemory` + a bot-backed `sayInGame` /
   `playerInEarshot`. Decide (D#) whether trade offers move inside conversations or stay standalone (D-16 chose
   standalone).
3. **Tripwire** — pass `onTripwire` to `SkillEngine` so `autoQuarantineAfter` files a critic ticket.
4. **Describer** — give `GodService` a `describer` so admitted skills get an LLM description from the final code.
5. **GodBody / embodied verdicts** — keep the `GodBody` instance instead of `void new GodBody`; wire
   `Orchestrator.intervene` so "interventions teach" and the critic's divine-assist voiding are live.
6. **Anchors** — `AnchorService` + `library.verifyHashes()` at boot.
7. **Drives** — construct `DriveTracker`; read `behavior.drives`.
8. **`combineDesks`** — implement or remove the config key (parsed, never read). Removing is a config change: warn
   on the now-unknown key like `loadConfig` does for others.
9. **God state persistence** (bug #15) — ledger, dossiers, QA cache and directives are RAM-only, derived views
   aren't replayed at boot, D-09 recovery is a no-op. This is the largest item; write the plan into PROGRESS first
   and keep "SQLite is the spine" (D-03) — persist to `eden.db`, don't add a second store.

### B4. Trade follow-ups (from `413cd4a`)
- `TRADE_REACH = 8` is hard-coded in `main.ts`; the mod's `maxTradeDistance` is configurable. Make it config
  (`settlement.reach`), validated `< maxTradeDistance`, documented in `eden.example.json`.
- Pending trade offers are RAM-only. Either persist them with B3.9 or, on boot, close every `trade.proposed` that
  has no `settled`/`failed` as `trade.failed {reason: "hôte redémarré"}` so the ledger never shows ghosts.
- Write a live smoke runbook for the first real `:8767` trade (two online villagers, a `coin` line, token on and
  off) into `docs/system/eden/java-integration.md`. Run it only if a server is available; CI can't.

---

## 4. Owner decisions — flag these, don't change them

| Item | Why it's not yours |
|---|---|
| #10 new players/bots receive the whole historical salary total | That may be the intended backlog design (CLAUDE.md §Gibber). |
| #16 villagers are op'd and can run any `/` command | Op-on-join for scenario villagers is deliberate for `/spreadplayers`/`/give`; narrowing it is a design change. |
| #17 admin API has no auth | Localhost-only by design (R24); adding auth changes every caller. |
| #19 RCON password committed in `run/server.properties`; op-on-join trusts usernames in offline mode | Rotating a credential and changing `online-mode` are the owner's actions. Report, don't edit or scrub history. |
| `.github/` is gitignored, so no CI exists | Whether to commit workflows is the owner's call; until then don't claim CI in docs. |
| `minecraft-mcp-server/` is an empty gitlink with no `.gitmodules` | Fixing the submodule is a repo-structure decision. |

---

## 5. Phase C — analyse the changes and update `docs/system`

Do this **last**, after B, so one pass covers every change from `4a8081f` to your final HEAD.

1. **Inventory.** `git diff --stat 4a8081f HEAD -- . ':!docs'` and `git log --oneline 4a8081f..HEAD`. Write a short
   change analysis per subsystem (what behaviour changed, which contracts moved, what is newly wired) — this goes
   into the corpus, not a side file: the TL;DR of each affected doc, plus a dated "Changes since `4a8081f`" section
   at the top of `docs/system/VERIFICATION-NOTES.md`.
2. **Fan-out.** For each changed file, list the docs that cite it:
   `grep -rl <file> docs/system --include=*.md`. That set is your worklist.
3. **Re-verify every citation in those docs**, not just the ones that look stale. For each `` `path:line` `` or
   `` `path:a-b` ``, open the file at HEAD and confirm the line says what the sentence claims; move the number or
   rewrite the claim. `main.ts` citations past `:550` are known to have shifted. A script that prints each citation
   with the cited line's text next to the claim speeds this up; keep the reading human.
4. **Update the claims**, not only the numbers: bug-table rows you fixed become `~~struck~~ **Fixed:** <how>`, the
   "Designed vs wired" lists shrink, the overview's "what is live" paragraph grows, tool counts change
   (`villager-runtime.md` says 14 tools today), new env vars/config keys go into
   `reference/ports-files-config.md`, new commands into `reference/commands.md`.
5. **Bump `verified_at`** to your final commit **only on docs you actually re-verified**. A doc you did not
   re-read keeps `4a8081f` — `verified_at` is per-doc frontmatter, so a mixed corpus is honest.
6. **Optional, if it is cheap:** teach `build-index.mjs` a drift check, e.g. a doc may annotate a citation with the
   expected text (`` `main.ts:556` «new SettlementClient» ``) and `--check` fails when the line no longer contains
   it. Only if it stays a small, obvious change; otherwise propose it in the report.
7. `node docs/system/build-index.mjs` (regenerates `index.json`) then `--check`. Keep root `CLAUDE.md` and
   `eden/CLAUDE.md` consistent with the corpus — they point at it as the source of truth.

**Gate:** `--check` passes, every doc in the fan-out set either has the new `verified_at` or an explicit note why
not, and VERIFICATION-NOTES' bug table matches reality.

---

## 6. Definition of done and the report

- `cd eden ; npm run check` green on a clean checkout (no `providers.json`), **0 cancelled**.
- Java tests green (`gradle test` / `./gradlew test`), with new JUnit tests for each Minecraft-free fix.
- Every bug in §3 is either fixed (test + doc) or explicitly deferred with a reason in VERIFICATION-NOTES.
- `docs/system` re-verified per §5.
- `docs/PROGRESS.md` has a dated section; new `R#`/`D#` are recorded where they belong.
- Pushed to `rework`.

The final report lists: what was fixed (commit per item), what was deferred and why, the §4 owner decisions with
your recommendation for each, anything that only a live server can prove, and test counts before/after.
