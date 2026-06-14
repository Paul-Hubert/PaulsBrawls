# 09 — Implementation kickoff prompt

Copy everything below the horizontal rule as the **first message** to the agent
that will implement Eden. For follow-up sessions, reuse it with one extra line at
the top: *"Continue from milestone MX — read docs/PROGRESS.md first."*

---

You are implementing **Eden**, the from-scratch rewrite of this repo's AI Village.
The design phase is **complete** — every architectural decision is documented
(including the seven hardest mechanisms, co-designed with the owner and recorded as
D-07…D-13; see Step 2), the owner has fixed the key choices, and months of hard-won
debugging is distilled into numbered requirements. Your job is to build it exactly as
specified, milestone by milestone — not to re-design it.

## Step 1 — Read before writing any code

In this order. Do not skim 02, 03, or 07 — they are the spec.

1. `docs/README.md` — the index, and the **owner-fixed decision table (13
   decisions)**. These are owner-fixed: don't relitigate or silently
   "improve" them.
2. `docs/00-vision.md` through `docs/06-future-extensions.md` — the architecture.
   Note every decision record (**D-01…D-13**; D-07…D-13 resolve the seven hardest
   mechanisms): they document rejected alternatives so you don't re-propose them.
3. `docs/07-hard-won-lessons.md` — **R1–R49 are acceptance criteria, not
   suggestions.** Most encode a real v1 debugging session (R44–R49 came out of the
   OQ co-design); treat them as acceptance criteria. The hardening module and the
   exemplar skills will be reviewed against them line by line.
4. `docs/08-extension-recipes.md` — the dependency law and simplicity rules
   (S1–S10) every commit must satisfy, plus the recipes for common additions.
5. Project memory: the auto-loaded `MEMORY.md` index, then read in full:
   `eden-rewrite`, `mineflayer-internals-pitfalls`, `village-debugging-playbook`,
   `village-anchor-fix`, `eval-harness`, `pray-keepalive-cascade` (holds the
   `@types/node` build pitfall and the main-thread-block diagnostic pattern).
6. v1 reference code — **read-only; port knowledge, never paste blindly**:
   - `minecraft-mcp-server/src/bot-connection.ts` and
     `minecraft-mcp-server/src/village/actions.ts` — the hardening corpus to
     port into `eden/src/bots/` (R1–R10 implementations).
   - `minecraft-mcp-server/src/village/sandbox.ts` — the acorn loop-budget
     instrumentation (the ONE AST pass Eden keeps).
   - `minecraft-mcp-server/src/village/memory.ts` + `memory-index.ts` — the
     memory design Eden ports.
   - `minecraft-mcp-server/eval/` — the harness patterns to port (R42).
7. `VILLAGE_PLAN.md` — skim only, for v1 rationale; it describes the legacy
   system, not Eden.

The repo-root `CLAUDE.md` documents **v1** — respect its repo-wide facts (build
commands, port map, version pins) but Eden behavior comes from `docs/` alone.

## Step 2 — Ground rules

- Work ONLY under `eden/` and `docs/`. Never modify `minecraft-mcp-server/`,
  `src/` (the Java mod), or v1 configs. (Java touchpoints are out of scope until
  M6, and even then are read-contract only: the settlement listener on 8767.)
- Your **first M0 commit creates `eden/CLAUDE.md`** (≤40 lines: what Eden is, a
  pointer to `docs/`, build/test commands) so every future session lands
  oriented — and `docs/PROGRESS.md` (one dated section per session: what was
  done, decisions taken, what's next, surprises encountered).
- If reality contradicts a decision record or an R-rule (an API changed, a
  library is gone), **stop and surface it** in PROGRESS.md with options —
  don't silently deviate.
- **The seven once-open design questions ([docs/13-open-questions.md](13-open-questions.md),
  OQ-1…OQ-7) are now RESOLVED** — co-designed with the owner, recorded as D-07…D-13
  with R44…R49. Read docs/13 and the linked D-records: they carry the chosen approach,
  the rejected alternatives (don't re-propose them), and a **deliverable test** each.
  M3 in particular is unblocked — OQ-1 (D-10, stall pulses), OQ-2 (D-12, critic rails),
  and OQ-5 (D-11, density budget) are its three settled prerequisites. Implement them
  as recorded; do not silently re-design.
- If you hit a genuine design gap (the docs don't answer it), choose the
  simplest option consistent with principles P1–P7, record it as the next
  D-number in the relevant doc, and continue. Gaps are expected; silent
  divergence is not.
- Doc-drift law (S8): behavior and docs change in the same commit. New pitfall
  discovered → append it to `docs/07` with the next R-number AND write a memory
  entry so future sessions inherit it.
- Code standards: TypeScript strict; Node 22; named imports for the mineflayer
  plugin trio (R15); no console output outside the logger (R23); every error
  message names its subject and args (S10); modules obey the dependency law
  (08) — wire `dependency-cruiser` into CI in M0 so violations fail from day
  one.

## Step 3 — Build by milestone

Follow the build order in `docs/01-architecture.md` §Build order (M0–M7).
**Definition of done for every milestone:**

- `npm run lint && npx tsc --noEmit && npm test` green. Unit tests run with the
  fakes (`FakeBot`, `ScriptedLLM`, in-memory journal) — no Minecraft server in
  CI.
- When bots/skills are involved, smoke-test against the dev server: port
  **25599** (read `run/server.properties`, never assume — R28). Anything
  needing the settlement port: stop `./gradlew runServer` first, it steals
  8767 (R29).
- Every new behavior is visible in the journal (P4) — verify via
  `GET /journal` before calling it done.
- Docs updated; PROGRESS.md section written.

Do not start milestone N+1 with N's DoD unmet. **M3 — the refinement loop — is
the heart**: one villager must converge reliably on trivial tasks ("collect 3
oak logs", "craft 4 planks") through the full
task → draft → run → verdict → revise → admit cycle before you build anything
parallel to it. If M3 doesn't converge, nothing after it matters.

## Step 4 — When stuck

1. Re-read the relevant doc section and the matching R-rules — the answer is
   usually pre-recorded; v1 already hit your bug.
2. Diagnose from the journal and logs using the timing playbook
   (`docs/07` §Reading failures): failure-duration signatures first, then grep
   for ANY success of the failing operation before assuming "transient".
3. Check environment gotchas before suspecting code: port map
   (25599 / 8767 / 8770), `@types/node` truncation (R30), JVM cwd (R28),
   LAN-can't-op (R31).
4. An LLM retry-looping on the same tool error means the tool's contract is the
   bug (R33) — fix the tool.

## Begin

Confirm your reading by listing the 13 owner decisions, one line each, and the
three v1 failure modes you consider most dangerous for your first milestone.
Then scaffold M0.
