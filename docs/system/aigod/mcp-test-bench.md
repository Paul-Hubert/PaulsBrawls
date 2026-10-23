---
id: aigod.mcp-test-bench
title: AI God — the MCP test bench (god and builder servers)
system: aigod
summary: The test bench for the mod's god/builder MCP servers — the McpBench fixture, the protocol-conformance, schema-fuzz, authority-matrix, concurrency and scenario-file suites, the read-only live probe (gradle mcpProbe), how to extend each, and the bugs it found.
tags: [aigod, mcp, mcp-server, test-bench, fuzzing, conformance, tickets, concurrency, scenarios, mcpprobe, junit, 8771]
sources:
  - src/test/java/com/paul/brawl/McpBench.java
  - src/test/java/com/paul/brawl/McpProtocolConformanceTest.java
  - src/test/java/com/paul/brawl/McpToolFuzzTest.java
  - src/test/java/com/paul/brawl/McpTicketMatrixTest.java
  - src/test/java/com/paul/brawl/McpConcurrencyTest.java
  - src/test/java/com/paul/brawl/McpScenarioTest.java
  - src/test/java/com/paul/brawl/McpLiveProbe.java
  - src/test/java/com/paul/brawl/McpLiveProbeTest.java
  - src/test/java/com/paul/brawl/McpTcpNoDelayTest.java
  - src/test/java/com/paul/brawl/McpLatencyMain.java
  - src/test/java/com/paul/brawl/SubBuildsSweeperTest.java
  - src/test/java/com/paul/brawl/McpClaudeCodeInteropTest.java
  - src/test/java/com/paul/brawl/AgentTurnsTest.java
  - src/test/java/com/paul/brawl/RecordingGodWorld.java
  - src/test/java/com/paul/brawl/RecordingBuildWorld.java
  - src/test/java/com/paul/brawl/RecordingBodyTools.java
  - src/test/java/com/paul/brawl/McpTestClients.java
  - src/test/resources/mcp-bench/01-prayer-full-encounter.json
  - build.gradle
  - src/main/java/com/paul/brawl/McpHttpEndpoint.java
  - src/main/java/com/paul/brawl/AgentTickets.java
  - src/main/java/com/paul/brawl/AgentTurns.java
verified_at: a84125f
---

# AI God — the MCP test bench

**TL;DR.** The `god` and `builder` MCP servers ([mcp-servers.md](mcp-servers.md)) face an agent that is never
trusted, so they are tested the way an agent would attack them:
- every tool, under every way its authority can be wrong;
- every argument, with the wrong shape or a hostile value;
- the wire protocol, spoken raw;
- many callers at once.

All of it runs in plain `gradle test` (no Minecraft, no network, ~10 s). On top of that, `gradle mcpProbe` checks a
**running** server read-only. The protocol side is always the real code: the real servers on a loopback port,
the official MCP Java SDK client or raw JSON-RPC over HTTP. Only Minecraft, the Node body and the clock are
stand-ins.

## Running it

| What | Command |
|---|---|
| Everything (with the rest of the mod's tests) | `gradle test -Pmods_folder=path/to/your/mods -Pclient_mods_folder=path/to/your/mods` |
| Only the bench | `gradle test --tests 'com.paul.brawl.Mcp*' --tests 'com.paul.brawl.AgentTurnsTest' …` |
| Deeper fuzzing | `gradle test --tests 'com.paul.brawl.McpToolFuzzTest' -PmcpFuzz=500 -PmcpSeed=7 …` (default 25 iterations per tool, seed 24301) |
| A running server (read-only) | `gradle mcpProbe -PmcpToken=<mcpToken> [-PmcpUrl=http://127.0.0.1:8771]` (token defaults to `PAULSBRAWLS_MCP_TOKEN`) |
| With the real opencode as well | `OPENCODE_BIN=…/node_modules/.bin/opencode gradle test …` (see [external-agent.md](external-agent.md)) |
| With the real Claude Code CLI as well | `CLAUDE_BIN=$(command -v claude) gradle test --rerun …` (`McpClaudeCodeInteropTest` connects it to the bench) |

The JDK `HttpServer` adds ~40 ms of Nagle/delayed-ACK stall to every request unless
`sun.net.httpserver.nodelay` is true when the JVM's first `HttpServer` is created. The code sets it
(`JdkHttpServers.tcpNoDelay()`, in production and in every test stand-in), so `build.gradle` no longer does; without
it the fuzz suite takes ~50 s instead of ~5 s.

## The fixture: `McpBench`

One `McpBench` = the real `AgentMcpServers` on port 0 with:

| Stand-in | For |
|---|---|
| `RecordingGodWorld` | Minecraft for God: records `give …`, `strike xN`, `appear d h face`, `tell …`; online set, known items/entities |
| `RecordingBuildWorld` | Minecraft for building: records every placed block (absolute `x,y,z block`) and every batch size |
| `RecordingBodyTools` | The Node Mineflayer tools: one tool (`move-to-position`), calls recorded |
| `clock` (an `AtomicLong`) | Time for tickets and sub-build leases: `advance` instead of sleeping. The real periodic sub-build sweeper runs every 10 ms of real time and measures idleness on this clock. |
| `bridge` (an `AtomicBoolean`) | `/godbody on|off` |

The real `GodService`, `BuildService`, `AgentTickets`, `SubBuilds`, `GodSessionManager` and `BuildGuard` sit in
between. Helpers:
- `player(name)`: a named player, online by default.
- `godTicket(name)`: what `/pray` does (claim the avatar, mint a ticket).
- `builderTicket(name)`: what `/build` does (a pivot if missing, mint a ticket).
- `reset()`: a fresh case.
- `rpc` / `rawCall`: raw JSON-RPC.
- `catalogue()`: every advertised tool and its schema, read from `tools/list`.
- `validArgs(...)`: schema-valid, world-valid arguments for any tool.
- `snapshot()` / `effectsSince(before)`: the world effects of one step.
- `assertWorldInvariants()`: every recorded effect is within the clamps the mod promises. These are the reward
  amount, strikes (0 is a legal no-op), spawn count, offsets and griefing, weather type and duration, appear
  distance and height, trade amounts, the length of a God line, ≤ 128 blocks per placement call, and ≤ 4 slots and
  leases.

`GodSessionManager` and `BuildGuard` are static, so bench suites must not run in parallel (JUnit's default is
sequential).

## The suites

| Suite | Cases | What it proves |
|---|---|---|
| `McpProtocolConformanceTest` | 78 | The wire protocol, raw. Both endpoints: `initialize` (server name, instructions, tools capability, version negotiation for an unknown version), `ping`, `-32601` for an unknown method, an unknown tool is an error not a crash, a well-formed `tools/list` (names, descriptions, closed schemas, typed properties). Notifications get `202` with no body. String and number ids are echoed. Malformed messages (bad JSON, batches, a response, no method) get `400` with a JSON-RPC error. Bad `tools/call` params get `-32602` in a `200`. 200 garbage messages leave the server up and the world untouched. HTTP: only POST, exact paths (`404` for `/mcp/godx`, `/mcp/god/`, `/mcp/GOD`…), the 1 MiB cap to the byte. Auth: 10 bad `Authorization` forms are `401`, the scheme is case-insensitive, auth comes before the method check, a blank configured token refuses everyone, the token is read per request (rotation). Origin: 8 foreign forms are `403` (`null`, `localhost.evil.example`, `127.0.0.1.nip.io`, LAN, `[::2]`…) and 5 loopback forms pass. A closed server refuses connections, and UTF-8 text (accents, emoji, quotes, control characters) round-trips intact. Every tool has a title and complete annotations (`openWorldHint` false), and the structured results of `get_build_origin` / `begin_sub_build` validate against their output schemas, with the same facts in the text. |
| `McpToolFuzzTest` | 514 | **Every** advertised tool, discovered from `tools/list` (a new tool is fuzzed with no edit). *Shape attacks*: each required argument missing, each argument of each wrong JSON type or `null`, an undeclared argument. Each must be refused with no effect on the world. A *baseline* check proves the valid call passes the schema, so the refusals mean something. *Value fuzz*: seeded random edge values (0, ±1, int limits, 127/128/129, 511/512/513, 10⁶±1, ±1e308, empty, huge and control-character strings, `/op @a`, `${jndi:…}`, `§` codes, forbidden blocks and mobs, 0/128/129/400-element arrays). The server must answer an envelope (never `-32603`, never "Erreur côté serveur"), stay up, and keep every effect within the invariants. The block count told to the agent must equal what was placed. |
| `McpTicketMatrixTest` | 222 | **Every tool × every wrong authority**. Both servers: a forged ticket, an empty one, the other server's ticket, an expired one, a revoked one, one superseded by a newer ticket, an offline player. God only: a session ended by the watchdog, a stale ticket after the same player prays again, bob's ticket while alice holds the avatar, the body disabled (body tools). Builder only: another build's sub-build, a closed one, a cancelled one (`/godbody off`), an idle-expired one, a forged id, no `/construction` pivot. Each cell must be refused and leave the world, the avatar owner, the session generation and the slot count untouched. A refused call may sweep a dead lease, but never takes a slot. `end_session` may answer "déjà close" instead of an error, but changes nothing. |
| `McpConcurrencyTest` | 6 | 32 simultaneous `begin_sub_build` → exactly 4 win, and the losers are told why. Concurrent `end_sub_build` returns every slot exactly once. 4 sub-builds × 30 parallel `place_line` lose no block and duplicate none. 40 SDK clients connect and list at once. A session end racing 8 spamming callers: nothing started after the end is accepted, and only session refusals come back. A prayer and 3 builds run side by side without touching each other's state. 32 concurrent mints for one player leave exactly one live ticket. |
| `McpClaudeCodeInteropTest` | 8 | **Claude Code as the client.** Replays the request shapes Claude Code 2.1.309 sends, recorded against these servers: the `server/discover` probe of the 2026-07-28 draft (`Mcp-Method` header; answered `-32601` with the string id echoed, so it falls back), `initialize` at 2025-11-25 (accepted as is, no `Mcp-Session-Id`), `notifications/initialized` and later requests with `MCP-Protocol-Version`, the `GET` for an SSE stream (`405`, `Allow: POST`), a `tools/call` with `_meta.claudecode/toolUseId` + `progressToken`, a wrong token (`401` with a body the CLI prints), the OAuth discovery and `/register` probes it makes when no header is set (plain `404`s), and a session `DELETE` (`405`). With `CLAUDE_BIN` set, the **real** CLI runs `claude mcp add --transport http … --header "Authorization: Bearer …"` for both endpoints and `claude mcp list` in an isolated HOME, and both must report connected. |
| `McpScenarioTest` | 1 per file | The scenario files below |
| `McpLiveProbeTest` | 3 | The probe itself: all green on the bench without touching the world or a live session; a wrong token or an unreachable server fails |
| `McpTcpNoDelayTest` | 1 | In a fresh JVM (the JDK reads `sun.net.httpserver.nodelay` once), a request to the real servers takes a few ms, not ~44 ms |
| `SubBuildsSweeperTest` | 3 | The periodic sub-build sweep releases idle leases with no call and stops when closed |
| `AgentTurnsTest` | 4 | The trigger path's bookkeeping (real `AgentTurns` + `AgentClient`; opencode replaced by a server that holds each turn until released). A second `/build` or prayer while a turn runs is refused without killing the running turn's ticket, and 16 simultaneous prayers of one player start exactly one turn with a live ticket. A prayer turn raises the avatar's idle limit to `agentIdleTimeoutSeconds`, and the session's end restores it. |

The older contract suites (`GodMcpServerTest`, `BuilderMcpServerTest`, through the SDK client) and the opencode
end-to-end test (`AgentE2ETest`) stay as they are; see [mcp-servers.md](mcp-servers.md) and
[external-agent.md](external-agent.md).

## Scenario files (`src/test/resources/mcp-bench/*.json`)

One file is one scenario, run against a fresh `McpBench`. **Adding a case is adding a file.** Unknown keys fail the
scenario, so a typo cannot pass silently. `${name}` substitutes a variable, and a string that is exactly
`"${n}"` holding an integer is sent as a number.

| Step | Effect |
|---|---|
| `{"pray": "alice", "as": "t"}` | `/pray`: claim the avatar for alice, ticket in `${t}`. With `"busy": true`, assert alice finds the avatar busy instead. |
| `{"build": "alice", "as": "b", "pivot": [x,y,z]}` | `/build` (pivot optional, default 100 64 200) |
| `{"mint": "god"\|"builder", "player": "bob", "as": "x"}` | A ticket minted outside the normal path (a bug or a forgery elsewhere) |
| `{"call": "god/say", "args": {...}, "expect": {...}}` | A raw `tools/call`. Without `expect`, it must not be an error. |
| `{"advance": "120s"}` | Move the bench clock (`ms`, `s`, `m`) |
| `{"offline": "alice"}` / `{"online": "alice"}` | The player logs out or back in |
| `{"unpivot": "alice"}` | Remove the player's `/construction` pivot |
| `{"watchdog": true}` | The idle watchdog, `/pray stop` (`forceEndSession`) |
| `{"godbody": "off"\|"on"}` | `/godbody`: off also ends the session and cancels every sub-build |
| `{"revoke": "${t}"}` | The turn ended (the mod revokes its ticket) |
| `{"state": {...}}` | Assert `busy`, `owner`, `manifested`, `slots`, `leases` (held), `liveTickets` |
| `{"await": {...}}` | The same keys as `state`, polled for up to 2 s: a state reached with no call (the periodic sub-build sweeper) |
| `{"repeat": n, "steps": [...]}` | Loop, with `${i}` = 0..n-1 |
| `{"comment": "..."}` | Nothing |

The `expect` keys are:
- `error`: the expected error flag (default false);
- `text`: the exact text;
- `contains` / `absent`: substrings that must or must not appear;
- `effects`: the exact list of world effects of this call (`"god: give minecraft:diamond x2"`,
  `"place: 110,64,195 minecraft:stone"`, `"body: …"`);
- `effectsContain`;
- `noEffects`: no world-changing effect;
- `capture`: `{"var": "regex with a group"}`, which saves part of the text as a variable.

| File | Story |
|---|---|
| `01-prayer-full-encounter` | Context, appear, reward, say (also spoken), `end_session` (vanish); then the ticket is dead |
| `02-rival-player` | bob cannot pray while alice holds the avatar; a ticket minted for him anyway opens nothing; alice continues |
| `03-watchdog-and-new-prayer` | A watchdog end kills the ticket, even after alice prays again and gets a new session |
| `04-build-lifecycle` | Pivot, anchor and offsets give exact absolute positions; an unknown block; a closed sub-build refuses |
| `05-sub-build-slots` | 4 slots; a fifth is refused; ending one frees one; idle leases give their slots back with no builder call (the periodic sweeper); anchors beyond ±256 |
| `06-godbody-off` | `/godbody off` ends the prayer and cancels the build; the body is refused but the voice works without a body; `/godbody on` brings the body back |
| `07-clamps` | Every God clamp, with the exact effect that reached the world |
| `08-offline-and-expiry` | An offline player cannot be acted on, then can when back; a missing pivot; expired tickets |

## The live probe (`gradle mcpProbe`)

`McpLiveProbe` is the preflight of the in-game checklist ([docs/26 §6](../../26-god-builder-mcp-prompt.md)). It
runs against the server you are about to test, with its real token. It never holds a valid ticket, so nothing it
sends can reach the world, and it is safe on a populated server. It runs 42 checks:
- both endpoints initialize, with the right server names;
- `tools/list` is exactly the 14 god and 8 builder tools, each requiring `ticket`;
- every tool has a title and annotations, exactly the expected tools are read-only (`GOD_READ_ONLY`,
  `BUILDER_READ_ONLY`), and exactly `get_build_origin` and `begin_sub_build` declare an output schema;
- no token and a wrong token get `401`, a foreign Origin gets `403`, GET gets `405`;
- every tool refuses a forged ticket.

It prints one `PASS`/`FAIL` line per check and exits 0 only if all pass. The run against a real `gradle runServer`
dev server (`godAgent=external`) gave `ALL PASS (36 checks)` before the tool metadata existed (2026-10-06); see
[docs/PROGRESS.md](../../PROGRESS.md) for the latest run.

## Extending

- **A new MCP tool** joins the fuzz and the ticket matrix automatically. Add it to
  `McpLiveProbe.GOD_TOOLS`/`BUILDER_TOOLS`, which pin the exact surface (a tool appearing or vanishing must be a
  decision), give it a `McpTools.Meta` (title and hints; a read-only one also goes in `*_READ_ONLY`, a structured
  one in `BUILDER_STRUCTURED`). If it takes an argument name `McpBench.validValue` does not know, add a valid value there; a
  `string` defaults to `"fuzz"`. If it has a clamp, add the clamp to `assertWorldInvariants` and a scenario to
  `07-clamps`.
- **A new authority rule** (a new way to be refused) is one `Condition` in `McpTicketMatrixTest.conditions()`.
- **A new world effect** needs a recording line in the `Recording*` port, and a pattern in
  `assertWorldInvariants` if it has a limit.
- **A regression** found in game becomes a scenario file first: it reads like the bug report.

## What the bench found

| Finding | Fixed |
|---|---|
| A `tools/call` whose `params` the SDK cannot convert (`"params": 0`, `[1]`, `"x"`…) escaped as an `IllegalArgumentException` and came back as **HTTP 500**, `-32603` | `McpHttpEndpoint` answers `-32602 Invalid params` in a `200` (a regression test is in the conformance suite) |
| `AgentTickets.mint` was revoke-then-put, so concurrent mints for one player could leave several live tickets | `mint` and `revoke(player, kind)` are synchronized; exactly one stays live |
| `AgentTurns.build` minted the new ticket **before** checking for a running build. Minting revokes the player's earlier ticket, so a second `/build` while one was running was refused **and killed the running build** (every later tool call of that build was refused). Simultaneous prayers of one player had the same race. | `AgentTurns` reserves the player's turn slot first, then claims and mints (`ae14a12`, `AgentTurnsTest`) |
| Each MCP request pays ~40 ms of Nagle/delayed-ACK stall on the JDK `HttpServer`: a build of 500 `place_*` calls spends ~20 s waiting on TCP | `JdkHttpServers.tcpNoDelay()` runs first in `ServerEntryPoint` and before every `HttpServer.create`. The JDK reads the property once per JVM, so `McpTcpNoDelayTest` measures in a fresh JVM: ~3 ms per request vs ~44 ms with Nagle. The `:8767` listener gets the same bytes without the stall. |
| Idle sub-build leases were swept **lazily**, on the next builder call, so until then their slots stayed taken for the builtin `BuildSubAgent` too | `SubBuilds.startSweeper`: external mode sweeps every `clamp(subBuildIdleSeconds/4, 1 s, 30 s)` until server stop. The bench runs the same sweeper (every 10 ms, idleness on the bench clock); `05-sub-build-slots` now awaits the release with no call, and `SubBuildsSweeperTest` covers start and stop. |
| `god` refusals that come from `GodService` (an unknown item, "Trade cancelled…", reward amount 0) came back with `isError: false`, unlike the builder, which flagged every non-placement by checking that the text ended in "placé(s)." | `GodService`/`BuildService` return a typed `WorldOutcome(text, refused)`; the MCP servers map `refused` to `isError` and the text sniffing is gone. The builtin ChatBot reads the same texts. `07-clamps` pins `error: true` on every refusal and `false` on clamped successes; `GodServiceTest`/`BuildServiceTest` check the flag. |

## Related

- [mcp-servers.md](mcp-servers.md): the servers, tickets and every refusal
- [external-agent.md](external-agent.md): opencode, `AgentTurns`, the end-to-end test
- [../platform/build-and-runtime.md](../platform/build-and-runtime.md): the full test table
