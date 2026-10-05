---
id: aigod.mcp-gateway
title: AI God — MCP Gateway (Mineflayer tools for the Java God)
system: aigod
summary: How MCPGateway connects to the Node unified process over HTTP/SSE, caches and merges MCP tools into godBot's tool list, dispatches calls, reconnects, and how /mcp and mcp_config.properties work.
tags: [aigod, mcp, mcpgateway, langchain4j, sse, httpmcptransport, mineflayer, tools, mcp_config, reload]
sources:
  - src/main/java/com/paul/brawl/MCPGateway.java
  - src/main/java/com/paul/brawl/MCPConfig.java
  - src/main/java/com/paul/brawl/MCPCommand.java
  - src/main/java/com/paul/brawl/ChatBotFunctions.java
  - src/main/java/com/paul/brawl/ChatBot.java
  - src/main/java/com/paul/brawl/BridgeConfig.java
  - build.gradle
  - run/mcp_config.properties
  - MCP_TOOLS_VERIFICATION.md
  - verify-mcp-tools.mjs
  - HIGHER_LEVEL_TOOLS.md
verified_at: 4a8081f
---

# AI God — MCP Gateway

**TL;DR.** `MCPGateway` is a lazy singleton that connects, via LangChain4j's `HttpMcpTransport` (HTTP + SSE), to
`http://127.0.0.1:8765/mcp/sse` — the Node "unified" process that also serves the God-Body bridge. On first use it calls
`listTools()`, caches the `ToolSpecification`s, and `godBot` appends them (names unchanged) after its Java tools every
turn. Unknown tool names in a model reply are forwarded to MCP if they are in the cached catalogue. Failures never throw:
connect failures back off 30 s; dispatch failures return an error string and force a reconnect on the next call. Config is
`mcp_config.properties`; admin control is `/mcp` and `/mcp reload`.

> ⚠ Unverified: `minecraft-mcp-server/` is an empty submodule gitlink in this checkout (gitlink `c0e56f2`), so the Node MCP
> server, its SSE route, its tool list and its Mineflayer plugins cannot be checked. Only the Java client is verified.

## Components

| Piece | File | Role |
|---|---|---|
| `MCPGateway` | `src/main/java/com/paul/brawl/MCPGateway.java` | Connection, cache, dispatch, reload, status |
| `MCPConfig` | `src/main/java/com/paul/brawl/MCPConfig.java` | `mcp_config.properties` (enabled, URL, timeout) |
| `MCPCommand` | `src/main/java/com/paul/brawl/MCPCommand.java` | `/mcp`, `/mcp status`, `/mcp reload` |
| Tool list merge | `ChatBotFunctions.java:313-340` (`buildToolSpecs`) | Appends MCP specs for bots with `needsMcpTools` |
| Dispatch fallthrough | `ChatBotFunctions.java:443-458` (`executeFunction` default arm) | Routes MCP tool calls |
| Libraries | `build.gradle:48,56,84-89` | `dev.langchain4j:langchain4j-mcp:1.0.0-beta5` (jar-in-jar), OkHttp 4.12.0 + okhttp-sse + Okio 3.6.0 + Kotlin stdlib 1.9.10 included because `HttpMcpTransport` is OkHttp-based |

## Configuration — `mcp_config.properties`

Path `mcp_config.properties` relative to the JVM cwd (`MCPConfig.java:46`).

| Key | Field | Default | Notes |
|---|---|---|---|
| `enabled` | `enabled` | `true` | `false` → gateway stays cold, no MCP tools |
| `sse_url` | `sseUrl` | `http://127.0.0.1:8765/mcp/sse` | Full SSE endpoint; blank value ignored. The transport discovers the POST endpoint via the SSE handshake (per the class Javadoc). |
| `timeout_seconds` | `timeoutSeconds` | `60` | Passed to `HttpMcpTransport.Builder.timeout(...)`; unparseable → keep default |

Lifecycle (`MCPConfig.java:59-122`):

- Loaded once in the singleton constructor, i.e. the first time `MCPConfig` is touched (first `MCPGateway.tools()` /
  `/mcp`), **not** at server boot.
- If the file is missing it is **written with defaults** (header `MCP HTTP/SSE transport configuration`).
- One-shot migration: obsolete subprocess-era keys `node_binary`, `mcp_server_script`, `mc_host`, `mc_port`,
  `mc_username` are detected, a warning `Migrating mcp_config.properties: dropping obsolete subprocess-mode keys …` is
  logged, and the file is rewritten without them.
- There is **no in-game setter and no re-read**: `/mcp reload` reconnects with the in-memory values. Editing the file
  requires a server restart.
- `run/mcp_config.properties` is tracked in git with `enabled=true`, `sse_url=http\://127.0.0.1\:8765/mcp/sse`,
  `timeout_seconds=60`.

The default `sse_url` happens to match `BridgeConfig.bridgeUrl` (`http://127.0.0.1:8765`) + `/mcp/sse`, but the two are
**independent settings**; `/llm bridge url` does not change `sse_url`.

## Connection — `ensureStarted()` (synchronized)

`MCPGateway.java:202-256`. Called from `tools()`, `execute()` and `reload()`.

1. `connected` → return (steady state; the catalogue is **never refreshed** while connected).
2. `!MCPConfig.enabled` → return.
3. `now < nextConnectAttemptMs` → return (backoff).
4. `nextConnectAttemptMs = now + RECONNECT_BACKOFF_MS` (`30_000` ms, `MCPGateway.java:56`).
5. Log `MCP gateway: connecting — enabled=…, sseUrl=…, timeoutSeconds=…`.
6. Build:
   ```java
   new HttpMcpTransport.Builder().sseUrl(cfg.sseUrl).timeout(Duration.ofSeconds(cfg.timeoutSeconds))
       .logRequests(false).logResponses(false).build();
   new DefaultMcpClient.Builder().key("minecraft-mcp-server").transport(transport).build();
   specs = c.listTools();   // null → empty
   ```
7. Success: store `client`, unmodifiable copies of `toolSpecs` and `toolNames`, `connected = true`, log
   `MCP gateway up — N tool(s) discovered: [names]`.
8. Any exception: log `MCP gateway connect failed (<msg>); will retry in 30s. URL: <url>. Cached spec list size: N.`,
   close the client, `connected = false`, **keep** the previous cached specs/names (empty on first failure).

No subprocess is spawned (an earlier design used `StdioMcpTransport`; the obsolete-keys migration and some stale comments,
e.g. `ChatBotFunctions.java:307-311`, still refer to it).

> ⚠ Unverified: `DefaultMcpClient` defaults in `langchain4j-mcp 1.0.0-beta5` (initialization/tool-execution timeouts,
> how a server-side `isError` result is rendered) are library behaviour, not visible in this repo.

### Threads

`tools()` is invoked inside `ChatBot.doRequest`'s `supplyAsync` on an `llm-worker` virtual thread
(`ChatBot.java:400-414`) precisely so a slow/down Node process stalls only the worker, not the server tick. Exception:
`/mcp reload` calls `reload()` → `ensureStarted()` **synchronously on the server thread** (see Gotchas).

## Tool merge into the God's tool list

`ChatBotFunctions.buildToolSpecs(needsGodTools, needsBuildPlan, needsMcpTools)` (`ChatBotFunctions.java:313-340`) builds,
in order:

1. If `needsGodTools`: `Reward`, `Trade`, `Punishment`, `ChangeWeather`, `SpawnCreature`, `Appear`, `Vanish`, `Wait`,
   `QueryTerrain`.
2. If `needsBuildPlan`: `BuildPlan`.
3. If `needsMcpTools`: `MCPGateway.INSTANCE.tools()` — appended as-is.
4. If the list is non-empty: `ListTools`.

Only `godBot` has `needsMcpTools = true` (`ChatBot.java:150-151`); `buildBot` and `BuildSubAgent` never see MCP tools.

- **No filtering, renaming, prefixing or de-duplication.** The MCP server's tool names and JSON schemas (as converted to
  `ToolSpecification` by langchain4j-mcp) are sent verbatim to the LLM provider.
- The spec list is rebuilt every request but MCP entries come from the cache.
- `ListTools` re-runs `buildToolSpecs` with the calling bot's flags, so MCP tools appear in its listing (descriptions
  collapsed to one line, capped at 220 chars) — this can also trigger a connect attempt.

## Dispatch

`ChatBotFunctions.executeFunction` (`ChatBotFunctions.java:412-471`) switches on the tool name; the Java PascalCase names
match first. The `default` arm:

```java
if (MCPGateway.INSTANCE.handlesTool(name)) yield MCPGateway.INSTANCE.execute(req);
// else: "Unknown tool '<name>'. Pick from the tool specs attached to this request; do not invent names. If you are unsure what you have, call `ListTools` ..."
```

`handlesTool(name)` = `toolNames.contains(name)` against the cache (`MCPGateway.java:94-97`).

`execute(req)` (`MCPGateway.java:110-128`), never throws:

| Situation | Returned string (fed back to the model as the tool result) |
|---|---|
| Not connected after `ensureStarted()` | `MCP gateway not connected — tool '<name>' could not be dispatched. Will auto-retry; admin can force with `/mcp reload`.` |
| `req == null` | `MCP execute called with a null request.` |
| Success | `client.executeTool(req)` result, `null` → `""` |
| Exception | `MCP tool '<name>' failed: <msg> (gateway marked down; next call will retry).` + `markDisconnected()` (close client, `connected=false`, `nextConnectAttemptMs=0`) |

Execution characteristics:

- Runs on the LLM worker thread that is processing the tool batch; **not** wrapped in `GodActionQueue`/`runOnMain` (the
  work happens in the Node process). It blocks that worker until the MCP call returns or times out.
- Tool results join the other results and go back via `sendFunctionOutputs` (or a `Wait` deferral) like any Java tool.
- Gated (bug #8): `executeFunction` asks `GodToolGate.mcpRefusal(BridgeConfig.enabled, GodSessionManager.isActive(player))`
  first and returns its French refusal instead of calling the gateway (`Le corps de Dieu est désactivé…` /
  `…occupé avec un autre fidèle…`). No gestures (`fireGestures` has no MCP arms). Each dispatch resets the owner's
  idle watchdog before and after the call.
- Results count toward `ChatBot.MAX_MEMORY_TOKENS = 16_000`; large JSON results evict older memory.

## Reconnect state machine

| Event | `connected` | `nextConnectAttemptMs` | Cache |
|---|---|---|---|
| Connect success | true | now+30 s (irrelevant while connected) | replaced |
| Connect failure | false | now+30 s | kept |
| Dispatch failure (`markDisconnected`) | false | 0 → next call reconnects immediately | kept |
| `/mcp reload` (`reload()`) | false → reconnect now | 0 then now+30 s | **cleared**, then refilled on success |
| `shutdown()` | false | 0 | kept |

`shutdown()` exists but is **not called anywhere** (no `SERVER_STOPPING` hook). The Javadoc's "a successful tool dispatch
resets the backoff" is not implemented (success touches no state).

## Commands — `/mcp`

`MCPCommand.java:29-53`.

| Command | Perm | Effect |
|---|---|---|
| `/mcp` | 0 (no `requires`) | Print `MCPGateway.status()` |
| `/mcp status` | 0 | Same |
| `/mcp reload` | 2 | `MCPGateway.INSTANCE.reload()` then print status |

`status()` strings (`MCPGateway.java:157-165`):
`MCP: disabled in mcp_config.properties` · `MCP: connected to <url>, N tool(s)` ·
`MCP: disconnected from <url> (retry in Ns), N cached tool(s)`. Calling `/mcp` does not itself trigger a connect.

## Node side (claimed, unverified)

> ⚠ Unverified — all of the following is from `CLAUDE.md`, `MCP_TOOLS_VERIFICATION.md`, `verify-mcp-tools.mjs` and
> `HIGHER_LEVEL_TOOLS.md`; the source is absent.

- `npm run unified -- --host <mc-host> --port <mc-port> --username LLMBot --bridge-port 8765` runs ONE Mineflayer bot
  serving the bridge HTTP routes and MCP-over-SSE on the same port (CLAUDE.md). The Java defaults (bridge
  `http://127.0.0.1:8765`, SSE `http://127.0.0.1:8765/mcp/sse`) are consistent with that.
- Claimed surface: **25 tools** (26 if `dig-block` is restored). Names, per MCP_TOOLS_VERIFICATION.md /
  verify-mcp-tools.mjs (`CANONICAL_TOOLS`, `verify-mcp-tools.mjs:22-29`): `attack-entity`, `can-craft`,
  `collect-block`, `craft-item`, `detect-gamemode`, `equip-item`, `find-blocks`, `find-entity`, `find-item`, `fly-to`,
  `follow-entity`, `get-block-info`, `get-position`, `get-recipe`, `jump`, `list-inventory`, `list-recipes`, `look-at`,
  `move-to-position`, `place-block`, `read-chat`, `send-chat`, `smelt-item`, `stop-combat`, `stop-follow`.
  `dig-block` TEMP-disabled; `move-in-direction` permanently removed.
- Claimed plugins: `mineflayer-pathfinder`, `-pvp`, `-collectblock`, `-tool`, `-auto-eat`, `-armor-manager` (CLAUDE.md).
- `verify-mcp-tools.mjs` spawns `minecraft-mcp-server/src/main.ts` over **stdio** (`--username VerifyBot`), not the
  unified SSE endpoint the Java gateway uses, so a pass does not prove what `MCPGateway` sees. Its header says it
  "mirrors §0" while the doc's table is §"Ground truth"; it spot-checks 9 tools.
- `HIGHER_LEVEL_TOOLS.md` is a wishlist (it still says "22 MCP primitives"), not a description of existing tools.
- The Java code's comment "MCP-sourced tools use kebab-case names that can never collide with the PascalCase Java POJO
  names" (`ChatBotFunctions.java:444-446`) is a convention, not an enforced check.

## Extending

- **New Node tool**: zero Java changes; after the Node process exposes it, run `/mcp reload` (a healthy gateway never
  re-lists on its own). CLAUDE.md says a Node tool must be registered in both `main.ts` and `unified/main.ts`
  (unverified).
- **Change endpoint/timeout**: edit `mcp_config.properties` in the server cwd and restart.
- **Filter or rename MCP tools**: would go in `MCPGateway.ensureStarted()` (when building `toolSpecs`/`toolNames`) —
  keep `handlesTool` consistent with whatever names are exposed.

## Gotchas & known issues

- **`/mcp reload` can freeze the server tick**: it runs `ensureStarted()` (SSE handshake + `listTools()`, bounded by
  `timeout_seconds`, default 60 s) on the command/main thread.
- **Kill switch gap**: `/godbody off` only disables the HTTP bridge; MCP tools still drive the shared bot. To stop them
  set `enabled=false` in `mcp_config.properties` and restart.
- **No session gate**: a bodiless prayer (another player owns the avatar) can still call MCP movement/combat tools on the
  shared bot.
- **Stale catalogue**: after a disconnect the cached specs keep being advertised; calls return the "not connected" string
  until reconnect. After `/mcp reload` with the Node process down, the God has **no** MCP tools until a successful connect.
- **Name collisions** are not detected: an MCP tool named like a Java tool would be advertised twice (provider may reject
  duplicate names) and the Java implementation would always win dispatch.
- **Long MCP calls vs the idle watchdog**: they do not reset `GodSessionManager`'s timer (see
  [god-body.md](god-body.md)).
- CLAUDE.md's failure log line `MCP gateway start FAILED` does not exist; the real line is
  `MCP gateway connect failed (...); will retry in 30s.` and the gateway retries automatically every 30 s.

## Related

- [overview.md](overview.md)
- [llm-pipeline.md](llm-pipeline.md)
- [tools-catalogue.md](tools-catalogue.md)
- [god-body.md](god-body.md)
- [configuration-and-commands.md](configuration-and-commands.md)
- [../reference/ports-files-config.md](../reference/ports-files-config.md)
- [../platform/build-and-runtime.md](../platform/build-and-runtime.md)
