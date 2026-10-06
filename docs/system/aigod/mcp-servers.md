---
id: aigod.mcp-servers
title: AI God — the god and builder MCP servers (external agent)
system: aigod
summary: The MCP servers the mod hosts on 127.0.0.1:8771 for an external agent (opencode) — transport, bearer auth, tickets, the god and builder tool surfaces, sub-build leases, every refusal, and how they are tested with a real MCP client.
tags: [aigod, mcp, mcp-server, external-agent, opencode, tickets, builder, god, buildguard, sub-build, godagent, 8771]
sources:
  - docs/27-god-builder-mcp-design.md
  - src/main/java/com/paul/brawl/AgentMcpServers.java
  - src/main/java/com/paul/brawl/McpHttpEndpoint.java
  - src/main/java/com/paul/brawl/McpTools.java
  - src/main/java/com/paul/brawl/BuilderMcpServer.java
  - src/main/java/com/paul/brawl/GodMcpServer.java
  - src/main/java/com/paul/brawl/BodyTools.java
  - src/main/java/com/paul/brawl/GatewayBodyTools.java
  - src/main/java/com/paul/brawl/AgentTickets.java
  - src/main/java/com/paul/brawl/SubBuilds.java
  - src/main/java/com/paul/brawl/GodAgentConfig.java
  - src/main/java/com/paul/brawl/ExternalAgent.java
  - src/main/java/com/paul/brawl/GodService.java
  - src/main/java/com/paul/brawl/BuildService.java
  - src/test/java/com/paul/brawl/BuilderMcpServerTest.java
  - src/test/java/com/paul/brawl/GodMcpServerTest.java
  - src/test/java/com/paul/brawl/AgentTicketsTest.java
  - docs/system/aigod/mcp-test-bench.md
verified_at: 718214e
---

# AI God — the god and builder MCP servers

**TL;DR.** With `godAgent = external` in `god_agent.properties`, the mod serves two MCP servers on
`http://127.0.0.1:8771`: `/mcp/god` and `/mcp/builder`. They expose what God and the Builder can do in the
world, and nothing else. The *thinking* (prompts, memory, tool loop, sub-agents) lives in an external agent
(opencode, see [external-agent.md](external-agent.md)). Every rule stays in the mod: a bearer token, a ticket
per prayer or build, the clamps of `GodService`, the caps of `BuildService` / `BuildGuard`, and the main-thread
hop. An MCP call is untrusted input. Design: [docs/27](../../27-god-builder-mcp-design.md).

## Process and transport

| Concern | Where | What |
|---|---|---|
| Start/stop | `ExternalAgent.start/stop`, called from `ServerEntryPoint` on `SERVER_STARTED` / `SERVER_STOPPING` | Nothing starts with `godAgent = builtin` (the default) |
| Host | `AgentMcpServers.start` | JDK `HttpServer` bound to the loopback address, one virtual thread per request (`mcp-http-N`) |
| Protocol | MCP Java SDK 2.0.1, `McpServer.sync(transport)` → `McpStatelessSyncServer` | initialize, tools/list, tools/call; tool inputs schema-validated by the SDK (`validateToolInputs(true)`) |
| Transport | `McpHttpEndpoint` (implements `McpStatelessServerTransport`) | Streamable HTTP, stateless profile. A POST carries one JSON-RPC message. A request gets `200 application/json`, a notification gets `202`, and GET/DELETE get `405` (there is no SSE stream). Bodies are capped at 1 MiB (`413`). Malformed JSON is `400`; `params` the SDK cannot convert get a `-32602` error in a `200`, never a `500`. |
| JSON | `JacksonMcpJsonMapper` + `DefaultJsonSchemaValidator`, passed explicitly | The SDK's ServiceLoader defaults are not relied on under Fabric's class loader |

The SDK's own stateless transport is a servlet. `McpHttpEndpoint` reproduces its behaviour on the JDK server, so
no servlet container is shipped.

## Security

Requests are checked in this order (`McpHttpEndpoint.handle`):

1. **Path:** an unknown path gets `404`.
2. **Origin:** an `Origin` header that is not loopback (`localhost`, `127.0.0.1`, `[::1]`) gets `403`. This is
   the DNS-rebinding guard the MCP spec asks for. A request with no `Origin` (any non-browser client) passes.
3. **Token:** `Authorization: Bearer <token>` is compared in constant time. A wrong or missing token gets `401`
   with `WWW-Authenticate: Bearer`, and so does every request when the configured token is blank.
4. **Method:** anything but POST gets `405`.

The token is `GodAgentConfig.effectiveToken()`. It comes from the env var `PAULSBRAWLS_MCP_TOKEN` if that is set,
or else from `mcpToken` in `god_agent.properties`. When both are blank, `ensureToken()` generates 32 random bytes
(base64url) at start and saves them, unlike the no-auth default of the `:8767` settlement listener.

**Tickets** (`AgentTickets`) are the second layer:
- A ticket is `god-…` or `bld-…` followed by 128 random bits. It is bound to **one player UUID** and **one kind**,
  and expires after `ticketTtlSeconds` (default 1800).
- Minting a new ticket revokes the player's previous ticket of the same kind (atomically: concurrent mints leave
  exactly one live).
- The agent never names a player. Every tool takes `ticket` (required) and acts on the ticket's player only.
- A god ticket is refused by the builder, and a builder ticket by god.

## The builder server (`/mcp/builder`)

All coordinates are integer block offsets. The pivot is the `/construction` point of the player whose `/build`
minted the ticket (`Raycaster.getLastPos`).

| Tool | Arguments (besides `ticket`) | Result / rules |
|---|---|---|
| `get_build_origin` | — | The pivot's absolute coordinates. Refused when there is no pivot. |
| `get_block_info` | — | `ChatBotActions.getBlockInfo`: the top blocks of the 3×3 columns around the pivot, as JSON |
| `query_terrain` | `center_x?`, `center_z?`, `radius?` | `QueryTerrain` map. Radius is 8..64 and the centre must be within 128 blocks of the player. |
| `begin_sub_build` | `label?`, `anchor_x`, `anchor_y`, `anchor_z` | Opens a **lease** (`SubBuilds.begin`) at pivot + anchor and returns `sub_build=<id>`. Each anchor offset must be within ±256. Uses one of `BuildGuard`'s **4 server-wide** slots. |
| `place_block` | `sub_build`, `x`, `y`, `z`, `block` | One block at anchor + offset |
| `place_line` | `sub_build`, `x1..z2`, `block` | `BuildGuard.lineBlocks` must be ≤ **128**, checked before any position is allocated |
| `place_blocks` | `sub_build`, `xs`, `ys`, `zs`, `block` | The arrays must have equal lengths, each ≤ **128** (checked before copying) |
| `end_sub_build` | `sub_build` | Closes the lease and releases its slot |

Placements go through `BuildService.place`:
- the block must be known (`ChatBotActions.isKnownBlock`, parsed like `/setblock`);
- each call is **one** `GodActionQueue.submitBulk` task (8 per tick, after the action lane);
- the call waits up to 30 s.

A cancelled queue (`/godbody off`, server stop) reads "Placement annulé".

**Leases** (`SubBuilds`): a lease belongs to the player of the ticket that opened it, so another build's ticket
cannot use it. It is dropped and its slot released when:
- it sees no call for `subBuildIdleSeconds` (default 120), so a dead agent cannot hold the slots. The sweep is lazy:
  it runs on the next builder call, and `AgentTurns` also closes a build's leases when its turn ends;
- `BuildGuard.cancelAll()` ran after it opened (`/godbody off`, server stop), so a cancelled build stays cancelled;
- `end_sub_build` closes it.

The builtin `BuildSubAgent` and the leases share the same 4 slots.

## The god server (`/mcp/god`)

Every tool goes through `GodMcpServer.session(...)`, which refuses the call unless all of these hold:
- the ticket resolves as a god ticket;
- its player **owns the current avatar session** (`GodSessionManager.isOwner`);
- the session generation is the one the ticket was minted under, so a ticket from an earlier session of the same
  player is dead. The generation is bumped by every new claim of a free avatar and by every session end;
- the player is online.

The owner's idle watchdog is reset before and after each call (bug #8). `appear`, `vanish`, `body_tools` and
`body_call` also need the bridge enabled (`GodToolGate.mcpRefusal`, `/godbody on|off`).

| Tool | Arguments (besides `ticket`) | Calls |
|---|---|---|
| `say` | `message` | `GodService.say`: `Dieu : …` to the player, and spoken by the avatar when it is manifested. Capped at 1000 characters. |
| `get_player_context` | — | `PlayerDataCollector` JSON + `ChatMessageHistory`, read on the main thread |
| `reward` | `item`, `amount` | `GodService.reward` (≥ 1, ≤ `rewardMax`; `/give` syntax with components) |
| `offer_trade` | `give_item`, `give_amount`, `take_item`, `take_amount` | `GodService.offerTrade` (1..512 each, items must exist; `/accept` within 5 min) |
| `punish` | `strikes` | `GodService.punish` (≤ `punishmentMax`) |
| `change_weather` | `weather` ∈ {clear, rain, thunder}, `duration_seconds` | `GodService.changeWeather` (0..1 000 000) |
| `spawn_creature` | `entity`, `count`, `dx`, `dy`, `dz` | `GodService.spawnCreature` (`spawnCountMax`, ±`spawnOffsetMax`, griefing flag) |
| `appear` | `distance?`, `height?`, `look_at_player?` | `GodService.appear` (owner gate, `BridgeConfig` clamps, invulnerable avatar) |
| `vanish` | — | `GodService.vanish` (the session continues) |
| `wait` | `seconds` | Clamped to `waitMinSeconds..waitMaxSeconds`, then the call sleeps. It is the only blocking tool. |
| `query_terrain` | `center_x?`, `center_z?`, `radius?` | `GodService.queryTerrain` |
| `body_tools` | — | The Node Mineflayer tools behind `MCPGateway` (name, description, JSON Schema) |
| `body_call` | `tool`, `arguments?` | Runs one of them through `MCPGateway.execute`. An unknown tool name is refused. |
| `end_session` | — | `GodService.endSession`: vanish if manifested, release the lock, revoke the ticket |

The Mineflayer body is **proxied**, not handed to the agent, so `GodToolGate` still applies and the Node server is
unchanged. There is no `ListTools`: MCP `tools/list` does that job.

## Results and errors

A tool returns one text content. Refusals from the server layer have `isError: true`: bad ticket, ended session,
offline player, disabled bridge, bad arguments, an unknown body tool, no pivot, a lease refusal, or a placement
that did not place. The model can read all of them. The `GodService` texts (clamp notes, "Trade cancelled…") come
back as ordinary results, exactly as the builtin ChatBot sees them. A tool that throws becomes
`isError: "Erreur côté serveur pendant '<tool>'."` and is logged. It is never a protocol error.

## Tests

Contract tests start the **real** servers on an ephemeral loopback port and connect the **official MCP Java SDK
client** (`McpClient.sync` + `HttpClientStreamableHttpTransport`, `McpTestClients`). Only Minecraft
(`RecordingGodWorld`, `RecordingBuildWorld`) and the Node body (`RecordingBodyTools`) are recording stand-ins.

- `BuilderMcpServerTest` covers:
  - `tools/list` names and schemas;
  - anchor-relative placement;
  - unknown, expired and god tickets;
  - an unknown block, an offline player, no origin;
  - the 128-block cap on line and array calls, and mismatched arrays;
  - a fifth sub-build;
  - anchors beyond ±256;
  - cancelled and idle leases;
  - another build's lease;
  - HTTP-level refusals: `401` with no or a bad token, `403` for a foreign Origin, `405` for GET, `400` for bad
    JSON, and the SDK client being refused.
- `GodMcpServerTest` covers:
  - the tool list, with no `place_*`;
  - a full encounter;
  - components reaching the world intact;
  - every clamp;
  - another player's or a forged ticket;
  - a stale ticket from an earlier session;
  - body tools with the bridge off;
  - an offline player;
  - the `wait` bound;
  - an expired ticket.
- `AgentTicketsTest` covers ticket kinds, expiry and revocation, plus the token and Origin predicates.

The **MCP test bench** ([mcp-test-bench.md](mcp-test-bench.md)) goes further, from the same fixtures:
- raw-protocol conformance;
- schema-driven fuzzing of every advertised tool;
- every tool × every wrong authority;
- concurrency;
- scenario files;
- `gradle mcpProbe`, a read-only check of a running server.

What these cannot show (anything that needs a world) is in the in-game checklist of
[docs/26 §6](../../26-god-builder-mcp-prompt.md).

## Related

- [external-agent.md](external-agent.md): the agent side (opencode config, `/pray` and `/build` with `godAgent = external`)
- [god-body.md](god-body.md): session lock, watchdog, avatar invulnerability
- [building.md](building.md): `BuildGuard`, the builtin build agent
- [tools-catalogue.md](tools-catalogue.md): the builtin tool POJOs these mirror
- [../reference/ports-files-config.md](../reference/ports-files-config.md): port 8771 and `god_agent.properties`
