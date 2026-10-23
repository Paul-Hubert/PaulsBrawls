---
id: aigod.external-agent
title: AI God — the external agent (opencode or Claude Code) and godAgent = external
system: aigod
summary: How /pray, /prove and /build reach the external agent when godAgent = external — opencode (god-agent/opencode.json, AgentClient) or Claude Code (god-agent/claude-code/, ClaudeCodeClient, agentKind = claude-code) — AgentTurns and the AgentBackend contract, one session per player, failure messages, session-end aborts, install and startup, and the end-to-end tests against the real opencode and claude binaries.
tags: [aigod, opencode, claude-code, external-agent, godagent, agentkind, agentturns, agentclient, agentbackend, claudecodeclient, sub-agents, builder, prayer, 4096, e2e]
sources:
  - god-agent/opencode.json
  - god-agent/prompts/god.md
  - god-agent/prompts/builder.md
  - god-agent/prompts/sub-builder.md
  - god-agent/README.md
  - god-agent/claude-code/.mcp.json
  - god-agent/claude-code/settings.json
  - god-agent/claude-code/.claude/agents/god.md
  - god-agent/claude-code/.claude/agents/builder.md
  - god-agent/claude-code/.claude/agents/sub-builder.md
  - src/main/java/com/paul/brawl/AgentBackend.java
  - src/main/java/com/paul/brawl/ClaudeCodeClient.java
  - src/test/java/com/paul/brawl/ClaudeCodeE2ETest.java
  - src/test/java/com/paul/brawl/ClaudeCodeClientTest.java
  - src/test/java/com/paul/brawl/ScriptedAnthropic.java
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
verified_at: a84125f
---

# AI God — the external agent

**TL;DR.** With `godAgent = external` (`god_agent.properties`), the mod stops thinking.
- `/pray`, `/prove` and `/build` each become one **turn** of an external agent, in the player's own session.
  `agentKind` picks it: **opencode** (default; `opencode serve` on `:4096`, `AgentClient`) or **Claude Code**
  (`claude-code`; one headless `claude -p` process per turn, `ClaudeCodeClient`). Both implement `AgentBackend`, so
  `AgentTurns` is the same for both.
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

### Claude Code (`agentKind = claude-code`)

| Piece | Where | Role |
|---|---|---|
| MCP config | `god-agent/claude-code/.mcp.json` | The two HTTP servers; `url` is `${PAULSBRAWLS_MCP_URL:-http://127.0.0.1:8771}/mcp/…`, header `Authorization: Bearer ${PAULSBRAWLS_MCP_TOKEN}`. The mod sets both variables for the process (`mcpPort`, the effective token). |
| Settings | `god-agent/claude-code/settings.json`, passed with `--settings` | `permissions.defaultMode: dontAsk`; allow `mcp__god`, `mcp__builder`, `Agent(sub-builder)`; deny `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`. It is not in `.claude/settings.json` because Claude Code ignores a project file's `allow` rules until the workspace is trusted interactively. A run with the allow list removed gets every MCP call denied, which shows the file is read. |
| Agents | `god-agent/claude-code/.claude/agents/{god,builder,sub-builder}.md` | Frontmatter `tools:` `mcp__god__*` / `Agent(sub-builder), mcp__builder__*` / `mcp__builder__*`; the body is **exactly** `god-agent/prompts/<agent>.md` (`ClaudeCodeClientTest` fails on drift). The main agent is chosen with `--agent`. |
| `ClaudeCodeClient` | `ClaudeCodeClient.java` | One process per turn, in the agent directory (`claudeDir`). See below. |

The command (checked with Claude Code 2.1.309):

```
claude -p --input-format stream-json --output-format stream-json --verbose --agent <god|builder>
       --mcp-config <dir>/.mcp.json --strict-mcp-config --settings <dir>/settings.json
       --setting-sources project --permission-mode dontAsk (--session-id <uuid> | --resume <uuid>) [--model <claudeModel>]
```

- **Isolation.** `--strict-mcp-config` loads only the two servers. `--setting-sources project` keeps out the
  server user's own settings, hooks and `CLAUDE.md` memory, while still loading the project agents. With `--agent`,
  the system prompt is Claude Code's one-line SDK preamble plus the agent's prompt. The god agent is offered exactly
  the 14 `mcp__god__*` tools; the builder gets `Agent` (only `sub-builder` listed) plus `mcp__builder__*`; a
  sub-builder gets only `mcp__builder__*` (`ClaudeCodeE2ETest`).
- **Input.** One stream-json user message on stdin, written as UTF-8, never on the command line (argv encoding
  follows the server's locale, and a French prayer could arrive as `Pri?re`). The `/prove` or `/build` screenshot
  is a base64 `image` block, which reaches the model as an image.
- **Sessions.** `createSession` mints a UUID. The first turn uses `--session-id`; after the process's `system/init`
  the next turn uses `--resume`, so the player's conversation continues. `/pray reset` (a new id) starts fresh.
  Claude Code keeps the transcripts under the server user's `~/.claude/projects/`.
- **Result.** The `result` text of the LAST `result` message. Claude Code runs sub-agents in the background: the
  planner answers once when it launches them, and again when Claude Code wakes it with their completion; the
  process exits after that, and the last answer is the one told to the admin.
- **Failures.** The binary cannot start, or a server in `system/init.mcp_servers` is `failed`/`needs-auth`
  (the turn is killed rather than answered without tools), or the process dies without a result → `DOWN`.
  No exit within the timeout → the process tree is killed, `TIMEOUT`. An error result, an aborted turn, or an
  `api_retry` with HTTP 401/403 (Claude Code would retry a refused key ten times with backoff) → `ERROR`. Other API
  errors (429, 5xx) are left to Claude Code's own retries, within the timeout.
- **Abort** (`/pray stop`, the watchdog, `/godbody off`) kills the session's process and its descendants.
- **Auth.** Whatever the `claude` CLI uses for the server's user: a `claude` login, or `ANTHROPIC_API_KEY` in the
  server's environment. The mod adds `PAULSBRAWLS_MCP_TOKEN` and `PAULSBRAWLS_MCP_URL`, adds `127.0.0.1`,
  `localhost` and `::1` to `NO_PROXY`/`no_proxy` (with `HTTPS_PROXY` set for the model API, Claude Code sent the
  loopback MCP calls to the proxy and reported `god` as failed; found on the live run), and removes `CLAUDECODE` (so
  a server started from a Claude Code session does not look nested).

What Claude Code does with the tools' metadata: titles are shown, and a tool with structured output
(`begin_sub_build`, `get_build_origin`) reaches the model as its `structuredContent` JSON instead of the text. The
prompts work with either.

### opencode (`agentKind = opencode`, default)

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
- Each player has one agent session per agent (an opencode session, or a Claude Code conversation resumed with
  `--resume`); the agent keeps the conversation.
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

The idle watchdog keeps running during an external turn, and every `god` tool call resets it. It stays the
backstop against an untrusted agent that went quiet, but with a longer fuse: `AgentTurns.pray` raises the
session's idle limit to `agentIdleTimeoutSeconds` (`god_agent.properties`, default 180 s; never below the builtin
`max(idleTimeoutSeconds, waitMaxSeconds + 5)`, 90 s by default) through `GodSessionManager.setAgentIdleTimeout`.
A reasoning model may therefore think up to 3 minutes between two tool calls; the whole turn is still capped by
`turnTimeoutSeconds`. The limit is per session: the session's end restores the builtin limit, so a later builtin
prayer is unaffected (`AgentTurnsTest.aPrayerTurnGivesTheAgentsModelTheLongerIdleLimit`).

### Known limits (deliberately left)

- **The say fallback.** When a turn never called `say` (or every `say` it made was refused), its final assistant
  text is said to the player as `Dieu : …`. The prompts tell the agent to speak only through `say` and to end
  without text, so this only catches an agent that answered in plain text. If the model ends with meta-commentary
  ("I rewarded the player"), the player reads it. The mod does not try to detect such text: any language or style
  check would be a string heuristic. A turn that spoke through `say` never has its final text repeated.
- **No bodiless prayer.** A prayer while the avatar is busy is refused instead of answered without a body, because
  the god tools act only for the session owner. This is the docs/27 design, not a bug.

## Install and start

See `god-agent/README.md`. With Claude Code:

1. Install Claude Code (checked with 2.1.309) and log in as the server's user (`claude`, then `/login`), or put
   `ANTHROPIC_API_KEY` in the server's environment.
2. Copy `god-agent/claude-code/` next to the server (or point `claudeDir` at it).
3. In `god_agent.properties`: `godAgent=external`, `agentKind=claude-code`, and optionally `claudeBin` (default
   `claude` on PATH), `claudeDir` (default `god-agent/claude-code`) and `claudeModel` (blank = Claude Code's
   default). Restart the server. No other process is needed.
4. To check the servers by hand: `claude mcp add --transport http god http://127.0.0.1:8771/mcp/god --header
   "Authorization: Bearer $PAULSBRAWLS_MCP_TOKEN"` (and the same for `builder`) in any scratch directory, then
   `claude mcp list` should show both `✔ Connected`. `gradle mcpProbe` checks them without Claude Code.

With opencode:

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

`ClaudeCodeE2ETest` (13 tests) runs only when `CLAUDE_BIN` points at the `claude` executable. It runs the **real**
Claude Code with a copy of the repo's `god-agent/claude-code/` (unchanged), the **real** MCP servers and the
**real** `AgentTurns` / `ClaudeCodeClient`, each process with an isolated HOME and no inherited environment. The
LLM is `ScriptedAnthropic`, an Anthropic Messages API script (streaming SSE, `tool_use` blocks) reached through
`ANTHROPIC_BASE_URL` with a dummy key. It checks:
- a prayer reaches the world and ends the encounter; the god agent is offered only the 14 `mcp__god__*` tools, its
  prompt is the system prompt, and French text arrives intact;
- a silent turn is spoken for it; a `/prove` image reaches the model;
- the second prayer resumes the first one's conversation, and `/pray reset` starts a fresh one;
- a second player never reaches the agent;
- a build runs planner → `Agent` → sub-builder → `place_line` (5 blocks at the right absolute positions), with
  the screenshot reaching the planner, only `sub-builder` offered as a sub-agent, and the planner's last answer told;
- a prayer and a build run concurrently in separate processes;
- an unstartable binary and unreachable MCP servers are `DOWN`, a refused API key is `ERROR` at once;
- a watchdog-style end kills the process; a turn over the timeout is killed (`TIMEOUT`); the process dying mid-turn
  sends the body home with a French message.

`ClaudeCodeClientTest` covers the command line, the stdin message, result and stream parsing, the config switch,
and that the Claude Code agents' bodies equal `god-agent/prompts/*.md`.

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
turn. See also the MCP test bench, [mcp-test-bench.md](mcp-test-bench.md).

## Related

- [mcp-servers.md](mcp-servers.md): the servers, tickets and every refusal
- [overview.md](overview.md): the builtin ChatBot path
- [god-body.md](god-body.md): session lock and watchdog
