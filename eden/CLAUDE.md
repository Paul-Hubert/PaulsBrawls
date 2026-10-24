# Eden — agent orientation

Eden is the from-scratch rewrite of this repo's AI Village: ten villager bots + one
God (LLM: critic / curriculum / orchestrator desks + an avatar) acting through ONE
shared, God-owned library of typed, composable skills, admitted only after God judges
a real run a success. One Node process (D-01). The Java mod keeps only server-authority
duties (trade settlement :8767, Gibber coins, op-on-join).

## The spec is docs/, not this file
- docs/README.md — the 13 owner decisions (never relitigate) + reading order.
- docs/01..08 — architecture, skill system, God, villager runtime, observability,
  hard-won lessons (R1–R61 = acceptance criteria), dependency law + S1–S10 recipes.
- docs/11 (class model) + docs/12 (views) — static structure + dynamic behavior.
- docs/13 — D-07…D-13 (the seven resolved hard mechanisms) + deliverable tests.
- docs/15 (M0 as-built UML) + docs/16 (M0 reference) — the spine that EXISTS today,
  accurate to the line: 15 is the diagrams, 16 is the module-by-module prose guide
  (public surface, invariants, error modes, pinning test, recipes). Start here for M0.
- docs/22 — **the god-free skill loop (D-16, design)**: the paired-test flip gate replaces
  the critic on skill admission; villagers self-debug in one STRONG deliberation. Read before
  touching skills/ admission, the critic, or the RolloutCoordinator. Adds R78–R81; not yet built.
- docs/23 + docs/24 — **split-FakeBot / real-mineflayer CI (design)**: keep a slim RecordingBot for the
  order/fault asserts a real server can't reproduce; CI auto-opens the `run/` server + spawns a real bot
  and drives every skill + its D-16 paired test **with-and-without resources**, NO villager LLM; ~46
  pure-logic tests stay. **24 is the clean final-product spec + changelist; 23 is the reviewed build
  analysis (panel + DAG + risks).** Read before touching tests/fakes/ or eden-ci.yml. Owner-decided (Q1
  split, Q2 run/-server host, Q6 no-LLM-in-CI); not yet built.
- docs/26 — **the finalized build plan for the real-mineflayer CI** (rev 2, 5-Opus-panel reviewed +
  folded; supersedes 23's DAG): ordered steps B1–B7 with per-step DoD (server lifecycle D-17,
  RecordingBot split, D-16 flip-gate + mortal paired tests, skill-tier harness with a full per-case
  bot reset, SkillCase catalogue + completeness gate D-18, re-tiering, CI jobs + FakeBot deletion).
  **D-19: CI is God-free end to end** — no avatar, no divine cases, no op'd bot (runtime in-world God
  untouched). O-2/O-4 resolved in-plan; O-1/O-3 owner-open; §9 is the panel disposition ledger. The
  build session starts here (B1 ∥ B2 ∥ B3a); kickoff prompt = docs/27.
- docs/IMPLEMENTATION-PLAN.md — the ordered, testable build plan (this is your map).
- docs/PROGRESS.md — append one dated section per session.

## Ground rules
- Work ONLY under eden/ and docs/. Never touch minecraft-mcp-server/ or src/ (v1/Java).
- Dependency law is CI-enforced (dependency-cruiser): imports go strictly downward
  (types → substrate → engines → actors → admin). No upward imports.
- TypeScript strict, Node 22+ (tsx). Named imports for the mineflayer plugin trio (R15).
- No console.* outside logger.ts (R23). Every error names its subject + args (S10).
- Behavior + docs change in the same commit (S8): new pitfall → next R#; new choice → next D#.

## Build / test / run
- npm run check     # lint + typecheck + dependency-cruiser + tests (CI — fakes only, NO Minecraft)
- npm test          # node:test via tsx, on the fakes
- Smoke against the dev server on port 25599 (read run/server.properties — R28).
- Settlement needs :8767 — stop ./gradlew runServer first (it steals it — R29).
- Host runs supervised under pm2 (crash-only respawn — D-08); ecosystem.config.cjs
  lives beside eden.json.

## M3 is the gate
One villager must converge on a trivial task through the full
task→draft→run→verdict→revise→admit cycle before ANYTHING parallel to it is built.
