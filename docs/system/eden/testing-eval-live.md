---
id: eden.testing-eval-live
title: Eden — tests, CI gate, eval scaffold and live-test harness
system: eden
summary: Eden's npm scripts, the node:test suite and its fakes, the npm run check gate, the dry-run eval scaffold, and the process-isolated live-test harness (RCON arenas, checks, three scenarios, evidence layout).
tags: [eden, testing, node-test, tsx, fakes, ci, check, eslint, dependency-cruiser, eval, live-test, rcon, scenarios, evidence]
sources: [eden/package.json, eden/tsconfig.json, eden/eslint.config.js, eden/.dependency-cruiser.cjs, eden/.gitignore, eden/tests/fakes/fake-bot.ts, eden/tests/fakes/fake-settlement.ts, eden/tests/fakes/memory-journal.ts, eden/tests/fakes/scripted-llm.ts, eden/tests/dependency-law.test.ts, eden/tests/parity.test.ts, eden/tests/main-full-wiring.test.ts, eden/tests/live-tests-catalogue.test.ts, eden/eval/run.ts, eden/eval/fixtures.ts, eden/eval/mock-llm.ts, eden/eval/roster.ts, eden/live-tests/README.md, eden/live-tests/catalogue.ts, eden/live-tests/config.ts, eden/live-tests/harness.ts, eden/live-tests/run.ts, eden/live-tests/run-one.ts, eden/live-tests/rcon.ts, eden/live-tests/arenas.ts, eden/live-tests/checks.ts, eden/live-tests/scenarios/farm-wheat.ts, eden/live-tests/scenarios/craft-wooden-tools.ts, eden/live-tests/scenarios/cooperative-mob-defense.ts, eden/src/main.ts, docs/19-live-test-suite.md, docs/20-live-test-process.md, docs/PROGRESS.md]
verified_at: 4a8081f
---

# Eden — tests, CI gate, eval scaffold and live-test harness

**TL;DR.** `npm run check` = ESLint + `tsc --noEmit` + dependency-cruiser + `node --test` over 62 test files
(~530 `test()` cases) that run only against fakes — no Minecraft, no paid LLM. `npm run eval` is a **dry run**:
it wipes `.eden-eval-data/`, builds and validates a 4-scenario catalogue, and logs the plan; it never connects to a
server. `npm run live-test [name]` runs real scenarios (real dev server via RCON + real LLM + real mineflayer), each
in a hard-killable child process, writing evidence to `live-tests/.runs/<scenario>-<ts>/`. No CI workflow file
exists in this checkout.

## npm scripts (`eden/package.json`)

| Script | Command | Notes |
|---|---|---|
| `typecheck` | `tsc --noEmit` | `tsconfig.json`: strict, ES2022, `moduleResolution: Bundler`, `verbatimModuleSyntax`, `isolatedModules`, includes `src`, `tests`, `eval`, `live-tests`. |
| `lint` | `eslint .` | Flat config; `no-console: error` except `src/logger.ts`, `tests/**`, `website/**`. Ignores `**/.eden-data*/**`, `live-tests/.runs/**`, `*.cjs`, `.smoke/**`, `dist/**`, `coverage/**`. |
| `depcruise` | `depcruise src --config .dependency-cruiser.cjs` | Dependency law ([overview.md](overview.md)). |
| `test` | `node --import tsx --test "tests/**/*.test.ts"` | Node's built-in runner, TS via tsx. |
| `test:coverage` | same + `--experimental-test-coverage` | Node built-in coverage. |
| `check` | `npm run lint && npm run typecheck && npm run depcruise && npm test` | The CI gate (by convention). |
| `rebuild-stats` | `tsx src/cli/rebuild-stats.ts` | [journal-and-views.md](journal-and-views.md). |
| `eval` | `tsx eval/run.ts` | Dry-run scaffold (below). |
| `live-test` | `tsx live-tests/run.ts` | Real server + LLM (below). |

Engines: `node >=22`. Dependencies (`^` ranges): `@xenova/transformers ^2.17.2`, `acorn ^8.17.0`,
`acorn-walk ^8.3.5`, `better-sqlite3 ^12.2.0`, `mineflayer ^4.37.1`, `mineflayer-armor-manager ^2.0.1`,
`mineflayer-auto-eat ^5.0.3`, `mineflayer-collectblock ^1.6.0`, `mineflayer-pathfinder ^2.4.5`,
`mineflayer-pvp ^1.3.2`, `mineflayer-tool ^1.2.0`, `strip-json-comments ^5.0.1`, `ulid ^3.0.1`, `vec3 ^0.1.10`,
`ws ^8.18.0`. Dev: `@eslint/js ^9.17.0`, `@types/better-sqlite3 ^7.6.11`, `@types/node ^22.10.2`,
`@types/ws ^8.5.13`, `dependency-cruiser ^16.8.0`, `eslint ^9.17.0`, `tsx ^4.19.2`, `typescript ^5.7.2`,
`typescript-eslint ^8.18.1`.

## CI

> ⚠ Unverified: the repo `CLAUDE.md` describes `.github/workflows/eden-ci.yml` (scoped to `eden/**`) and a mod
> `ci.yml`. No `.github/` directory exists in this checkout and none appears in git history, so the CI steps cannot
> be documented. The executable gate is `npm run check` run locally.

Note: `node_modules/` is not present in this checkout either; test counts and coverage below are from source
inspection and `docs/PROGRESS.md`, not from a run.

## The unit/integration suite (`eden/tests/`)

62 `*.test.ts` files, 532 top-level `test(` call sites (grep), `node:test` + `node:assert/strict`, no `describe`.
Rules: tests call `start()` with defaults (`spawnBots`, `installProcessGuards`, `enableGod`, `serveWeb` all false),
so no server connection or global process handler is installed; servers bind port `0`.

| Area | Files |
|---|---|
| Spine / config | `main.test.ts` (M0 spine boots, `/status`, `/journal`, `system.boot`), `main-full-wiring.test.ts` (full God wiring without Minecraft; God-off GETs empty, POST verbs 503), `config.test.ts`, `providers.test.ts`, `scenario-loader.test.ts`, `village-launch.test.ts`, `village-loop.test.ts`, `parity.test.ts` (R12 names, R24 ports), `dependency-law.test.ts` (real tree has 0 violations; a planted `types/ → journal/` import must fail `types-imports-nothing`), `types.test.ts`, `fakes.test.ts` |
| Journal / views / admin | `journal.test.ts`, `journal-coverage.test.ts`, `journal-kinds.test.ts`, `lag-monitor.test.ts`, `views.test.ts`, `rebuild-stats.test.ts` (replay == live), `admin.test.ts`, `admin-routes.test.ts`, `admin-static.test.ts`, `admin-coverage.test.ts` |
| Bots | `bots-pool*.test.ts`, `bots-hardening*.test.ts`, `bots-helpers*.test.ts`, `bots-anchors*.test.ts` |
| Skills | `skills-engine`, `skills-library`, `skills-instrument`, `skills-retrieve`, `skills-describe`, `skills-exemplars` |
| LLM | `llm-client`, `llm-scheduler`, `llm-embeddings` |
| God | `god-service`, `god-critic`, `god-curriculum`, `god-orchestrator`, `god-budget`, `god-recovery`, `god-body`, `gate.test.ts` (M3 gate: one villager converges task → draft → run → verdict → admit), `loop-integration.test.ts` (M4-3 full loop via the real assignment path) |
| Villagers / social | `villagers-brain`, `-context-pack`, `-tools`, `-memory`, `-events`, `-subscriptions`, `-routing`, `-role-defaults`, `-drives`, `-host-reactivity`; `social-conversation`, `social-trade` |
| Harness scaffolds | `eval-harness.test.ts`, `live-tests-catalogue.test.ts`, `live-tests-checks.test.ts` |

### Fakes (`eden/tests/fakes/`)

| Fake | Stands in for | Key seams |
|---|---|---|
| `fake-bot.ts` `FakeBot` | a mineflayer bot (the narrowed `Bot` seam, `src/types/bot.ts`) | position, inventory, events; timer-driven `path_update`; a `dig` that never resolves (stall tests); `currentWindow` + `clickWindow` routing and `_client` `set_slot`/`window_items` packets (R1–R3); auto-eat/armor-manager hooks; pathfinder/pvp/collectBlock objects; ordered `calls` recorder (abort order R4); `chat` recorder (R25); `loadPlugin`; vitals fields. |
| `scripted-llm.ts` `ScriptedLlm` | an OpenAI-compatible endpoint | Ephemeral-port HTTP server; `/v1/chat/completions` returns queued turns (content and/or tool calls, optional token counts); `/v1/embeddings` returns a stable hash vector; records requests. |
| `memory-journal.ts` `MemoryJournal` | `Journal` | Array-backed `IJournal` (`append`/`query`/`subscribe`), injectable clock, ids `mem-NNNNNNNN`. |
| `fake-settlement.ts` `FakeSettlement` | Java `POST /trade/execute` on :8767 | Ephemeral-port server; settable status/reply to drive `trade.settled` vs `trade.failed`; records requests. |

Coverage (from `docs/PROGRESS.md` 2026-06-14 audit, not re-run): line 93.90 %, branch 83.30 %, func 93.95 %.

## Eval scaffold (`eden/eval/`) — `npm run eval`

`eval/run.ts` `main()` (`eden/eval/run.ts:96-109`) does exactly this and nothing more:

1. `rmSync('.eden-eval-data', { recursive: true, force: true })`.
2. `buildScenarios()` → roster + `ScenarioRegistry` + 4 scenarios; throws if two scenarios claim the same bot or a
   fixture is not RCON-idempotent.
3. Logs `eval harness: 4 scenario(s), roster avatar=EvalBotGod, 4 villager(s), embeddings=off`, one line per
   scenario, and a warning that the bot run is "SMOKE-TIME" / dry-run only.

It never boots a host, connects to Minecraft, applies RCON fixtures, or starts the mock LLM.

| Scenario id | Bot | Fixture (lowered by `fixtureCommands`) | Claims to prove |
|---|---|---|---|
| `reflex-flee-on-hurt` | `EvalBot0` | `clear`, `tp 0 64 0`, `time set day`, `weather clear` | hurt fires the flee reflex (`subscription.fired`) |
| `reflex-eat-when-hungry` | `EvalBot1` | `clear`, `give minecraft:bread 3`, `tp 4 64 0` | food-low fires the eat reflex |
| `trade-basic-settle` | `EvalBot2` | `clear`, `give paulsbrawls:coin 5`, `tp 8 64 0` | an offer settles via :8767 (`trade.settled`) |
| `trade-fail-untouched` | `EvalBot3` | `clear`, `tp 12 64 0` | an under-funded offer fails (`trade.failed`) |

Pieces:

- `roster.ts`: `EVAL_USERNAME_PREFIX = 'EvalBot'`; villagers `EvalBot0..N-1`, avatar `EvalBotGod`;
  `V1_RESERVED_NAMES = ['LLMBot','GodBot','Dieu']`; a full `EdenConfig` with minecraft `127.0.0.1:25565`,
  `embodiedVerdicts:false`, `drives:false`, providers with `baseUrl ''`/model `scripted`,
  `perVillagerCooldownSeconds: 0`, `heartbeatSeconds: 3600`. `ScenarioRegistry.register` throws on an unknown bot
  or a second claim of a bot.
- `fixtures.ts`: `WorldFixture { player, clearInventory?, give?, tp?, setTime?, setWeather? }` → ordered commands
  `clear → give → tp → time set → weather`; `isIdempotentFixture` rejects `~`/`^`, `summon`, `setblock … destroy`.
- `mock-llm.ts`: `startMockLlm(turns)` — runtime twin of `ScriptedLlm` (`/v1/chat/completions`, `/v1/embeddings`
  16-dim hash vector, `usage {10,5,15}`), port 0. Currently imported by nothing but tests.

`tests/eval-harness.test.ts` checks the prefix, the collision guard, fixture idempotency and mock determinism.

## Live-test harness (`eden/live-tests/`) — `npm run live-test`

Real dev server + real LLM + real mineflayer. Not part of `npm run check`; only `live-tests-catalogue.test.ts`
(structure: unique kebab names, assignees in roster, idempotent arenas, valid config) and
`live-tests-checks.test.ts` (`chainStatus` draft-matching regression) run in the suite.

### Prerequisites (from code)

| Need | Where read |
|---|---|
| `run/server.properties` at the repo root with `enable-rcon=true` (else throws) | `live-tests/config.ts:221-242`: `server-port` (default 25599), `rcon.port` (default 25575), `rcon.password`; RCON host fixed `127.0.0.1` |
| `eden/providers.json` (not `live-tests/providers.json`) | `live-tests/config.ts:167-175` (`join(liveTestsDir, '..', 'providers.json')`) |
| API key | `eden/api-keys.env` via `loadApiKeys()` (env wins), then `setupProviderEnv` copies `<apiKeyEnv>` into `OPENAI_API_KEY` if that is unset; missing key → exit 2 |
| Provider | default `deepseek` (`DEFAULT_PROVIDER`), override `--provider <name>` / `-p` |

### CLI

```
npm run live-test                               # all, order: farm-wheat, craft-wooden-tools, cooperative-mob-defense
npm run live-test -- farm-wheat                 # one
npm run live-test -- farm-wheat --provider openai
npm run live-test -- --help                     # usage + names
node --import tsx live-tests/run-one.ts farm-wheat [--provider openai]   # one, in-process (no supervisor)
```

Parent exit code = number of failed scenarios (2 on provider/key/unknown-name errors, 1 on a fatal throw).
Child (`run-one.ts`) exit: 0 PASS, 1 FAIL, 2 harness error, 3 fatal.

### Process isolation (`live-tests/run.ts`)

For each scenario the parent creates the run dir name, then spawns `process.execPath --import tsx
live-tests/run-one.ts <name>` with env `EDEN_LIVE_RUNDIR`, `EDEN_LIVE_PROVIDER` (and the inherited key), stdout/stderr
inherited. A timer in the parent's healthy event loop hard-kills the child after `timeoutMs + 200 000 ms`
(`KILL_GRACE_MS`; `taskkill /T /F` on Windows, `SIGKILL` elsewhere). The parent reads `<runDir>/result.json`; if the
child was killed or wrote none, it synthesizes a FAIL (`hard-killed after Ns — child wedged` or `child exited N
without writing result.json`). 10 s pause between scenarios.

### `runScenario` flow (`live-tests/harness.ts:201-287`)

1. `readServerProps()`; `baseConfig(props, roster, provider)` (avatar `Dieu`, 3 concurrent, cooldown 15 s,
   `debugPrompts: true`, admin port 8770), then the scenario's `configure`; `writeConfig` → `<runDir>/eden.json`
   (drops `retentionDays`).
2. RCON connect + `sendAll(arena)` (before boot).
3. `start(configPath, { dataDir: <runDir>/.eden-data, spawnBots: true, autoSpawn: true, enableGod: true,
   installProcessGuards: true })`; throws if no `god`/`coordinator`.
4. Wait up to 120 s (2 s polls of `system.bot-connected`) for `requiredBots` (default: task assignees); missing →
   FAIL `required bot(s) never connected within 120s`.
5. `sendAll(prepare(connected))`; sleep 3 s; log a kind histogram every 20 s.
6. All tasks concurrently: `god.addTask(task)` then `coordinator.assignAndRun(task, { trigger: 'admin' })` raced
   against `timeoutMs`.
7. `assert(ctx)` → `{ pass, report }`; write evidence; always `rconClient.close()` and `host.stop()`.

`VillageLoop` is not started (autoSpawn path), so only the injected tasks run; reactivity is live.

### RCON client (`live-tests/rcon.ts`)

Source RCON over one TCP socket: packet = int32-LE length, id, type, ASCII body, two NULs; types 3 auth, 2 command,
0 response; auth id `0x5eed` (reply id `-1` = bad password). Commands are strictly sequential; a reply is complete
after 60 ms of silence (multi-packet safe); 15 s per-command timeout.

### Arenas (`live-tests/arenas.ts`)

| Builder | Commands |
|---|---|
| `PEACEFUL_RULES` | `difficulty peaceful`, `time set day`, `gamerule doDaylightCycle false`, `gamerule doWeatherCycle false`, `gamerule doMobSpawning false`, `gamerule keepInventory true`, `weather clear` |
| `litBox()` | rules + stone box x/z −6..6, y 198..202, air interior (−5..5, y199..201), glass roof at y202, glowstone at four floor corners, `setworldspawn 0 199 0` |
| `combatArena()` | `difficulty easy`, `doMobSpawning false`, `keepInventory true`, `doDaylightCycle false`, `time set day`, `weather clear`; stone box x/z −7..7, y 200..204, air interior y201..203 (stone roof), five glowstone floor lights, `setworldspawn 0 201 0` |

### Checks (`live-tests/checks.ts`)

| Helper | Mechanism |
|---|---|
| `inventoryCount(rcon, bot, item)` | `clear <bot> minecraft:<item> 0` → parse `Found N` (0 if no match; reads 0 for an offline bot) |
| `entitiesRemain(rcon, selector)` | `execute if entity <selector>` → `passed` = some remain |
| `chainStatus(host, rolloutId)` | `{ draftByVillager, runOk, ticket, verdict, verdictSuccess, admit }`; drafts are matched by the `(skill, version)` the rollout's `skill.run`s used, because `skill.draft` has no `rolloutId` |
| `successfulRuns`, `combatRunners` | `skill.run` with `outcome.ok`; combat = skill name matching `/kill|attack|combat|zombie|defen|fight|mob/i` |
| `hostErrors`, `deathsAmong`, `kindHistogram` | `system.error` messages; `world.death` for named bots; per-kind counts |

### The three scenarios (`live-tests/scenarios/`)

| Scenario | Roster | Arena + prepare | Task(s) | timeout | PASS requires |
|---|---|---|---|---|---|
| `farm-wheat` | `Firmin` (farmer) | `litBox` + farmland `1 198 1..3 198 3` with `wheat[age=7]` on top; prepare `gamemode survival`, `tp Firmin 0 199 0`, `clear` | French goal demanding a NEW skill (`write_skill`) that breaks mature wheat until ≥ 3 wheat; `check {item:'wheat', count:3}`; `maxRetries 5` | 300 s | ≥ 3 wheat held (RCON) AND an ok `skill.run` whose name matches `/harvest|mine|wheat|crop|collect|recolt|bl[eé]|moisson/i` AND 0 `system.error` AND 0 Firmin deaths. `skill.admit` is a bonus line only. |
| `craft-wooden-tools` | `Firmin` (crafter) | `litBox` + oak log block `1 199 1..3 201 3`, crafting table at `5 199 0`; prepare survival, tp, clear | Author a skill: oak → planks → sticks → `wooden_pickaxe` on the table; `check {item:'wooden_pickaxe', count:1}`; `maxRetries 8` | 360 s | ≥ 1 wooden_pickaxe AND an ok run matching `/craft|pickaxe|pioche|plank|planche|stick|b[aâ]ton|fabriqu/i` AND clean. Verdict/admit are bonus. |
| `cooperative-mob-defense` | `Firmin`, `Alban` (guards) | `combatArena`; prepare survival, tp to (−2,201,0)/(2,201,0), clear, iron sword + full iron armor each, 3 persistent zombies summoned at (0,201,4), (3,201,3), (−3,201,3) | One defense task per guard (author a skill attacking the nearest zombie, may compose `kill-mob`), run concurrently; `maxRetries 4` | 360 s | No zombie in `@e[type=minecraft:zombie,x=-7,y=200,z=-7,dx=14,dy=4,dz=14]` AND no guard deaths AND ≥ 2 distinct villagers with an ok combat-named run AND 0 `system.error`. |

### Evidence layout (`live-tests/.runs/<scenario>-<YYYY-MM-DDTHH-MM-SS>/`, gitignored)

| File | Content |
|---|---|
| `eden.json` | The exact booted config (no key). |
| `.eden-data/eden.db` | The journal (readable while live — WAL). |
| `.eden-data/llm/*.json` | Every LLM call transcript (`debugPrompts: true`). |
| `.eden-data/library/<skill>/v*.js` | The code villagers actually wrote. |
| `journal-report.txt` | Event count, kind histogram, key-event timeline (`+<s> | actor | kind | summary`) for boot/connect/error/death/task/directive/inbox/subscription/brain/skill/ticket/verdict/admit events. |
| `result.json` | `{ name, pass, durationMs, report }`. |

## Gotchas & known issues

- `npm run eval` is a dry run; the docs' "mock-LLM scenario harness vs a real server" does not exist in code.
- The live harness writes `apiKeyEnv` (and no `provider`) into `eden.json`; `parseConfig` does not accept
  `apiKeyEnv`, so every live boot journals `config: unknown key .apiKeyEnv ignored (R22)`, and the host then uses
  `OPENAI_API_KEY` (normalized by the harness) through the client's default.
- `live-tests/README.md` is stale versus code: it says providers come from `live-tests/providers.json` (code: `eden/providers.json`), that `OPENAI_API_KEY` + gpt-4o/gpt-4o-mini are used (code default provider: `deepseek`), and that the defense arena is `difficulty hard` (code: `easy`). `arenas.ts` doc comment says the lit box is y198–204 (code: 198–202).
- `tests/live-tests-catalogue.test.ts` ("each roster assembles into a valid Eden config") calls
  `baseConfig(...)`, which calls `loadProviders()` and throws `eden/providers.json not found` when the gitignored
  `eden/providers.json` is absent. On a clean checkout (as here — only `providers.example.json` exists) that test
  fails, so `npm test` / `npm run check` cannot be green without first copying the example file.
- `combatArena`/defense `prepare` use `summon`, which `eval/fixtures.ts isIdempotentFixture` would reject; the
  live catalogue test only checks arena commands for `~`/`^` (prepare is not checked).
- `waitForBots` counts any historical `system.bot-connected`, so a bot that connected and then dropped still
  counts as connected.
- `inventoryCount` reads 0 for an offline bot, which looks like a failed objective.
- `dependency-law.test.ts` temporarily writes `src/types/__planted_violation__.ts`; an interrupted run can leave it
  behind and break `npm run check`.

## Related

- [overview.md](overview.md) · [process-config-and-boot.md](process-config-and-boot.md) · [journal-and-views.md](journal-and-views.md) · [admin-api.md](admin-api.md)
- [skills-engine.md](skills-engine.md) · [stock-skills.md](stock-skills.md) · [bots-and-hardening.md](bots-and-hardening.md) · [god.md](god.md)
- [../platform/build-and-runtime.md](../platform/build-and-runtime.md)
