# 26 — Make the God ChatBot and the Builder separate MCP servers — agent kickoff prompt

> Hand this whole file to an agent. Today the Java mod contains a **hand-rolled LLM agent**: `ChatBot` (two
> instances, `godBot` and `buildBot`) runs its own LangChain4j loop, memory, tool dispatch, pacing and sub-agents,
> mixed into the world code. The goal is to split it:
>
> - the mod exposes what God and the Builder can **do in the world** as **MCP servers** (`god` and `builder`),
>   with every safety rule enforced server-side;
> - the **thinking** (prompts, memory, tool loop, sub-agents) moves out of the mod into an **existing open-source
>   agent** (for example pi or opencode) that connects to those MCP servers. No new hand-written agent loop.
>
> Why: the Eden post-mortem prompt (`docs/23-eden-lessons-learned-prompt.md`) names "rewriting every agent system
> instead of adopting one" as a root failure. The Java ChatBot is the same mistake on a smaller scale.
>
> **Do not touch `eden/`** — no file under it, no Eden doc under `docs/system/eden/`, no change to the `:8767`
> settlement, `/villagers` or `/village`. Do not touch `minecraft-mcp-server/` (an empty gitlink in this checkout).

---

## 1. Ground rules

- **Branch:** work on `rework`; commit and push there. Never open a PR unless asked.
- **Scope:** Java under `src/`, `build.gradle`, the prompt files (`prompt.txt`, `build_prompt.txt`, `run/*.txt`),
  root docs, `CLAUDE.md`, and the AI-God pages of `docs/system/` (`aigod/*`, `platform/*`, `reference/*`,
  `VERIFICATION-NOTES.md` §1/§4). Nothing else.
- **Gates:** `gradle build` and `gradle test` green on every commit (use `-Pmods_folder=path/to/your/mods
  -Pclient_mods_folder=path/to/your/mods` so the copy tasks are skipped). One logical change per commit; behaviour
  and docs change in the same commit.
- **No fakes standing in for the thing under test.** The Eden fake test base passed hundreds of tests while the system
  failed live. Here, the MCP surface must be tested with a **real MCP client** (the official Java or TypeScript SDK
  client, or the MCP Inspector CLI) against the **real server** running in a test JVM. Pure helpers keep plain
  JUnit tests. Anything that needs a world (placing blocks, damage, avatar) gets an explicit in-game checklist,
  not a mock that "proves" it.
- **Never trust the agent.** Every clamp, ownership check and refusal that exists today stays in the mod, in front
  of the world: `GodClamps`, `BuildGuard`, `GodToolGate`, `GodSessionManager`, `TradeOffers` limits, the main-thread
  hop through `GodActionQueue`. An MCP call is untrusted input.
- **Keep the old path until parity.** The current in-mod ChatBot stays selectable behind one config switch (for example
  `godAgent = builtin | external` in a properties file) until the in-game checklist in §6 passes with the external
  agent. Delete the builtin loop only in a final, separate commit, and only if that checklist passed.
- Player-facing strings stay French. Verify library and agent capabilities against their current docs and repos;
  do not rely on memory.

---

## 2. What exists today (verify every line before relying on it)

| Piece | Where | Role |
|---|---|---|
| `ChatBot` (~660 lines) | `src/main/java/com/paul/brawl/ChatBot.java` | Two instances: `godBot` (`prompt.txt`, God tools + MCP tools + context) and `buildBot` (`build_prompt.txt`, `BuildPlan`). Per-player `TokenWindowChatMemory`, `MAX_FUNCTION_CALL_DEPTH=100`, `Wait` deferrals, image input, `Build :` routing (`:652`) |
| `ChatBotFunctions` (~780 lines) | same dir | Tool POJOs `Reward`, `Trade`, `Punishment`, `ChangeWeather`, `SpawnCreature`, `Appear`, `Vanish`, `Wait`, `ListTools`, `BuildPlan`; dispatch; `runOnMain`; textual `PlaceBlock`/`PlaceLine`/`PlaceBlocks` scanning |
| `ChatBotActions` (~480 lines) | same dir | The world effects (give, smite, weather, spawn, place, block info, avatar buff/restore); `/block`, `/construction` |
| `BuildSubAgent`, `BuildGuard` | same dir | One LLM loop per sub-build with refinement passes; the server-wide caps |
| `QueryTerrain`, `PlayerDataCollector`, `ChatMessageHistory`, `Raycaster` | same dir | Context the model reads (terrain map, player snapshot, chat log, build pivot) |
| `GodSessionManager`, `GodBody`, `BotBridgeClient`, `BridgeConfig` | same dir | One encounter at a time, idle watchdog, the avatar via the Node bridge on `:8765` |
| `GodActionQueue`, `GodScheduler` | same dir | Main-thread hop (action lane + bulk lane); timers |
| `TradeOffers` | same dir | God's pending offers and `/accept` |
| `LLMConfig`, `LLMCommand`, `MCPGateway`, `MCPConfig`, `MCPCommand` | same dir | Provider config, `/llm`, and the MCP **client** to the Node Mineflayer tools |
| Commands | `ChatCommand`, client `Screenshotter` | `/pray`, `/pray stop`, `/prompt`, `/godbody`, `/llm`, `/mcp`, client `/prove` and `/build` (screenshot) |
| Reference docs | `docs/system/aigod/*.md`, `GOD_BOT_INTEGRATION_PLAN.md`, `VERIFICATION.md` | Code-checked description of all of the above |

---

## 3. Target architecture (decide and document before coding)

```
 player ──/pray, /build──▶ mod ──(prayer, player, screenshot?)──▶ external agent (pi / opencode / …)
                            ▲                                          │  prompts, memory, sub-agents, pacing
                            │                                          ▼
                            └──── MCP: god  ◀──── tool calls ─────────┤
                                  MCP: builder ◀───────────────────────┘
                                  (+ the existing Node Mineflayer MCP for the avatar body, unchanged)
```

Write `docs/27-god-builder-mcp-design.md` first (one commit, before code) answering:

1. **Agent choice.** Compare at least pi and opencode (and one Minecraft-specific option if relevant) on: headless
   or server mode the mod can drive programmatically, MCP client support (transport, auth headers), one session
   per player with concurrent sessions, sub-agents (for builds), image input (for `/build` screenshots), provider
   support (OpenAI, Anthropic, local), licence, maintenance. Pick one; state why; state what you would lose.
2. **MCP server inside the mod.** The tools must run in the server JVM (they touch the world through
   `GodActionQueue`). Pick the library (the official MCP Java SDK, or another maintained one) and the transport
   (Streamable HTTP on `127.0.0.1`). Check the jar-in-jar story (`include` in `build.gradle`, like the
   OkHttp/Kotlin pile) and that it coexists with the existing `langchain4j-mcp` **client** used by `MCPGateway`.
   Auth: a shared token, bound to loopback, both like the `:8767` settlement listener. Port: pick a free one and add
   it to the port registry in `CLAUDE.md` and `docs/system/reference/ports-files-config.md`.
3. **Two servers or one.** Recommended: two MCP servers (two endpoints, or one endpoint with two clearly separate
   tool groups) — `god` and `builder` — so the God agent cannot place blocks and the builder cannot punish players.
4. **Tool surface.** Map every current tool to an MCP tool with a JSON Schema, including the player it targets.
   Minimum:
   - `god`: `reward`, `offer_trade`, `punish`, `change_weather`, `spawn_creature`, `appear`, `vanish`, `say` (a
     French message to the praying player — today that is the model's reply text), `get_player_context` (today's
     `PlayerDataCollector` snapshot + chat log), `end_session`.
   - `builder`: `place_block`, `place_line`, `place_blocks`, `get_build_origin`, `get_block_info`, `query_terrain`.
     `BuildPlan` and `BuildSubAgent` stop being Java LLM loops: planning and parallel sub-builds become the agent's
     job (its own sub-agents), and the builder server only exposes primitives with `BuildGuard`'s caps.
   - Drop `ListTools` (MCP `tools/list` does that) and decide what `Wait` becomes (agent-side pacing, or a `wait`
     tool that only bounds the delay).
5. **Session and safety.** How the session lock, idle watchdog, avatar invulnerability and the "only the owner may
   act" rule (`GodToolGate`) work when calls arrive over MCP: every `god` call carries the session or player id
   and is refused unless that player owns the active session. What happens when the agent process dies mid-session
   (the watchdog must still end the session and restore the avatar).
6. **The trigger path.** How `/pray <text>` and `/build <text>` (with screenshot) reach the agent, and how the
   agent's spoken answer reaches the player. Failure modes: agent down, slow, or erroring → a French message to
   the player, never a hang or a stuck avatar.
7. **What is removed.** List the Java classes and config that disappear at the end (`ChatBot`'s loop and memory,
   `BuildSubAgent`, `LLMConfig`/`LLMCommand` if the agent owns providers, the `Build :` routing) and what stays.

---

## 4. Phases (each phase ends green and pushed)

1. **Design doc** (§3) — no code.
2. **Extract the world layer.** Move every world effect behind a plain Java service API (no LangChain4j types),
   called by both the current ChatBot and, later, the MCP servers. Behaviour unchanged; existing tests green.
   Add JUnit tests for any pure logic you extract.
3. **The `builder` MCP server.** Primitives only, `BuildGuard` caps, main-thread placement, auth, loopback.
   Contract tests: start the server in a test JVM without Minecraft where possible (inject a world port), connect
   a real MCP client, assert `tools/list` schemas and the refusals (bad token, over cap, unknown block, no origin).
4. **The `god` MCP server.** Same pattern, plus session ownership and clamps. Contract tests for every refusal
   path (not the owner, bridge disabled, amount over the clamp, offline player).
5. **Agent integration.** Configure the chosen agent (prompts moved from `prompt.txt` / `build_prompt.txt` into its
   config, MCP servers registered, one session per player). Wire `/pray` and `/build` behind `godAgent=external`.
   Document the agent's install and startup in the README and `docs/system/aigod/`.
6. **Parity and removal.** Run the in-game checklist (§6) with `godAgent=external`. Record results in
   `docs/PROGRESS.md` under a dated section. Only if everything passes: delete the builtin loop in a separate
   commit and update every doc that describes it.

---

## 5. Docs to keep true (same commit as the behaviour)

`CLAUDE.md` (AI God sections, commands, ports, build/test commands), `README.md`, `docs/system/aigod/*.md`
(update `verified_at` only for pages you actually re-verified), `docs/system/platform/*`,
`docs/system/reference/{commands,ports-files-config}.md`, `docs/system/VERIFICATION-NOTES.md`,
then `node docs/system/build-index.mjs` and `--check`.

---

## 6. In-game checklist (run on the dev server; record results in PROGRESS — mark anything not run as NOT RUN)

- `/pray` from one player: God answers in French, appears, rewards, vanishes; a second player praying meanwhile
  is told God is busy and cannot trigger `god` tools.
- Punishment, weather and spawn respect the clamps; a Reward with components (`enchanted_book[…]`) arrives intact.
- `offer_trade` then `/accept` works; an expired offer is refused.
- `/godbody off` mid-session: the avatar is vulnerable again, queued actions are dropped, running builds stop.
- Kill the agent process mid-session: the watchdog ends the session and restores the avatar; the player gets a
  French message.
- `/construction` then `/build <text>` with a screenshot: the agent plans sub-builds and places blocks only through
  `builder`; the 4-sub-build and 128-blocks-per-call caps hold; the server tick stays healthy.
- The Node Mineflayer MCP tools (avatar body) still work for God, unchanged.

---

## 7. Final report to the user

What was built per phase (commit hashes), the agent chosen and why, the tool surface, what the in-game checklist
showed (and what was not run), what was removed, open risks, and test counts before/after.
