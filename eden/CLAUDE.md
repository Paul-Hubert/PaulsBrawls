# Eden — agent orientation

Eden is the from-scratch rewrite of this repo's AI Village: ten villager bots + one
God (LLM: critic / curriculum / orchestrator desks + an avatar) acting through ONE
shared, God-owned library of typed, composable skills, admitted only after God judges
a real run a success. One Node process (D-01). The Java mod keeps only server-authority
duties: the trade-settlement listener on :8767 (Eden does not call it yet), Gibber coins,
op-on-join (LLMBot, Dieu and active scenario villagers), and `/villagers start|stop|restart`,
which drives this process's admin API on :8770.

## The spec is docs/, not this file
- docs/system/eden/ — the code-checked, as-built reference (cited `path:line`). Read it
  before trusting a design doc on what runs today.
- docs/system/VERIFICATION-NOTES.md — where the design docs (and this file) disagree with
  the code, plus a ranked bug list. §6 is Eden.
- docs/README.md — the 13 owner decisions (never relitigate) + reading order.
- docs/01..08 — architecture, skill system, God, villager runtime, observability,
  hard-won lessons (R1–R72 = acceptance criteria), dependency law + S1–S10 recipes.
- docs/11 (class model) + docs/12 (views) — static structure + dynamic behavior.
- docs/13 — D-07…D-13 (the seven resolved hard mechanisms) + deliverable tests.
- docs/15 (M0 as-built UML) + docs/16 (M0 reference) — the spine that EXISTS today,
  accurate to the line: 15 is the diagrams, 16 is the module-by-module prose guide
  (public surface, invariants, error modes, pinning test, recipes). Start here for M0.
- docs/IMPLEMENTATION-PLAN.md — the ordered, testable build plan (this is your map).
- docs/PROGRESS.md — append one dated section per session.

## Ground rules
- Work ONLY under eden/ and docs/. Never touch minecraft-mcp-server/ or src/ (v1/Java).
- Dependency law is enforced by dependency-cruiser in `npm run check` (there is no CI
  workflow in this repo): imports go strictly downward (types → substrate → engines →
  actors → admin). No upward imports. Nothing may import cli/.
- TypeScript strict, Node 22+ (tsx). Named imports for the mineflayer plugin trio (R15).
- No console.* outside logger.ts (R23). Every error names its subject + args (S10).
- Behavior + docs change in the same commit (S8): new pitfall → next R#; new choice → next D#.

## Build / test / run
- npm run check     # lint + typecheck + dependency-cruiser + tests (fakes only, NO Minecraft)
- npm test          # node:test via tsx, on the fakes (62 files, ~530 tests)
- Both fail on a clean checkout until providers.json exists (copy providers.example.json):
  tests/live-tests-catalogue.test.ts loads it.
- npm run eval      # dry run only: builds + validates 4 scenarios, connects to nothing
- Smoke against the dev server on port 25599 (read run/server.properties — R28).
- Settlement (once wired) needs :8767 — stop ./gradlew runServer first (it steals it — R29).
- Boot: start.ps1 (= npx tsx src/main.ts eden.json). The pm2 supervision of D-08 is not
  in the repo (ecosystem.config.cjs is gitignored and absent).

## Designed ≠ wired
main.ts is the only composition root; anything not constructed there does not run in a real
boot, however well it is tested. Not wired as of 4a8081f: social/ (Conversation, TradeService,
SettlementClient — its body now matches the Java listener, but nothing calls it), GodBody / embodiedVerdicts,
Orchestrator.intervene, the skill tripwire (no onTripwire), the describer, anchors + verifyHashes,
DriveTracker, combineDesks, the villager subscription tools (stubs), and every villager event
except health/death/hurt + a 30 s tick. SQLite holds only the journal; God state is RAM-only.
Full list with citations: docs/system/VERIFICATION-NOTES.md §6. Wiring one of these is a
main.ts change. Update that list and the root CLAUDE.md §"Designed vs wired" with it (S8).

## M3 is the gate
One villager must converge on a trivial task through the full
task→draft→run→verdict→revise→admit cycle before ANYTHING parallel to it is built.
