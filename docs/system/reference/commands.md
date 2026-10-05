---
id: reference.commands
title: Command reference — every in-game command, Eden CLI and admin verb
system: meta
summary: One table of every Brigadier command (server + client) with exact syntax, permission level and source line, plus Eden's npm scripts and admin HTTP verbs.
tags: [commands, brigadier, permissions, gib, pray, llm, godbody, mcp, village, villagers, construction, prove, build, accept, npm, admin]
sources: [src/main/java/com/paul/brawl/ServerEntryPoint.java, src/main/java/com/paul/brawl/GibCommand.java, src/main/java/com/paul/brawl/ChatCommand.java, src/main/java/com/paul/brawl/LLMCommand.java, src/main/java/com/paul/brawl/MCPCommand.java, src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/VillageCommand.java, src/main/java/com/paul/brawl/VillagersCommand.java, src/client/java/com/paul/brawl/Screenshotter.java, eden/package.json, eden/src/admin/server.ts]
verified_at: 4a8081f
---

# Command reference

**TL;DR** — The mod registers 14 server root commands and 2 client commands. "Perm" is the vanilla permission level
checked by `.requires(source -> source.hasPermissionLevel(n))`; a command with **no** `.requires` is open to everyone
(perm 0). Every server command is registered from `ServerEntryPoint` (a `DedicatedServerModInitializer`), so **none of
them exist in singleplayer / Open-to-LAN** — see [platform/entrypoints-and-wiring.md](../platform/entrypoints-and-wiring.md).
Most console invocations of player-oriented commands NPE (they call `getPlayer()`).

## Server commands (Fabric mod)

### Gibber — money

| Syntax | Perm | Source | Behaviour |
|---|---|---|---|
| `/gib <amount:int>` | 2 | `GibCommand.java:22-24` | Adds `amount` to global `total_revenue` and pays every online player their backlog. Negative values accepted. No chat feedback (log line only). |
| `/gib_salary <amount:int>` | 2 | `GibCommand.java:51-53` | Sets `salary_per_day` (coins added to `total_revenue` each period). **Default is 0 → no salary until set.** |
| `/gib_salary_period <seconds:int≥1>` | 2 | `GibCommand.java:74-76` | Sets `salary_period` and restarts the scheduler. Default 10 s. |

Details: [gibber/money-system.md](../gibber/money-system.md).

### AI God — prayers, trades, admin

| Syntax | Perm | Source | Behaviour |
|---|---|---|---|
| `/pray <text…>` | 0 | `ChatCommand.java:28-41` | Greedy `MessageArgumentType`. Sends a prayer to the Java God; claims the avatar via `GodSessionManager` (bodiless if another player owns it). |
| `/pray stop` | 0 | `ChatCommand.java:30` | Ends *your* session (owner only); chat `Dieu : (la séance est close.)`. |
| `/accept` | 0 (no `.requires`) | `TradeOffers.java:100-104` | Accepts your pending God trade offer (RAM-only, no expiry). |
| `/prompt` | 2 | `ChatCommand.java:137-142` | Re-reads `prompt.txt` / `build_prompt.txt` for both bots, then prints the hardcoded + custom prompt (NPE from console). |
| `/prompt <text…>` | 2 | `ChatCommand.java:117-119` | Sets the custom prompt (`prompt` field) on **both** `godBot` and `buildBot`; in RAM only. |
| `/godbody off` | 2 | `ChatCommand.java:62` | Kill-switch: clears `GodActionQueue`, vanishes the avatar, force-ends the session, disables the bridge. **Does not** restore avatar vulnerability. |
| `/godbody on` | 2 | `ChatCommand.java:75` | Re-enables the bridge. Bare `/godbody` has no executor. |
| `/llm` | 2 | `LLMCommand.java:24-25` | Root; prints current LLM config. |
| `/llm provider <word>` | 2 | `LLMCommand.java:30-31` | `openai` \| `lmstudio` \| `ollama` \| `anthropic`. |
| `/llm model <name…>` | 2 | `LLMCommand.java:41-42` | Saved, but **not applied until `/llm reload`**. |
| `/llm host <host…>` / `port <1..65535>` / `apikey <key…>` | 2 | `LLMCommand.java:46-57` | Per-provider settings (persisted in plaintext to `llm_config.properties`). |
| `/llm timeout <5..1800>` | 2 | `LLMCommand.java:61-62` | HTTP timeout for every LLM call (default 180 s). |
| `/llm reload` | 2 | `LLMCommand.java:66` | Rebuilds the chat models. |
| `/llm bridge` | 2 | `LLMCommand.java:73` | Prints `BridgeConfig.describe()`. |
| `/llm bridge enabled <bool>` · `url <url…>` · `bot <word>` · `griefing <bool>` · `waitmax <1..600>` · `spawnmax <1..64>` · `idle <5..3600>` | 2 | `LLMCommand.java:78-109` | God-body settings → `bridge_config.properties`. `idle` must exceed `waitMax`; `waitmax N` bumps idle to `N+30` if idle ≤ N. |
| `/mcp` · `/mcp status` | 0 (no `.requires`) | `MCPCommand.java:32-42` | Prints MCP gateway status. |
| `/mcp reload` | 2 | `MCPCommand.java:43-44` | Reconnect + fresh `listTools()` **on the server thread** (can freeze up to the MCP timeout). Does not re-read `mcp_config.properties`. |

Details: [aigod/configuration-and-commands.md](../aigod/configuration-and-commands.md), [aigod/god-body.md](../aigod/god-body.md), [aigod/mcp-gateway.md](../aigod/mcp-gateway.md), [aigod/actions-and-trades.md](../aigod/actions-and-trades.md).

### AI God — building

| Syntax | Perm | Source | Behaviour |
|---|---|---|---|
| `/construction` | 2 | `ChatBotActions.java:183-184` | Raycasts (100 blocks) from the player's eyes and stores the hit as the build **pivot**; wipes the build sub-agent's memory. No feedback on a miss. |
| `/block <x> <y> <z>` | 2 | `ChatBotActions.java:166-170` | Debug: places stone at **pivot + (x,y,z)** (relative, not absolute). |

Details: [aigod/building.md](../aigod/building.md).

### Eden integration (village)

| Syntax | Perm | Source | Behaviour |
|---|---|---|---|
| `/village` | 2 | `VillageCommand.java:74-78` | Prints `VillageConfig` + `:8767` listener state. |
| `/village status` · `pause` · `resume` | 2 | `VillageCommand.java:47-55` | HTTP to the **legacy v1** Node admin (`nodeAdminUrl`, :8766). They cannot control Eden. |
| `/village on` · `off` | 2 | `VillageCommand.java:59-71` | Start/stop the `:8767` trade-settlement listener (persisted to `village_config.properties`). |
| `/villagers start <name>` | 2, player only | `VillagersCommand.java:80-81` | `POST {edenAdminUrl}/scenario/start {name,x,z}` with the player's position truncated to `int` (x, z); adds the returned roster to the op-on-join list. `name` must equal the scenario Eden booted with (else 404). |
| `/villagers restart <name>` | 2, player only | `VillagersCommand.java:99-100` | Same, `/scenario/restart` (wipes bot state). Retried on timeout although not idempotent. |
| `/villagers stop` | 2 | `VillagersCommand.java:94` | `POST /scenario/stop`. |

Details: [eden/java-integration.md](../eden/java-integration.md).

### Capture the Flag

CTF has **no commands** — it is purely event/tick driven. See [ctf/capture-the-flag.md](../ctf/capture-the-flag.md).

## Client commands (`src/client/`)

| Syntax | Source | Behaviour |
|---|---|---|
| `/build <text>` | `Screenshotter.java:60-66` | `StringArgumentType.string()` → one word or a `"quoted string"`. Captures the framebuffer after 1 s, sends `ImagePayload("Build : "+text)`. Server-side the image is **dropped** (`buildBot.hasImage=false`); only the text reaches the build agent. |
| `/prove <text>` | `Screenshotter.java:48-54` | **Broken:** `.executes` is attached to the `prove` literal, not to the argument, so `/prove x` is an incomplete command and bare `/prove` throws on `getString`. |

Details: [aigod/images-and-client.md](../aigod/images-and-client.md).

## Eden — CLI (run in `eden/`)

| Command | What it does |
|---|---|
| `npx tsx src/main.ts [eden.json]` | Real boot: `spawnBots:true`, `installProcessGuards:true`. `start.ps1` is exactly `npx tsx src/main.ts eden.json`. |
| `npm run check` | lint + `tsc --noEmit` + dependency-cruiser + tests. |
| `npm test` / `npm run test:coverage` | `node:test` via tsx, fakes only. **Fails on a clean checkout** while `eden/providers.json` (gitignored) is missing — `tests/live-tests-catalogue.test.ts` loads it. |
| `npm run lint` · `typecheck` · `depcruise` | Individual gates. |
| `npm run rebuild-stats [-- <dataDir>]` | Re-fold derived views from the journal. |
| `npm run eval` | **Dry run**: wipes `.eden-eval-data`, builds/validates 4 scenarios, logs the plan; connects to nothing. |
| `npm run live-test [-- <name>] [--provider <p>]` | Real server + real LLM scenarios, process-isolated. Not CI. |

Details: [eden/testing-eval-live.md](../eden/testing-eval-live.md), [eden/process-config-and-boot.md](../eden/process-config-and-boot.md).

## Eden — admin HTTP verbs (`127.0.0.1:8770`, no auth)

Mutating: `POST /pause`, `POST /resume`, `POST /skills/:name/quarantine`, `POST /villagers/:name/prompt`,
`POST /scenario/start`, `POST /scenario/restart` (body `{name,x,z}`), `POST /scenario/stop`.
Read-only: `GET /status`, `/kinds`, `/journal`, `/villagers`, `/villagers/:name`, `/skills`, `/skills/:name`, `/tasks`,
`/verdicts`, `/directives`, `/rollouts`, `/llm/:callId`; WebSocket `/journal/stream?kinds=…`.
Full contract: [eden/admin-api.md](../eden/admin-api.md).

## Related
- [reference/ports-files-config.md](ports-files-config.md)
- [00-overview.md](../00-overview.md)
- [VERIFICATION-NOTES.md](../VERIFICATION-NOTES.md)
