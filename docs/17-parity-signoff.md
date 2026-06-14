# 17 — Parity sign-off & v1 decommission checklist (M7)

This is the M7 close-out doc: what "Eden reaches parity with v1" means, the
coexistence law that lets v1 and Eden run side-by-side while you measure parity,
and the cut-over steps to retire v1. It is the prose half of the executable
parity assertions in [`eden/tests/parity.test.ts`](../eden/tests/parity.test.ts).

The owner rule it serves (README §Status): *v1 stays runnable
(`npm run village`) until Eden reaches parity; the two must never share bot
usernames.* Eden honors that by construction — see §Identity and §Ports below.

---

## 1. Parity criteria — "Eden is at least as capable as v1"

Eden is considered at parity when all of the following hold. Each maps to a
milestone that already landed (M0–M6) or to the M7 convergence (admin/eval),
and to the journal/test that evidences it.

| # | Capability (v1 had it; Eden must match) | Where it lives in Eden | Evidence |
|---|---|---|---|
| P-1 | Ten villager bots + one avatar spawn, stagger, self-heal anchors, survive (no disconnect storm) | `bots/pool.ts`, `bots/anchors.ts` (M1) | `bots-pool*.test.ts`, smoke 25599 (R13/R18) |
| P-2 | Bot-authored, sandboxed, composable skills run with watchdogs; God admits on a judged success | `skills/*` (M2), `god/critic.ts` (M3) | the M3 GATE convergence test + D-08/D-10/D-12 |
| P-3 | One villager converges on a trivial task through the full loop | `RolloutCoordinator` (M3-GATE/M4-3) | `tests/gate.test.ts`, `tests/loop-integration.test.ts` |
| P-4 | Curriculum proposes tasks; orchestrator dispatches with anti-thrash; budget degrades gracefully | `god/curriculum.ts`, `god/orchestrator.ts` (M4) | `god-curriculum/orchestrator/budget.test.ts` (D-13) |
| P-5 | "When X (filtered), do Y" reflexes as DATA; one incident → one wake-up | `villagers/events.ts`, `villagers/subscriptions.ts` (M5) | `villagers-events/subscriptions/routing.test.ts` (R36) |
| P-6 | Memory window→archive+rolling summary, ranked retrieval, world-stamp belief quarantine | `villagers/memory.ts` (M6) | `villagers-memory.test.ts` (R32/R37/R38) |
| P-7 | Bot↔bot conversations (mirror-gated) + typed-offer trade settled atomically via the mod | `social/conversation.ts`, `social/trade.ts` (M6) | `social-conversation/trade.test.ts` + the :8767 smoke (R29) |
| P-8 | Everything observable: a journal + a complete admin API + derived views, rebuildable by replay | `journal/*`, `admin/server.ts`, `views/*`, `cli/rebuild-stats.ts` (M0/M7) | `admin*.test.ts`, `views.test.ts`, `rebuild-stats.test.ts` |
| P-9 | An eval harness can drive scenarios deterministically against a real server | `eval/*` (M7) | `eval-harness.test.ts` + the eval smoke (below) |

**Sign-off condition.** P-1…P-9 each green in CI on the fakes, PLUS the three
smoke gates in §4 pass once against `PaulsBrawlsVanilla`. CI green is necessary;
the smoke gates are the parity sign-off.

---

## 2. Identity coexistence (R12) — the usernames can never collide

Minecraft kicks the second login of a name, so every login across BOTH systems
must be pairwise distinct while they coexist. Eden enforces this three ways, each
asserted in `tests/parity.test.ts`:

- **Eden's production avatar is `Dieu`** (`config.ts` `DEFAULT_CONFIG.god.name`),
  never v1's `LLMBot`/`GodBot`. A config that sets `god.name` to `LLMBot` WARNS
  loudly at parse (coexistence hazard), and one that collides `god.name` with a
  villager name THROWS.
- **Eden villagers** use the roster names in `eden.json` (French given names like
  Firmin/Alban). The boot validator rejects a duplicate villager name and a
  villager == avatar collision (R12, `config.ts`).
- **The eval harness is namespaced away from production entirely.** Every eval
  username carries the reserved prefix `EvalBot` (`eval/roster.ts`
  `EVAL_USERNAME_PREFIX`) — villagers `EvalBot0…N`, the eval avatar `EvalBotGod`.
  No production name starts with `EvalBot`, and the prefix is asserted against the
  reserved set `{LLMBot, GodBot, Dieu}`. An eval run therefore can never kick a v1
  or Eden-production login by name.

The reserved-name set Eden checks against:

| Name | Owner | Note |
|---|---|---|
| `LLMBot` | v1 unified entrypoint avatar | Eden's `god.name` must differ (warn if equal) |
| `GodBot` | v1 legacy dual-bot avatar | reserved |
| `Dieu` | **Eden** production avatar | the eval roster must not equal it |
| `EvalBot*` | **Eden** eval harness | never a production username |

---

## 3. Port map (R24) — a registry, never folklore

| Port | Owner | Notes |
|---|---|---|
| **8770** | **Eden admin** HTTP + WS (`admin.port`) | Eden's only held port; documented in `eden.example.json` |
| 8765 | v1 unified (bridge + MCP SSE) | RESERVED by v1 — Eden never reuses while v1 runs |
| 8766 | v1 village admin API | RESERVED by v1 |
| 8767 | Java trade settlement (the mod) | SHARED + stateless per request — Eden POSTs to it (`settlement.url`); `./gradlew runServer` steals it (R29) |
| 25565 | `PaulsBrawlsVanilla` dedicated server | eval/production target (RCON 25575) — read `run/server.properties`, never assume (R28) |
| 25599 | dev server (`./gradlew runServer`, cwd `run/`) | M1–M6 smoke target |

Eden's `admin.port` defaults to **8770** and the parity test asserts it never
equals 8765/8766. The settlement URL targets the shared `:8767` listener
(per-request, not a held port), which is the one resource the two systems
legitimately share.

---

## 4. The smoke gates (run once for sign-off — NOT in CI)

CI proves the harness logic on the fakes (no Minecraft, the DoD). These three
smoke runs are the parity sign-off; run them against `PaulsBrawlsVanilla`.

1. **Loop convergence (M3 GATE) with a real provider.** Point `eden.json` at a
   real strong/fast provider, boot Eden (`spawnBots:true`), inject a trivial task
   ("collect 3 oak logs"), watch `GET /journal?ref=<rolloutId>` show
   task→draft→run→verdict→admit. Read the dev port from `run/server.properties`
   (R28).
2. **Trade settlement (:8767).** Stop `./gradlew runServer` first — it steals
   8767 (R29). Run a trade scenario; assert a `trade.settled` (not `trade.failed`)
   and that the mod swapped inventories.
3. **Eval scenarios vs `PaulsBrawlsVanilla`.** `npm run eval` — it wipes
   `.eden-eval-data/`, applies each scenario's idempotent RCON fixture, points the
   brain/desks at the scripted mock LLM (own port), runs the reflex + trade suites,
   and asserts the expected journal events. The eval roster uses the `EvalBot`
   prefix, so it cannot collide with a running v1 (R12).

**Side-by-side coexistence check (R12/R24).** With v1 running
(`npm run village`) AND Eden running (`npm run … eden`) against the same server:
no login is kicked (distinct usernames), no port bind fails (Eden 8770; v1
8765/8766; shared 8767). This is the proof that v1 can stay up while Eden is
measured.

---

## 5. v1 decommission checklist

Once the three smoke gates pass and parity (P-1…P-9) is signed off, retire v1 in
this order. **Nothing here is destructive until the last step.**

- [ ] **Parity signed off** — P-1…P-9 green in CI; the three §4 smoke gates pass.
- [ ] **Run side-by-side for a soak period** — v1 (`npm run village`) and Eden
      coexisting, no username/port collision, Eden carrying the village unattended.
- [ ] **Cut new traffic to Eden** — stop starting `npm run village` /
      `npm run unified`; boot only Eden. The Java mod stays (it owns op-on-join,
      Gibber coins, and the :8767 settlement endpoint Eden depends on — these are
      server-authority duties, NOT v1 brain code).
- [ ] **Confirm the mod's settlement endpoint still serves Eden** — a live trade
      settles via :8767 with Eden as the only brain process.
- [ ] **Archive v1 brain state** — keep `minecraft-mcp-server/src/village/` +
      `.village*-data/` for reference; do NOT delete (history product).
- [ ] **Stop opping v1's avatar** — only Eden's `Dieu` should receive op-on-join
      now (the Java mod keys op on a single configured username — point it at
      `Dieu`).
- [ ] **Remove v1 from the run scripts / process manager** — pm2 / launch docs
      reference only the Eden entrypoint.
- [ ] **(Optional, much later) Remove the v1 brain code** — only after a long
      Eden-only soak. The vendored `minecraft-mcp-server/` Node brain becomes dead
      weight; the Java mod's server-authority code is permanent.

**What Eden does NOT replace.** The Java mod (`src/`) stays: trade settlement
(:8767), Gibber coins, Flag/CTF, the AI-God prayer features if still wanted,
op-on-join. Eden is the *village brain* rewrite (D-01: one Node process for the
ten villagers + God's desks), not a mod rewrite.

---

## 6. World-stamp (R32) — carried into the decommission

A world regeneration poisons persisted state twice: coordinates go stale
(self-healing anchors fix that, R18) and *beliefs* survive ("no seeds exist in
this world"). Eden stamps every data dir with a world id (`${host}:${port}`) at
first boot; on mismatch it QUARANTINES memories behind an admin decision
(`wipe | migrate`) instead of reasoning from a dead world
([villagers/memory.ts](../eden/src/villagers/memory.ts), M6). This matters at
decommission: if the cut-over coincides with a world regen, Eden will quarantine
the carried-over memories and surface the decision on the admin API rather than
silently steering by dead beliefs. Wipe the eval data dir every run (R42, the
eval harness does this), and decide wipe-vs-migrate for production memories
explicitly at any world change.
