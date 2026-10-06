# 23 — Eden post-mortem: every lesson learned — agent kickoff prompt

> Hand this whole file to an agent. **Eden failed.** It never worked correctly against a real server, and it still
> doesn't. Your job is not to fix it, defend it, or plan its next milestone. Your job is to find out **why it
> failed** and write down every lesson, so the next attempt (or the decision to stop) is made with open eyes.
> Two themes are already known and must be examined in depth; find the rest yourself:
>
> 1. **We rewrote every agent system from scratch** instead of building on an existing open-source agent
>    (for example **pi** or **opencode**), or an existing Minecraft LLM agent.
> 2. **The fake test base was broken in too many ways.** Hundreds of green tests ran against fakes
>    that accepted things real mineflayer, real LLMs and real servers reject.
>
> This is an analysis task. **Change no code.** The only files you write are the two deliverables in §6.

---

## 1. Ground rules

- **Evidence or it didn't happen.** Every lesson cites its evidence: a commit (`git show <hash>`), a `path:line`, a
  journal/live-run artefact, or a doc passage. Mark each claim **verified** (you checked it in code, history or a
  run artefact) or **inferred** (reasoned, not checked). Never present an inference as a fact.
- **Distrust the project's own success claims.** The docs say things like "farm-wheat green end-to-end",
  "M0–M7 exist", "621/621 tests pass", "Wired (B3.x)". A claim proves nothing until you have found the run or the
  code path that backs it. A passing fake-based test is **not** evidence that a feature works. Where a success
  claim has no surviving evidence (for example `live-tests/.runs/` is gitignored), say so.
- **No sunk-cost defence and no blame.** Don't argue that the architecture was sound "in principle". Don't blame a
  person or a model. Describe mechanisms: what decision was made, what it cost, what signal was available at the
  time, and why that signal was missed or overridden.
- **Owner decisions are evidence too.** `docs/README.md` lists 13 owner decisions marked "never relitigate". For
  this post-mortem, **relitigate them**: for each one, say whether it contributed to the failure and how.
- **Be concrete about cost.** Estimate time, lines of code, documents, LLM spend and sessions spent where the record
  allows it (`git log`, `docs/PROGRESS.md`, file sizes). Label estimates as estimates.
- Write in plain, direct English. No marketing tone, no hedging filler.

---

## 2. What exists to mine

| Source | What it holds |
|---|---|
| `eden/src/` (~14.5k lines TS), `eden/tests/` (~12.6k lines, 65 files) | The from-scratch system and its fake-based test suite |
| `eden/tests/fakes/` (`fake-bot.ts`, `scripted-llm.ts`, `memory-journal.ts`, `fake-settlement.ts`, `keep-alive.ts`) | The fake test base — theme 2 |
| `eden/live-tests/`, `docs/19-live-test-suite.md`, `docs/20-live-test-process.md` | The only real-server, real-LLM evidence; findings W, C, D1, D2, E from the first live session |
| `docs/00`–`docs/22` | ~22 design, plan, kickoff and as-built documents written **before and around** the code |
| `docs/07-hard-won-lessons.md` | R1–R74: v1's and Eden's debugging scars, encoded as "acceptance criteria" |
| `docs/13-open-questions.md`, `docs/README.md` | D-07…D-19 resolved mechanisms; the 13 owner decisions |
| `docs/PROGRESS.md` | Session-by-session build log, including the 2026-10-05 session and its review round |
| `docs/system/VERIFICATION-NOTES.md` | Ranked bug list #1–#19, "designed vs wired" (§6), what changed since `4a8081f` |
| `docs/IMPLEMENTATION-PLAN.md`, `docs/17-parity-signoff.md` | What was promised, and the parity sign-off that never happened |
| `git log` (whole repo, including `rework`) | When things were built, rewritten, fixed and re-fixed |
| v1: `VILLAGE_PLAN.md`, `minecraft-mcp-server/DEPRECATED.md` | The v1 village that Eden replaced. `minecraft-mcp-server/` itself is an empty gitlink (`c0e56f2`, no `.gitmodules`), so v1's code is not in this checkout — say what that prevents you from checking. |

---

## 3. Theme 1 — rewriting every agent system instead of building on one

Eden hand-built, among other things: the agent loop and tool dispatch (`villagers/brain.ts`, `villagers/tools.ts`),
context-pack assembly and token budgeting, an LLM client and a priority scheduler (`llm/`), long-term memory with
embeddings and summarisation (`villagers/memory.ts`), a skill library with versioning and a status machine
(`skills/library.ts`), a code-execution engine with AST instrumentation, abort fences and stall detection
(`skills/engine.ts`, `skills/instrument.ts`), a critic / curriculum / orchestrator trio (`god/`), an event and
subscription system (`villagers/events.ts`, `villagers/subscriptions.ts`), conversations, an append-only SQLite
journal with derived views, and an admin API.

Answer, with evidence:

1. **Inventory.** List every agent-infrastructure subsystem Eden built itself. For each one: size (files and
   lines), how many bug fixes and re-fixes it needed (`git log -- <path>`, VERIFICATION-NOTES, the 2026-10-05
   review round in PROGRESS), and whether it was ever exercised against a real server and a real model.
2. **The build-vs-adopt comparison.** Research what existing open-source agents already provide, and map each Eden
   subsystem to the nearest existing equivalent:
   - general coding/tool agents such as **pi** and **opencode**: agent loop, tool calling, provider abstraction,
     sessions and context management, extensibility (custom tools, plugins, MCP);
   - Minecraft-specific LLM agents and references (for example Voyager, whose design Eden explicitly copies, and
     maintained mineflayer-based agent projects): skill libraries, curriculum, critic, mineflayer integration.

   Check each project's current docs and repo for licence, maintenance status and actual features; don't rely on
   memory. Say where a project would have fit and where it would not (for example: one Node process with ten
   bots, the divine/mortal tier, French in-game speech, the `:8767` Java settlement).
3. **What was actually novel.** Separate the parts of Eden that were genuinely specific to this project (the God
   judging a shared skill library, village roles, the Java settlement) from generic agent plumbing that existing
   tools already solved. Estimate what share of the code and of the bugs fell in each bucket.
4. **Why the rewrite happened.** Reconstruct the decision from the docs (`docs/00`, `01`, `09`, `10`, `14`, the owner
   decisions): was adopting an existing agent ever considered and rejected, and on what grounds? Were those grounds
   valid? What would have had to be true for "build it ourselves" to be the right call?
5. **The cost of owning everything.** Show concrete cases where Eden re-learned a lesson an existing agent had
   already solved. Candidates to check include: abort/cancellation semantics, timeouts and stall detection, tool
   output size limits, context-window budgeting, chat/command injection, provider quirks, and process supervision.
6. **Recommendation.** If the village is attempted again, what should be adopted and what should be built? Give a
   concrete architecture sketch (which open-source agent, which glue Eden-specific code, which parts of Eden — if
   any — are worth salvaging) and the evidence for each choice.

---

## 4. Theme 2 — the fake test base was broken in too many ways

The suite reached 600+ green tests while the system did not work live. Find out exactly how.

1. **Catalogue every known fake/real divergence.** Start with these (verify each one, cite the commit and the code):
   - `FakeBot.blockAt` accepts a plain `{x,y,z}`; real mineflayer calls `.floored()` and throws. The live anchor heal
     therefore failed on every spawn, and fake-based tests passed (fixed in `343b035`; same class as "Blocker Z",
     `eden/src/skills/engine.ts`, and pathfinder's `.isValid()` on goals).
   - `recipesFor(name)` vs the real numeric-id signature (live finding C).
   - A dug log is not picked up without walking onto it (live finding E).
   - `FakeBot` had no `swingArm`, and an unknown gesture reported success.
   - `bot.chat` in mineflayer splits on newlines and 256-char chunks and sends `/`-prefixed chunks as commands; the
     fake chat sink just records the string (`ac744de`).
   - An aborted skill's next awaited bot call: the fake made the race invisible (`d5c67b1`).
   - `FakeSettlement` once accepted any body, so the wrong JSON shape (bug #1) shipped green.
   - `ScriptedLLM` vs a real model: what scripted replies never exercised (malformed tool calls, refusals, slow
     answers, rate limits — the 429 that ended live run D).
   - `MemoryJournal` vs the real SQLite journal.
   - Timing: 28 tests silently cancelled on Node 22 (R73); unref'd timers; `abortSettleMs` set to 100 ms only in the
     test harness.

   Then search for more: read each fake method by method next to the real mineflayer / provider / SQLite behaviour
   (the real packages are in `eden/node_modules`) and list every place the fake is more permissive, returns a
   different shape, or skips a side effect. For each divergence, say whether a shipped bug resulted.
2. **Classify the failure modes**: wrong types accepted, missing methods, missing side effects, wrong timing, wrong
   concurrency, happy-path-only LLM, fakes written from the docs rather than from the real library, fakes
   updated to make a test pass.
3. **Why nobody caught it.** Measure how much of the suite tests Eden's own code against Eden's own fakes rather than
   behaviour against reality. How many tests touch real mineflayer? How often did live runs happen compared with
   fake-based "green" milestones? What did the project use as its progress signal (test counts, "Wired" labels,
   doc verification passes) instead of a working village?
4. **What a trustworthy test base would have looked like.** Contract tests that run the same assertions against the
   fake and the real library; recorded real-server and real-LLM traffic replayed in CI; a small always-on real
   server smoke test; and fakes generated from or checked against the real type definitions. Be specific and
   estimate the cost of each.

---

## 5. Also find the lessons nobody has named yet

Look beyond the two themes, for example:

- **Documentation over working software:** ~22 design and plan documents and a 34-document verified corpus, against a
  village that never ran. When was the first live run relative to the first design doc? How much effort went into
  docs and verification passes versus making one villager do one task for real?
- **"Designed ≠ wired":** whole features were built and unit-tested but never constructed in `main.ts`. Why did that
  pattern repeat, and why did it take a dedicated audit to see it?
- **Scope and ambition:** ten villagers plus a God plus a skill library plus society plus trade, before one
  villager worked. Did the M3 "one villager must converge first" gate actually hold?
- **Agent-driven development:** most of Eden was written by AI agents from kickoff prompts (`docs/09`, `14`, `18`,
  `21`, `22`). What went wrong in that loop: agents grading their own work, review rounds that found 20 of 43 fixes
  needed follow-ups, success criteria that were all checkable offline.
- **The v1 → Eden rewrite itself:** was rewriting v1 from scratch the right call, or was it the same mistake one
  level up?
- **Cost and throughput:** LLM spend, quota exhaustion during live runs, and the D-13 throughput ceiling.
- Anything else the evidence shows.

---

## 6. Deliverables

Write exactly two files, commit them on the current branch, and push. Change nothing else.

1. **`docs/24-eden-postmortem.md`** — the post-mortem:
   - a one-paragraph verdict: why Eden failed, in plain words;
   - a timeline (first design doc, first code, first live run, each milestone, the 2026-10-05 rework and review
     round), with dates from git;
   - one section per theme (§3, §4, §5), each lesson written as **what happened → evidence → cost → lesson**;
   - a table of all lessons ranked by impact, each tagged verified/inferred;
   - the build-vs-adopt recommendation from §3.6;
   - "what is salvageable": any Eden code, test, doc or R-lesson worth carrying into a next attempt, with reasons.
2. **`docs/25-next-attempt-rules.md`** — at most one page of hard rules for any future agent project in this repo,
   each one derived from a lesson in the post-mortem and linking to it. Example of the expected form:
   "Before writing an agent loop, show in writing why pi/opencode/an existing agent cannot be used."

Final reply to the user: the verdict paragraph, the top five lessons with their evidence, and the
build-vs-adopt recommendation.
