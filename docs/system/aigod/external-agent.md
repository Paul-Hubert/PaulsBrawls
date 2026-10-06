---
id: aigod.external-agent
title: AI God — the external agent (opencode) and godAgent = external
system: aigod
summary: How /pray, /prove and /build reach opencode when godAgent = external — the god-agent/ config (agents, permissions, prompts), AgentClient and AgentTurns, one session per player, failure messages, session-end aborts, install and startup, and the end-to-end test against the real opencode binary.
tags: [aigod, opencode, external-agent, godagent, agentturns, agentclient, sub-agents, builder, prayer, 4096, e2e]
sources:
  - god-agent/opencode.json
  - god-agent/prompts/god.md
  - god-agent/prompts/builder.md
  - god-agent/prompts/sub-builder.md
  - god-agent/README.md
  - src/main/java/com/paul/brawl/AgentTurns.java
  - src/main/java/com/paul/brawl/AgentClient.java
  - src/main/java/com/paul/brawl/ExternalAgent.java
  - src/main/java/com/paul/brawl/GodAgentConfig.java
  - src/main/java/com/paul/brawl/ChatCommand.java
  - src/main/java/com/paul/brawl/ImageReceiver.java
  - src/main/java/com/paul/brawl/ChatBotActions.java
  - src/test/java/com/paul/brawl/AgentE2ETest.java
  - src/test/java/com/paul/brawl/ScriptedLlm.java
  - src/test/java/com/paul/brawl/AgentClientTest.java
  - src/test/java/com/paul/brawl/AgentTurnsTest.java
  - docs/27-god-builder-mcp-design.md
verified_at: 9406df0
---

# AI God — the external agent

**TL;DR.** With `godAgent = external` (`god_agent.properties`), the mod stops thinking.
- `/pray`, `/prove` and `/build` each become one **turn** of an **opencode** agent (`opencode serve`, `:4096`),
  in the player's own opencode session.
- The agent acts only through the mod's MCP servers ([mcp-servers.md](mcp-servers.md)), with a ticket the mod
  hands it.
- The builtin LangChain4j `ChatBot` stays as the default (`builtin`) until the in-game checklist of
  [docs/26 §6](../../26-god-builder-mcp-prompt.md) passes with `external`.
- Design and agent choice: [docs/27](../../27-god-builder-mcp-design.md).

## Components

| Piece | Where | Role |
|---|---|---|
| Agent config | `god-agent/opencode.json` | Model, the two remote MCP servers (`Authorization: Bearer {env:PAULSBRAWLS_MCP_TOKEN}`), global `permission: {"*": "deny"}`, and three agents |
| `god` agent (primary) | `prompts/god.md` (persona moved from `prompt.txt`) | `permission: {"*": "deny", "god_*": "allow"}` |
| `builder` agent (primary) | `prompts/builder.md` (replaces `build_prompt.txt` + `BuildPlan`) | `builder_*` and `task` limited to `sub-builder` |
| `sub-builder` agent (subagent) | `prompts/sub-builder.md` (replaces `BuildSubAgent` + its 5 refinement passes) | `builder_*` only |
| `AgentClient` | `AgentClient.java` | `POST /session`, `POST /session/:id/message` (synchronous: returns when the turn's tool loop ends), `POST /session/:id/abort`. Basic auth (`agentUsername` / `agentPassword` or `OPENCODE_SERVER_PASSWORD`). **HTTP/1.1 is forced**: the JDK client otherwise asks for an h2c upgrade that opencode's server never answers, and every call hangs. |
| `AgentTurns` | `AgentTurns.java` (Minecraft-free) | One turn per player and kind; turns run on virtual threads |
| `ExternalAgent` | `ExternalAgent.java` | Lifecycle: tickets, leases, MCP servers and turns, started on `SERVER_STARTED` in external mode |

opencode names MCP tools `<server>_<tool>` (`god_say`, `builder_place_line`). This was verified against opencode
1.18.34: with this config, the god agent is offered **only** `god_*` tools, with no bash, edit, read or webfetch
and no `builder_*`. A sub-builder is offered only `builder_*`, and the builder's `task` tool lists only
`sub-builder`.

## The trigger path

**`/pray <text>`** (`ChatCommand.onChatCommand`) and **`/prove`** (`ImageReceiver`, any text not starting with
`Build :`) go to `AgentTurns.pray`:

1. The player's turn slot is reserved first. If a turn is already running (or being set up) for this player, they
   are told `Dieu : (Dieu médite encore ta dernière prière.)`, and the running turn and its ticket are untouched.
2. Then the mod calls `GodSessionManager.claim`. If another player holds the avatar, the player is told
   `Dieu : (occupé avec un autre fidèle — reviens plus tard.)` and **the agent is never called**. Unlike the
   builtin path, there is no bodiless prayer.
3. The mod mints a god ticket (bound to the player and the session generation), then sends the god agent:

   ```
   [Prière de <name>]
   Ticket de séance : god-…
   Ton corps : disponible … | désactivé par un administrateur …
   (Une image est jointe …)          ← /prove only, plus a data-URL file part
   <name> dit : <text>
   ```
4. When the turn returns:
   - if it never called `say` but has final text, the mod says that text (`GodService.say`);
   - the ticket is revoked;
   - the encounter ends (`GodService.endSession`: the body vanishes and is made mortal, and the lock is released),
     just as the builtin ChatBot ends it when the model stops calling tools.

**`/build <text>`** (client screenshot, `Build :` prefix) goes to `AgentTurns.build`:

1. The sender must have a `/construction` pivot, otherwise they are told `Dieu : (aucun point de référence …)`.
   A second `/build` while one is running is told `Dieu : (une construction est déjà en cours pour toi.)`; the slot
   is reserved **before** minting, because minting revokes the player's earlier ticket and would kill the running
   build.
2. The mod mints a builder ticket. Its TTL is the larger of `ticketTtlSeconds` and `buildTurnTimeoutSeconds`.
3. The builder agent receives the ticket, the absolute pivot, the request and the screenshot.
4. The planner launches `sub-builder`s through `task`. Each one opens a sub-build lease, places blocks and closes
   the lease.
5. When the turn returns, the ticket is revoked, the player's leases are closed, and the final sentence is told as
   `Dieu : …`.

**Memory**:
- Each player has one opencode session per agent; the agent keeps the conversation.
- `/pray reset` forgets the god session (in builtin mode it clears `godBot`'s memory).
- `/construction` forgets the builder session, as it already clears `buildBot`'s memory.
- A turn that failed with DOWN or ERROR also drops its session, so the next one starts clean.

## Failures

The player never waits forever and the avatar is never left out.

| What happened | Player sees | Then |
|---|---|---|
| opencode not reachable (connection refused), or **killed mid-turn** (connection reset) | `Dieu : (le lien avec l'au-delà est rompu — réessaie plus tard.)` | session ended (vanish + mortal + released), ticket revoked |
| turn longer than `turnTimeoutSeconds` (300; builds: `buildTurnTimeoutSeconds`, 1800) | `Dieu : (Dieu s'est perdu dans ses pensées …)` | `POST /abort`, session ended |
| HTTP error or an error in the assistant `info` (bad key, provider down) | `Dieu : (Dieu reste muet — l'oracle a échoué.)` | session ended |
| the mod ended the session first (idle watchdog, `/pray stop`, `/godbody off`) | `Dieu : (la rencontre s'est achevée.)` | the `GodSessionManager` end listener revokes the ticket and aborts the agent's run; later tool calls are refused |
| `/godbody off` during a build | `Dieu : (construction arrêtée.)` | `BuildGuard.cancelAll` kills the leases; `ExternalAgent.abortBuilds` revokes tickets and aborts the runs |
| MCP servers failed to bind / not started | `Dieu : (le lien avec l'au-delà est rompu …)` | nothing reaches the agent |

The idle watchdog keeps running during an external turn and every `god` tool call resets it. A turn whose model
is silent for longer than `max(idleTimeoutSeconds, waitMaxSeconds + 5)` (90 s by default) is therefore ended by
the mod. A reasoning model that thinks longer than that between two tool calls needs a larger `idleTimeoutSeconds`
(`/llm bridge idle`).

## Install and start

See `god-agent/README.md`. In short:

1. `npm i -g opencode-ai` (checked with 1.18.34).
2. Provide the provider key (e.g. `OPENAI_API_KEY`) in opencode's environment, and set `model` in
   `god-agent/opencode.json`.
3. Set the same `PAULSBRAWLS_MCP_TOKEN` for both processes. Alternatively, start the server once and copy the
   generated `mcpToken` from `god_agent.properties`.
4. Set `OPENCODE_SERVER_PASSWORD` for both: the mod reads it as `agentPassword`.
5. `cd god-agent && OPENCODE_CONFIG=$PWD/opencode.json opencode serve --hostname 127.0.0.1 --port 4096`.
6. `godAgent=external` in `god_agent.properties` (server working directory), then restart the server.

The MCP servers start with the server. opencode retries the MCP connection itself, and
`curl -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/mcp` should show both `connected`.

## Tests

`AgentE2ETest` runs only when `OPENCODE_BIN` points at an opencode binary. It starts:
- the **real** `opencode serve`, with a copy of `god-agent/` where only the model and the URLs are changed;
- the **real** MCP servers;
- the **real** `AgentTurns` / `AgentClient`.

The only stand-ins are the LLM (`ScriptedLlm`, an OpenAI-compatible streaming script) and Minecraft (recording
world ports). It checks:
- a prayer reaches the world and ends the encounter;
- the god agent is offered only `god_*` tools;
- a silent turn is spoken for it;
- a second player never reaches the agent;
- a build runs planner → `task` → sub-builder → `place_line`, with the screenshot reaching the model as an image,
  and sub-builders offered only `builder_*`;
- a prayer and a build run concurrently;
- an unreachable agent gives a French message and a released avatar;
- a watchdog-style end aborts a stuck turn;
- killing opencode mid-turn sends the body home with a French message.

Recorded results are in [docs/PROGRESS.md](../../PROGRESS.md). `AgentClientTest` covers reply parsing and the
down path without opencode. `AgentTurnsTest` covers the turn bookkeeping without opencode (a stand-in that holds
each turn): a second `/build` or prayer leaves the running turn's ticket alive, and simultaneous prayers start one
turn.

## Related

- [mcp-servers.md](mcp-servers.md): the servers, tickets and every refusal
- [overview.md](overview.md): the builtin ChatBot path
- [god-body.md](god-body.md): session lock and watchdog
