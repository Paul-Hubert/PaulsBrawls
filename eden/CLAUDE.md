# Eden — agent orientation

Eden is the from-scratch rewrite of this repo's AI Village: ten villager bots + one
God (LLM: critic / curriculum / orchestrator desks + an avatar) acting through ONE
shared, God-owned library of typed, composable skills, admitted only after God judges
a real run a success. One Node process (D-01). The Java mod keeps only server-authority
duties (trade settlement :8767, Gibber coins, op-on-join).

## The spec is docs/, not this file
- docs/README.md — the 13 owner decisions (never relitigate) + reading order.
- docs/01..08 — architecture, skill system, God, villager runtime, observability,
  hard-won lessons (R1–R49 = acceptance criteria), dependency law + S1–S10 recipes.
- docs/11 (class model) + docs/12 (views) — static structure + dynamic behavior.
- docs/13 — D-07…D-13 (the seven resolved hard mechanisms) + deliverable tests.
- docs/15 (M0 as-built UML) + docs/16 (M0 reference) — the spine that EXISTS today,
  accurate to the line: 15 is the diagrams, 16 is the module-by-module prose guide
  (public surface, invariants, error modes, pinning test, recipes). Start here for M0.
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
