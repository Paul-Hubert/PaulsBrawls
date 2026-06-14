# 14 — Co-design kickoff prompt (the seven open questions)

> **✅ EXECUTED (owner co-design session, June 2026).** All seven OQs are resolved —
> D-07…D-13 in their home docs, R44…R49 for the new landmines; see
> [13-open-questions.md](13-open-questions.md). This prompt is retained as the
> historical driver of that session and as a template if a future review surfaces a
> fresh batch of open questions.

Copy everything below the horizontal rule into a fresh session with the owner
present. It drives a **collaborative design session** for the seven mechanisms in
[13-open-questions.md](13-open-questions.md) that the specs named but did not solve.
This is design work, not implementation — the output is decision records, not code.

---

You are co-designing **Eden** with its owner. The architecture docs (`docs/00`–`10`)
are mostly complete, but a hostile review found **seven mechanisms narrated as if
solved that were never actually designed**. They are listed in
`docs/13-open-questions.md` as OQ-1…OQ-7 and flagged inline in their home specs with
`⚠ OPEN DESIGN QUESTION`. Your job is to resolve them **with the owner**, one at a
time, and turn each decision into a permanent record.

This is the part of Eden where the real engineering lives. Do not rush it, do not
paper over it, and **do not decide for the owner** — surface the trade-offs, give a
recommendation, and let them choose.

## Ground rules

1. **One question at a time.** Work in this order — cheap-and-foundational first, then
   the M3 blockers, then the budget that depends on everything else:
   **OQ-6 → OQ-3 → OQ-4 → OQ-1 → OQ-5 → OQ-2 → OQ-7.**
   Do not open the next OQ until the current one has a recorded decision.
2. **For each OQ, run this loop:**
   a. **Restate** the gap and the hard constraints in your own words (read the OQ
      entry in `docs/13-open-questions.md` and its home-doc section first).
   b. **Verify the constraints are still true.** Check claims against the v1 source in
      `minecraft-mcp-server/` and the R-rules in `docs/07`. If a constraint named in
      the OQ is wrong, say so before designing around it.
   c. **Present 2–4 concrete options** with honest trade-offs — including the one the
      OQ recommends and at least one the owner might prefer instead. State what each
      costs (tokens, latency, complexity, which simplicity rule S1–S10 it strains).
   d. **Give one clear recommendation** and the single reason it wins.
   e. **Ask the owner to decide.** Use a real question with selectable options; let
      them pick "other." Wait for the answer. Do not assume it.
   f. **Record the decision** (see "Output" below) before moving on.
3. **No invented precision.** Every constant you propose (`stallSeconds`, probation
   window N, token budget, per-desk caps, `vitals` interval) needs a derivation, a v1
   measurement, or an explicit "owner's call, tune later — starting at X." If you
   can't justify a number, say "TBD, propose measuring against v1's <value>." The
   review that produced these OQs flagged undefended round numbers as the core
   pathology — do not reintroduce it.
4. **Honor the owner's fixed decisions.** The 13 owner decisions in
   `docs/README.md` and every prior decision record (D-01…D-06 when this ran; now
   through D-13) are constraints, not options. If an OQ's clean
   answer would contradict one (e.g. re-siloing the library to contain blast radius
   contradicts owner #2), surface the conflict explicitly and let the owner decide
   whether to bend the constraint — never silently.
5. **Each answer must be testable.** Eden's CI runs on a `FakeBot` + `ScriptedLLM` +
   in-memory journal with no Minecraft server (`docs/06`/`09`). Every resolution must
   come with at least one test the implementing agent can write to prove the mechanism
   works. The OQ entries list a starting "Deliverable" test for the M3 blockers — use
   those.
6. **Keep it simple.** These mechanisms are exactly where v1 grew its thicket. Prefer
   deterministic engine rails + a single LLM judgment over clever heuristics (S9), one
   writer per state (S2), registry rows over branches (S1). If a design needs banned
   machinery (S5), that itself is a decision to surface, not to sneak in.

## Output — for every resolved OQ

When the owner has decided, in the **same session**:

1. **Write a decision record** as the next `D-` number (continue from D-06 → D-07…) in
   the OQ's home doc, in the existing D-record format (**Chosen / Rejected / Why /
   Consequence**). The "Rejected" section lists the *other real options you presented*,
   not a strawman.
2. **Replace the inline `⚠ OPEN DESIGN QUESTION` marker** in the home doc with a one-
   line resolved note pointing at the new D-record (e.g. "Resolved: see D-08.").
3. **Update `docs/13-open-questions.md`:** mark the OQ row RESOLVED in the table and
   replace its section body with the chosen approach + a link to the D-record.
4. **Update any constant** the decision fixes in the `eden.json` config sketch
   (`docs/01`) and the summary (`docs/10`), so the config sketch stays the single
   source of truth (S7/R22) — the review found keys referenced in prose but missing
   from the sketch; don't recreate that.
5. **If the decision uncovers a new pitfall,** append it to `docs/07` as the next
   R-number (doc-drift law, S8).

## Dependencies to keep in mind

- **OQ-3** (neuter `process.exit`? workers?) shapes **OQ-6** (if the journal writer is
  isolated, backpressure changes) and **OQ-4** (what survives a crash). Settle OQ-3's
  posture first.
- **OQ-1** (pulse semantics) and **OQ-5** (density vs budget) and **OQ-2** (wrong-
  critic) together *are* the M3 refinement loop. None of M3 can be built until all
  three are decided — flag that to the owner up front.
- **OQ-7** (cost/latency) depends on the iteration count and call shape that OQ-1/2/5
  fix, so it comes last; its arithmetic should use the *decided* mechanisms, not the
  current guesses.

## Begin

Start by reading `docs/13-open-questions.md` in full and confirming the dependency
order above still makes sense. Then say which three OQs block M3 and why, and open
**OQ-6** with the owner — restate, verify, present options, recommend, ask.
