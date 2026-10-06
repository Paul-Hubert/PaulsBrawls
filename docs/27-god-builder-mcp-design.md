# 27 — God and Builder as MCP servers, thinking in opencode (design)

> Status: **design, written before code** (phase 1 of [docs/26](26-god-builder-mcp-prompt.md)); the "to verify" items were
> checked in phase 5 and are marked Verified below. As built: [docs/system/aigod/mcp-servers.md](system/aigod/mcp-servers.md),
> [external-agent.md](system/aigod/external-agent.md). It answers the seven
> questions of docs/26 §3. Version numbers and API shapes were checked on 2026-10-06 against npm, Maven Central,
> the opencode docs and source, and the MCP Java SDK jars. Anything still unverified is marked **to verify**,
> and is checked by a named test in the phase that depends on it.

## 0. Summary

- The mod keeps every **effect** and every **rule**. It hosts two MCP servers in the server JVM, `god` and
  `builder`, at `http://127.0.0.1:8771/mcp/god` and `/mcp/builder`. They are built on the official MCP Java SDK
  (stateless server). The transport is a small adapter onto the JDK `HttpServer` the mod already uses for `:8767`.
- The **thinking** (prompts, memory, tool loop, sub-agents, pacing) moves to **opencode** (`opencode serve`,
  `127.0.0.1:4096`). The mod drives it over opencode's HTTP API, with one opencode session per player and agent.
- Every MCP call carries a **ticket**: an unguessable id the mod mints when it hands a prayer or a build to the
  agent. The ticket names the player. The ticket, not the agent, decides which player a tool can touch, and it
  dies when the session ends.
- A switch, `godAgent = builtin | external` in `god_agent.properties`, keeps today's in-mod `ChatBot` as the
  default until the in-game checklist of docs/26 §6 passes with `external`.

## 1. Agent choice

| | **opencode** 1.18.34 (2026-09-30) | **pi** (`@earendil-works/pi-coding-agent` 1.0.4, 2026-10-05) | Mindcraft v0.1.4 |
|---|---|---|---|
| Headless, driven by another process | `opencode serve`: HTTP + OpenAPI (`GET /doc`). `POST /session/:id/message` is **synchronous** (it returns the final assistant message and its parts). Also `POST /session/:id/abort` and `GET /event` (SSE). | `--mode rpc` (JSONL over stdin/stdout, one session per process) or the Node SDK. No HTTP server. | A whole Mineflayer bot framework with no prompt API to drive. |
| MCP client | `"type":"remote"` with `url`, `headers` and `{env:VAR}` substitution. Tries Streamable HTTP, then falls back to SSE. | Built-in only since 0.99.0 (2026-09-29). stdio and Streamable HTTP, with `${ENV}` headers. The default `codemode` exposure needs `"exposure":"direct"` for normal tool calls. | none |
| One session per player, concurrent | Many sessions in one server process. Verified (phase 5): a prayer and a build in two sessions run concurrently (`AgentE2ETest`). | One process per player in RPC mode, or a custom Node SDK host (which is exactly the hand-written glue docs/26 forbids). | n/a |
| Sub-agents (builds) | Agents in config with `mode: subagent`, launched by the built-in `task` tool. `permission.task` limits which ones. | None. "skips features like sub-agents" (README); there is only an example extension. | n/a |
| Image input | `{"type":"file","mime":"image/png","url":"data:image/png;base64,…"}`. Verified (phase 5): it reaches the model as an `image_url`, provided the model is declared image-capable (`attachment: true`); otherwise opencode substitutes a "does not support image input" note. | `images:[{type,data,mimeType}]` | n/a |
| Providers | 75+ through the AI SDK: OpenAI, Anthropic, and LM Studio or Ollama via `@ai-sdk/openai-compatible`. | OpenAI and Anthropic built in; local models via `models.json`. | many |
| Restricting tools | `permission` per agent (`"*": "deny"`, then allow named tools). Verified (phase 5): it covers MCP tool names (`god_*`); the god agent is offered only `god_*`, a sub-builder only `builder_*`, and `task` lists only `sub-builder`. | `--tools` globs | n/a |
| Licence and maintenance | MIT, very active (~212k stars) | MIT, very active | MIT |

**Choice: opencode.** It is the only candidate that offers, without new glue code, a localhost HTTP API with
Basic auth, many concurrent sessions in one process, per-agent prompts and permissions, real sub-agents, remote
MCP with custom headers, and image parts. pi would need either a process per player or a Node host written by us,
and it has no sub-agents.

**What we lose.**
- *Bodiless prayers, as a feature.* With `external`, a player who prays while another player holds the body is
  told God is busy, and the prayer never reaches the agent (docs/26 §6 asks for exactly this).
- *The per-turn context preamble.* The player JSON, chat log and nearby blocks used to be prepended to every
  turn. They become a tool the agent calls (`get_player_context`).
- *`/llm` and `/prompt` in game.* Provider, model and prompt now live in the opencode config (`god-agent/`).
- *RAM-only memory.* opencode keeps sessions on disk. The mod resets a player's session on `/pray reset`.
- *The custom 16k token window.* opencode's own compaction takes over.
- *Build refinement passes as code.* The five refinement prompts move into the sub-builder agent's prompt.

opencode is a **coding** agent: it has bash, edit, write and webfetch tools. Its config denies all of them
(`"*": "deny"`), the agents run in an empty working directory, and the mod never relies on the deny list for
safety. Even with every built-in tool enabled, the agent could only reach the world through the two MCP servers,
which apply every rule below.

## 2. MCP server inside the mod

- **Library:** `io.modelcontextprotocol.sdk:mcp-core` + `mcp-json-jackson2` **2.0.1** (Maven Central, 2026-08),
  stateless server `McpServer.sync(transport)` → `McpStatelessSyncServer`. Its runtime pulls `reactor-core` 3.7,
  `reactive-streams`, `json-schema-validator` 2.0.4 (+ `itu`, `jackson-dataformat-yaml`, `snakeyaml`), and Jackson
  2.21. Jackson 2 rather than the default `mcp` artifact (Jackson 3) because LangChain4j 1.0 already ships
  Jackson 2. Every one of these is added to `include` (jar-in-jar), like the OkHttp/Kotlin pile, and the Jackson
  includes move from 2.19.1 to the resolved 2.21 line.
- **Transport:** Streamable HTTP, stateless profile. A POST carries one JSON-RPC message; a request is answered
  `200 application/json`, a notification `202`; a GET returns `405` (the spec allows a server to offer no SSE
  stream). The SDK's own stateless transport is a servlet (`HttpServletStatelessServerTransport`), and embedding a
  servlet container in a Fabric mod is heavy. So the mod adds `McpHttpTransport`, a ~150-line
  `McpStatelessServerTransport` over `com.sun.net.httpserver.HttpServer`. It has the same behaviour, and all
  protocol semantics (initialize, tools/list, tools/call, input validation) stay in the SDK.
- **Coexistence:** the existing LangChain4j MCP **client** (`dev.langchain4j.mcp`, OkHttp) and the SDK
  (`io.modelcontextprotocol`, JDK `HttpClient`) share no packages.
- **Bind and auth:** `127.0.0.1:8771` only, the same pattern as `:8767`. Every request must carry
  `Authorization: Bearer <mcpToken>`, compared in constant time. A wrong or missing token gets `401`. A request
  with an `Origin` that is not a loopback origin gets `403` (DNS-rebinding guard from the MCP spec). The token is
  `mcpToken` in `god_agent.properties`, or the env var `PAULSBRAWLS_MCP_TOKEN` if set. If both are blank, the mod
  generates a random token at first start and saves it, because unlike `:8767` these servers can strike players.
- **Port:** **8771**, next to Eden's 8770. opencode's **4096** joins the registry too (`CLAUDE.md`,
  `docs/system/reference/ports-files-config.md`). The servers only start when `godAgent = external`.

## 3. Two servers

Two endpoints, two `McpStatelessSyncServer`s, two disjoint tool sets: `/mcp/god` and `/mcp/builder`. A god
ticket is refused by the builder and the other way round, so even an agent configured with both servers cannot
place blocks on a prayer or strike a player during a build. The opencode config also gives the `god` agent only
`god_*` tools and the builder agents only `builder_*`, but that is a second line, not the first.

## 4. Tool surface

Every tool takes `ticket` (string, required). Every result is text, in French where a player could read it.
Errors are `isError: true` results that the model can read, never protocol errors.

**`god`**

| MCP tool | Replaces | Arguments | Rules (all in the mod) |
|---|---|---|---|
| `say` | the model's reply text | `message` | Sent to the praying player as `Dieu : …`, and spoken through the avatar when it is manifested. Capped at 1000 characters. |
| `get_player_context` | the per-turn context `SystemMessage`s | — | `PlayerDataCollector` JSON + `ChatMessageHistory`, read on the main thread |
| `reward` | `Reward` | `item`, `amount` | `amount ≥ 1`; `GodClamps.rewardAmount` (`rewardMax`); item parsed like `/give` (components kept) |
| `offer_trade` | `Trade` | `give_item`, `give_amount`, `take_item`, `take_amount` | `TradeOffers.checkAmounts` (1..512), both items must exist, 5-minute TTL, `/accept` re-checks |
| `punish` | `Punishment` | `strikes` | `GodClamps.punishments` (`punishmentMax`) |
| `change_weather` | `ChangeWeather` | `weather` (`clear`/`rain`/`thunder`), `duration_seconds` | enum checked; duration 0..1 000 000 |
| `spawn_creature` | `SpawnCreature` | `entity`, `count`, `dx`, `dy`, `dz` | `spawnCountMax`, `GodClamps.spawnOffset`, griefing flag |
| `appear` | `Appear` | `distance?`, `height?`, `look_at_player?` | bridge enabled; clamps from `BridgeConfig`; buffs the avatar |
| `vanish` | `Vanish` | — | restores the avatar, the session continues |
| `wait` | `Wait` | `seconds` | clamped to `waitMinSeconds..waitMaxSeconds` and slept on the request thread. The idle watchdog is reset before and after. |
| `query_terrain` | `QueryTerrain` | `center_x?`, `center_z?`, `radius?` | `QueryTerrain`'s own clamps (radius 8..64, centre within 128 blocks) |
| `body_tools` | `ListTools` + the `MCPGateway` tool list | — | Lists the Mineflayer tools (name, description, schema) |
| `body_call` | direct MCP tools in `godBot` | `tool`, `arguments` (object) | `GodToolGate.mcpRefusal` (bridge enabled + owner), then `MCPGateway.execute`. The Node server is unchanged. |
| `end_session` | the "no more tool calls" terminal | — | `ChatBot.endPrayerSession`: restore, vanish, release. The ticket dies. |

`ListTools` disappears: MCP `tools/list` does that job. The Mineflayer body is proxied, not handed to the agent,
so `GodToolGate` keeps working. The Node process stays a client of nothing new and is not changed.

**`builder`**

| MCP tool | Replaces | Arguments | Rules |
|---|---|---|---|
| `get_build_origin` | the `/construction` pivot in the prompt | — | The admin's pivot from `Raycaster`. Refused if there is none. |
| `get_block_info` | `ChatBotActions.getBlockInfo` | — | 3×3 top blocks around the pivot |
| `query_terrain` | `QueryTerrain` | as above | centred on the player who sent `/build` |
| `begin_sub_build` | `BuildPlan` / `BuildSubAgent` start | `label`, `anchor_x`, `anchor_y`, `anchor_z` | `BuildGuard.tryAcquire` (**4 server-wide**). Returns a `sub_build` id. Anchor offsets are limited to ±256 per axis. |
| `place_block` | `PlaceBlock(…)` text | `sub_build`, `x`, `y`, `z`, `block` | offsets from the sub-build anchor; block parsed like `/setblock` (unknown → refusal) |
| `place_line` | `PlaceLine(…)` | `sub_build`, `x1..z2`, `block` | `BuildGuard.lineBlocks` ≤ **128** |
| `place_blocks` | `PlaceBlocks(…)` | `sub_build`, `xs`, `ys`, `zs`, `block` | equal-length arrays, ≤ **128** |
| `end_sub_build` | the end of a sub-agent's passes | `sub_build` | `BuildGuard.release` |

Placements run as `GodActionQueue.submitBulk` tasks on the main thread (8 per tick), and the call waits for them
(bounded at 30 s). This is the same path textual placements take today. A sub-build slot that sees no call for
120 s is released by the mod, so a dead agent cannot hold the four slots forever. `/godbody off` and server stop
call `BuildGuard.cancelAll`, which kills every live sub-build id: later calls are refused.

`BuildPlan` and `BuildSubAgent` stop being Java LLM loops. The `builder` agent plans, and launches one
`sub-builder` opencode sub-agent per structure through `task`. Each sub-agent calls
`begin_sub_build` → `place_*` → `end_sub_build`. The five refinement passes move into the sub-builder prompt.

**`wait`** stays a tool, because the pacing is part of the persona ("apparais, attends, frappe"). It is bounded
server-side and is the only blocking tool.

## 5. Session and safety

- **Tickets.** `/pray` claims `GodSessionManager` exactly as today. If the claim succeeds, the mod mints a god
  ticket (128-bit random, base64url) bound to the player's UUID and the current session generation, and puts it
  in the prompt it sends to the agent. `/build` mints a builder ticket bound to the sender's UUID (whose
  `/construction` pivot it uses). Tickets live in `AgentTickets` (Minecraft-free, unit-tested).
- **Ownership.** Every `god` call resolves its ticket and is refused unless:
  - the ticket exists, is a god ticket, and has not expired;
  - `GodSessionManager.currentOwner()` equals the ticket's player and the session generation still matches (a
    ticket from an earlier session of the same player is dead);
  - the player is online (looked up by UUID on the main thread);
  - for `appear`/`vanish`/`body_*`, the bridge is enabled.

  The agent never names a player. It can only reach the one its ticket names.
- **Idle watchdog.** It runs as today (`max(idleTimeoutSeconds, waitMaxSeconds+5)`) and every `god` call resets
  it. It is **not** paused while the agent thinks, unlike the builtin path. The agent is an untrusted process, so
  the watchdog is the backstop that always ends a session that went quiet. When it fires it does what it does
  today (restore invulnerability, vanish, release), kills the ticket, and asks opencode to abort that session's
  run.
- **Agent dies mid-session.** The mod's `POST /session/:id/message` fails: the connection is refused or reset.
  The mod then ends the session (`endPrayerSession`), kills the ticket and tells the player
  `Dieu : (le lien avec l'au-delà s'est rompu — réessaie plus tard.)`. If the agent hangs instead of dying, the
  watchdog fires first and the HTTP call is then cut by `turnTimeoutSeconds`.
- **Avatar invulnerability** is unchanged: it is on from `appear` until vanish or session end, `/godbody off`
  clears it directly, and so does `SERVER_STOPPING`.
- **Clamps** (`GodClamps`, `BuildGuard`, `TradeOffers`, `QueryTerrain`, the `BridgeConfig` limits) live in
  `GodService` / `BuildService`. Phase 2 extracts these Minecraft-free services, and both the builtin `ChatBot`
  and the MCP servers call them. An MCP call is untrusted input: arguments are schema-validated by the SDK, then
  re-checked by the service.

## 6. The trigger path

```
/pray <text> ─▶ ChatCommand ─▶ GodSessionManager.claim ──busy──▶ "Dieu : (occupé avec un autre fidèle — reviens plus tard.)"
                                   │ ok
                                   ▼
                   AgentTickets.mintGod(player)  ──▶  AgentClient (virtual thread, java.net.http)
                                                        POST /session            (once per player+agent, cached)
                                                        POST /session/{id}/message
                                                          { agent: "god",
                                                            parts: [ {type:text, text: "<ticket + player + prayer>"} ] }
                   ◀── tool calls arrive on :8771/mcp/god while the POST is open ──
                   ◀── POST returns { info, parts } ──▶ if the turn never called `say`, the final text is shown as
                                                        "Dieu : …" ─▶ endPrayerSession (vanish + release + kill ticket)
```

- `/build <text>` (client) sends the screenshot through `ImagePayload` as today. With `external`, the server
  hands it to the `builder` agent with the text, a builder ticket, and a `file` part
  (`data:image/png;base64,…`). `/prove` goes to the `god` agent with the image the same way, under the same claim
  rules as `/pray`.
- Failure modes, each ending in a French message and never a hang:

  | Failure | What the player sees |
  |---|---|
  | agent down (connect refused) | `(le lien avec l'au-delà est rompu …)` |
  | HTTP 4xx/5xx, or an error in the assistant `info` | `(Dieu reste muet — erreur de l'oracle.)` |
  | slower than `turnTimeoutSeconds` (default 300) | `(Dieu s'est perdu dans ses pensées …)` + `POST /abort` |

  In every case the session ends and the ticket dies.
- Basic auth to opencode uses `agentPassword` (or `OPENCODE_SERVER_PASSWORD`) and `agentUsername` (default
  `opencode`).

## 7. What is removed at the end, and what stays

Removal happens only after the docs/26 §6 checklist passes with `external`, in a separate commit.

**Removed:**
- `ChatBot` (its loop, memory, deferrals, depth cap and `Build :` routing)
- `ChatBotFunctions` (the tool POJOs, `buildToolSpecs`, the textual `Place*` scanner)
- `BuildSubAgent`, `JsonSchemaAdapter`, `OptionalField`
- `LLMConfig`, `LLMCommand` and `llm_config.properties`
- `/prompt` and `prompt.txt` / `build_prompt.txt` (they move to `god-agent/`)
- the `godAgent` switch
- the LangChain4j OpenAI/Anthropic includes and jtokkit

**Stays:**
- `ChatBotActions` (world effects, `/block`, `/construction`), `GodService`, `BuildService`
- `GodClamps`, `BuildGuard`, `GodToolGate`, `GodSessionManager`, `GodActionQueue`, `GodScheduler`
- `GodBody`, `BotBridgeClient`, `BridgeConfig`, `TradeOffers`, `QueryTerrain`, `PlayerDataCollector`,
  `ChatMessageHistory`, `Raycaster`
- `MCPGateway` / `MCPConfig` / `/mcp`, which still feed `body_*` (so `langchain4j-mcp` + OkHttp stay)
- the new `McpHttpTransport`, `GodMcpServer`, `BuilderMcpServer`, `AgentTickets`, `AgentClient`, `GodAgentConfig`

## 8. Test plan

- **Contract tests:** a test JVM starts the real `GodMcpServer` / `BuilderMcpServer` on an ephemeral port, with
  a recording world port in place of Minecraft. The SDK's real `McpSyncClient`
  (`HttpClientStreamableHttpTransport`) connects to it. The tests assert:
  - the `tools/list` names and schemas;
  - bad token → 401, and a foreign `Origin` → 403;
  - every refusal path: unknown or expired ticket, not the owner, stale session, wrong server kind, bridge
    disabled, amounts over the clamp, offline player, no origin, unknown block, over 128 blocks, a fifth
    sub-build, a cancelled sub-build.
- **Agent e2e:** a test runs the real `opencode serve` with the repo's `god-agent/` config against the real MCP
  servers. A scripted OpenAI-compatible stub replaces only the LLM. It checks that opencode discovers the tools,
  that the permissions hide the built-in tools, that a scripted turn's tool calls reach the mod with the ticket,
  and that a data-URL image reaches the model. This test is skipped unless `OPENCODE_BIN` is set (it needs
  Node), and it is run and recorded in PROGRESS.
- **In game:** the docs/26 §6 checklist, recorded in `docs/PROGRESS.md` (anything not run is marked NOT RUN).
