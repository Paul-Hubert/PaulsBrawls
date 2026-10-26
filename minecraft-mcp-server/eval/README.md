# AI Village — automated eval harness

Scripted scenarios against a **real Minecraft server** that grade the ten
villager bots on reactions (combat reflexes, guard alerts, night shelter),
survival (staying alive, auto-eating) and trading (bartering goods for food
and `coin`s, settled atomically by the Java mod), then emit a pass/fail
report suitable for repeated unattended runs.

```powershell
npm run eval                                  # everything (S1–S14 + T1), mock LLM
npm run eval -- --suite reflex --llm mock     # S1–S4 + S8 + S9 + S11
npm run eval -- --suite trade  --llm mock     # S5–S7 + S10 + S12–S14
npm run eval -- --suite tasks  --llm mock     # T1 — higher-level tasks (eval/scenarios/tasks/)
npm run eval -- --llm real                    # occasional end-to-end quality run
npm run eval -- --keep-up                     # leave village + mock running afterwards
```

Exit code 0 = all pass. The full result (per-scenario pass/fail, elapsed time,
LLM calls consumed, last polled state on failure) is written to
`eval/report.json`; logs land in `eval/.logs/` (`eval.log` + `village.log`).

## One-time test-server setup

The orchestrator does NOT manage the Minecraft server — it must already be
running. Once:

1. **Fabric 1.21.1 dedicated server** (the version is pinned everywhere:
   mod, mineflayer, protocol). A superflat world is recommended but not
   required — the harness builds its own self-contained platforms at y=63.
2. **Install the mod**: drop `paulsbrawls-<version>.jar` (plus the matching
   Fabric API jar) into `mods/`. `./gradlew build` in the repo root auto-copies
   it if `mods_folder` in `gradle.properties` points at the server.
   The mod hosts the trade-settlement listener on `127.0.0.1:8767`
   (`/village on` in-game if it was toggled off; it is ON by default).
3. **server.properties**:
   ```properties
   online-mode=false        # mineflayer bots use offline accounts
   enable-rcon=true
   rcon.port=25575
   rcon.password=<pick one> # the harness reads it from this file
   difficulty=hard          # zombies must actually threaten the bots
   ```
   Restart the server after editing.
4. That's it. World state (gamerules, platforms, farm, chests, beds, spawn
   point, forceloaded fixture chunks) is (re)built **idempotently** by RCON at
   the start of every run — no world zips, safe to re-run.

> The fixture force-loads two chunk regions and sets the world spawn — use a
> throwaway world, not one you care about.

Point the harness at the server with `--server-dir` (default:
`C:/Users/Paul/Desktop/PaulsBrawlsVanilla`); host/port via `--mc-host`/`--mc-port`.

## The two LLM modes

**`--llm mock` (default).** The orchestrator runs a tiny local HTTP server
(`mock-llm.ts`, port 8799) speaking `/v1/chat/completions` with **scripted,
deterministic responses** per scenario — this tests the plumbing (scheduler,
reflexes, conversations, settlement) repeatably and free. S8 flips it to
return HTTP 500 for everything and re-runs S1's trigger: the reflex outcome
must still hold — the degradation guarantee.

**`--llm real`.** Uses the LLM settings from your own
`minecraft-mcp-server/village.json` (provider/model/key), merged into the eval
roster. Assertions are outcome-based and tolerant (did *a* trade happen?),
never word-based. S8 is skipped (it needs the mock's failure mode).

## How a run works

1. Pre-flight: parse `server.properties`, connect RCON, probe the mod's
   settlement listener (trade suite only).
2. `world-setup.ts` rebuilds the fixture (village platform around 0,64,0 with
   farm/chests/beds, isolation arena at 160,64,160, walls, gamerules:
   mob spawning OFF, daylight cycle OFF, keepInventory ON, difficulty hard).
3. Fresh `eval/.village-data-eval/` (per-bot state, ledger), then scenario
   `preBoot` hooks run (S7 seeds a deliberately-broken reflex into the
   fisher's state file).
4. The village process boots as a child process from `eval/village.test.json`
   (ten `Eval*` bots, heartbeats effectively disabled, `--test-hooks` so
   `POST /village/test/think` can trigger deliberations deterministically —
   a flag a normal `npm run village` never enables).
5. Scenarios run sequentially: `setup → trigger → assert → teardown`, one
   retry each. Asserts **poll** the admin API + RCON (1–2 s interval,
   20–120 s budgets) — pathfinding is slow and ticks are 50 ms. Uninvolved
   bots are teleported to a parking row outside entity-tracking range, and
   every summoned mob carries the `eval` tag so teardown can sweep it —
   the suite is order-independent.
6. Report + console table + exit code; village process killed, mock stopped,
   tagged mobs swept (unless `--keep-up`).

## Scenario suite

| id | name | what it proves | pass criteria (polled) |
|---|---|---|---|
| S1 | reflex-survive | stock `self-defense` reflex, no brain | ≤30 s: farmer alive AND (moved ≥8 blocks OR zombie dead); ≤1 LLM call |
| S2 | guard-alert-chain | tell→respond chain across bots, zero LLM | ≤90 s: both zombies dead, farmer alive, guard came within 6 blocks |
| S3 | night-shelter | `night-falls` scan + reflex | ≤90 s after `time set 13000`: the 7 shelter-role civilians ≤4 blocks from home (guards + miner deliberately excluded — they have no `night-shelter` skill) |
| S4 | auto-eat | plugin-level survival, zero LLM | bread count drops (authoritative `data get`) and food back ≥15; 0 LLM calls |
| S5 | barter-goods | conversation → typed offer → atomic settlement | ledger entry AND `data get` shows 32 carrots ⇄ 8 oak_planks actually swapped |
| S6 | buy-food-with-coins | Gibber `coin` as currency + survival motive | ledger coins⇄bread; shopkeeper holds 10 `paulsbrawls:coin`; fisher food recovers ≥15 |
| S7 | skill-self-healing | 3-strikes breaker + write_skill rewrite | seeded broken reflex → disabled → mock receives fix request → active at v2 |
| S8 | llm-down-degradation | reflexes survive a dead LLM | mock returns 500 for all; S1 outcome still holds; village process stays up |
| S9 | memory-recall | M10 retrieval triple (relevance·recency·importance) | seeded high-importance "diamond find" buried under 60 noise entries → player question about diamonds → the memory appears in the prompt's RELEVANT OLDER MEMORIES, noise does not (embeddings off → deterministic) |
| S10 | day-plan | M11 schedule drives the day, zero-LLM execution | scripted `plan` deliberation stores slots via set_day_plan → work slot starts farm-loop by itself → `time set 12000` → job stops and the farmer walks home |
| S11 | needs-reflex | M11 drives + bot-authored reflex, zero LLM | pre-seeded rest=0.2 crosses the threshold on the first needs tick → 'tired' event → seeded reflex (real pipeline) writes the reaction note; 0 mock requests |
| S12 | social-gossip | M12 structured wrap-up + gossip diffusion | scripted chat ends with leave_conversation{opinion,note,headline} → relation ≥ +5, both hold the headline memory, an in-earshot third villager has the (entendu) line |
| S13 | skill-reuse | M13 relevance-gated skill prompt + reuse | seeded routine relevant to the wake-up reaches the prompt WITH code; start_job runs it (memory marker) instead of write_skill |
| S14 | goal-curriculum | M13 self-verification → curriculum loop | start_job with goal 1x diamond → OBJECTIF MANQUÉ verdict lands in the job-done wake-up AND in the next heartbeat's PROGRESSION block |
| T1 | get-crafting-table | higher-level task: full gather→craft pipeline (oak trunks planted in the arena → collect_blocks → craft planks → craft table) | ≤90 s: authoritative `data get` shows ≥1 crafting_table in the crafter's inventory; same outcome assert under `--llm real` |
| T2 | plant-together | two-villager cooperation: the two farmers share a 10-block farmland row, 5 wheat seeds EACH (so 10 crops require both halves) | ≤90 s: `execute if block` shows wheat on all 10 row positions; same outcome assert under `--llm real` |

**Higher-level tasks (`--suite tasks`, T-prefixed ids)** live in their own
subdirectory, `eval/scenarios/tasks/`. Unlike the S-scenarios (each pins one
mechanism), a task scenario grades an end-to-end goal — "get a crafting
table" — on outcome only, with the mock scripting the canonical tool chain
and `--llm real` letting the provider plan the same goal. New ones follow the
same shape: plant the materials in the arena, hand the goal to one bot via
`testThink` with an `EVAL_TASK:` reason marker, poll an authoritative RCON
fact.

## Adding a scenario

1. Create `eval/scenarios/s15-my-scenario.ts` (or, for a higher-level task,
   `eval/scenarios/tasks/t2-my-task.ts` with `suite: 'tasks'`) exporting a `Scenario`
   (see `eval/types.ts`): `setup` positions/equips bots (use
   `helpers.parkAllExcept` + RCON), `trigger` fires the stimulus, `assert`
   polls with `pollUntil` (return a `detail` string — it becomes the failure
   report), `teardown` sweeps (`sweepScenario`) so order-independence holds.
2. Tag every summoned entity with `eval` + a per-scenario tag.
3. If it needs scripted LLM behavior, build a `MockHandler` from the parsed
   request view (`mock-llm.ts`) and install it in `setup` via
   `ctx.mock?.setHandler(...)`; reset in `teardown`. Real-mode-incompatible
   scenarios set `mockOnly: true`.
4. Register it in `eval/scenarios/index.ts` and, if its logic has pure parts,
   pin them in `tests/eval-*.test.ts` (`npm test` must stay green, as must
   `npx tsc --noEmit` and `npm run lint`).

## Ports

| port | owner |
|---|---|
| 25565 | Minecraft server |
| 25575 | RCON (test server) |
| 8766 | village admin API (Node, spawned by the harness) |
| 8767 | trade settlement (Java mod listener) |
| 8799 | mock LLM (harness, mock mode only) |

8765 (the God's unified bridge+MCP process) is untouched — the eval runs the
village stack only and never collides with `LLMBot`.

## Gotchas

- Summoned zombies wear an iron helmet so daytime sun doesn't burn them into
  a trivial pass; they're `PersistenceRequired` so they don't despawn mid-poll.
- `coin` is a modded item: mineflayer sees it as `unknown`, so the village's
  trade pre-check deliberately skips unresolvable names and the Java listener
  validates authoritatively (that behavior is pinned by `village-trade` tests).
- The eval roster sets `heartbeatSeconds` huge — scheduled LLM activity would
  make the "N LLM calls consumed" assertions racy. Test-hook thinks and real
  triggers are the only deliberation sources during a run.
- If the run dies with "village did not come up", read
  `eval/.logs/village.log` — usually a version-mismatch kick or a username
  already logged in (don't run `npm run village` next to the eval).
