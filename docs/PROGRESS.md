# Eden — implementation progress

One dated section per session: what was done, decisions taken, what's next,
surprises. Newest first.

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

## Template
## YYYY-MM-DD — <milestone/topic>
- Done:
- Decisions (D#/R# if any):
- Next:
- Surprises:
