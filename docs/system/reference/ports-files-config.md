---
id: reference.ports-files-config
title: Ports, persisted files, config keys and environment variables
system: meta
summary: Registry of every port, runtime file (with keys/defaults), NBT store and env var used by the Fabric mod and Eden — where each lives and who reads/writes it.
tags: [ports, config, properties, env, files, persistence, nbt, eden.json, providers.json, gitignore, rcon]
sources: [src/main/java/com/paul/brawl/GodAgentConfig.java, src/main/java/com/paul/brawl/BridgeConfig.java, src/main/java/com/paul/brawl/LLMConfig.java, src/main/java/com/paul/brawl/MCPConfig.java, src/main/java/com/paul/brawl/VillageConfig.java, src/main/java/com/paul/brawl/PlayerPersistentState.java, src/main/java/com/paul/brawl/ChatBot.java, run/server.properties, eden/src/config.ts, eden/eden.example.json, eden/providers.example.json, eden/.gitignore, .gitignore, eden/src/main.ts, eden/src/journal/journal.ts, eden/src/llm/client.ts, eden/eval/roster.ts]
verified_at: 98cb908
---

# Ports, files, config & environment

**TL;DR** — Two processes hold ports you control: the JVM (Minecraft + the `:8767` settlement listener, and with
`godAgent = external` the `:8771` MCP servers) and Eden (`:8770` admin). A third, the Node **unified bridge** (`:8765`, source not in this checkout), serves the Java AI-God's
avatar and MCP tools. All Java runtime config is `*.properties` in the **JVM working directory** (production
`PaulsBrawlsVanilla\`, dev `run/`); Eden config is `eden/eden.json` + `eden/providers.json` + `eden/api-keys.env`, and
Eden state is `eden/.eden-data/`. Every login name across systems must be unique (Minecraft kicks a duplicate).

## Ports

| Port | Bound by | Bind addr | Purpose | Source |
|---|---|---|---|---|
| 25599 | Minecraft (dev server, `run/`) | — | Game port in the tracked `run/server.properties` (`server-port=25599`); Eden's default `minecraft.port` | `run/server.properties:53`, `eden/src/config.ts:90` |
| 25565 | Minecraft (production `PaulsBrawlsVanilla`) | — | Vanilla default; also `query.port` in `run/server.properties`; Eden eval roster | `eden/eval/roster.ts:54` |
| 25575 | Minecraft RCON | — | `enable-rcon=true`, used by the live-test harness. **The RCON password is committed in plain text** in `run/server.properties:44`. | `run/server.properties:13,44-45` |
| 8765 | Node unified bridge (`minecraft-mcp-server`, ⚠ source absent) | 127.0.0.1 | Java God avatar bridge HTTP + MCP-over-SSE at `/mcp/sse` | `BridgeConfig.java:30`, `MCPConfig.java:60` |
| 8766 | Legacy v1 Node village admin (⚠ source absent) | 127.0.0.1 | Target of `/village status|pause|resume` | `VillageConfig.java:47` |
| **8767** | JVM — `VillageHttpListener` | 127.0.0.1 | `POST /trade/execute` atomic item swap between two online players. No auth unless `settlementToken` is set. | `VillageConfig.java:31` |
| **8771** | JVM — `AgentMcpServers` (only with `godAgent = external`) | 127.0.0.1 | MCP servers for the external God agent: `/mcp/god`, `/mcp/builder` (Streamable HTTP, stateless). Bearer token required. See [aigod/mcp-servers.md](../aigod/mcp-servers.md). | `GodAgentConfig.java:43` |
| **8770** | Eden admin server | 127.0.0.1 | REST + WebSocket journal stream + static website. No auth. Target of `/villagers …`. | `VillageConfig.java:53`, `eden/src/config.ts:131` |
| 1234 / 11434 | LM Studio / Ollama (external) | localhost | Optional local LLM providers for the Java God | `LLMConfig.java:71-72` |
| 8088 / 8791 | `.claude/launch.json` dev helpers | — | docs static server / Eden dashboard preview (tooling only) | `.claude/launch.json` |

> `./gradlew runServer` also starts the mod's `:8767` listener, so a dev server and the production server on one machine
> fight over 8767 (first to bind wins).

## Java mod — files in the JVM working directory

All are plain `java.util.Properties`, read once when the singleton class initialises (no hot reload except where noted).

### `llm_config.properties` — `LLMConfig` (gitignored as `run/llm_config.properties`)

| Key | Default | Notes |
|---|---|---|
| `active` | `openai` | `openai` \| `lmstudio` \| `ollama` \| `anthropic` |
| `timeout_seconds` | `180` | 5–1800 via `/llm timeout` |
| `openai.{host,port,model,apikey}` | `https://api.openai.com`, `443`, `gpt-5`, `""` | |
| `lmstudio.{…}` | `http://localhost`, `1234`, `openai/gpt-oss-20b`, `lm-studio` | |
| `ollama.{…}` | `http://localhost`, `11434`, `llama3.2`, `ollama` | |
| `anthropic.{…}` | `https://api.anthropic.com`, `443`, `claude-opus-4-8`, `""` | host/port ignored by the Anthropic builder |

API keys are stored **in plaintext**. A non-empty configured key wins over the env var. Source: `LLMConfig.java:69-73,184-231`.

### `bridge_config.properties` — `BridgeConfig` (written only on save, never created at boot)

| Key | Default | Key | Default |
|---|---|---|---|
| `bridgeUrl` | `http://127.0.0.1:8765` | `enabled` | `true` |
| `botUsername` | `LLMBot` | `parkingX/Y/Z` | `0` / `-64` / `0` |
| `appearMinDistance` / `appearMaxDistance` | `1` / `6` | `appearMinHeight` / `appearMaxHeight` | `0` / `4` |
| `waitMinSeconds` / `waitMaxSeconds` | `1` / `30` | `spawnCountMax` | `8` |
| `creatureGriefingAllowed` | `false` | `idleTimeoutSeconds` | `90` |
| `rewardMax` | `64` | `punishmentMax` | `3` |
| `spawnOffsetMax` | `16` | | |

Source: `BridgeConfig.java` (fields + `load`/`save`). `rewardMax`, `punishmentMax`, `spawnOffsetMax` (bug #6) have no
`/llm bridge` subcommand; edit the file and restart. Semantics: [aigod/god-body.md](../aigod/god-body.md).

### `mcp_config.properties` — `MCPConfig` (created with defaults on first load; `run/` copy is tracked)

| Key | Default |
|---|---|
| `enabled` | `true` |
| `sse_url` | `http://127.0.0.1:8765/mcp/sse` |
| `timeout_seconds` | `60` |

Obsolete keys dropped on load, with one warning and a rewrite of the file: `node_binary`, `mcp_server_script`,
`mc_host`, `mc_port`, `mc_username`. Source: `MCPConfig.java:46-120`. See [aigod/mcp-gateway.md](../aigod/mcp-gateway.md).

### `village_config.properties` — `VillageConfig`

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | settlement listener on/off (`/village on|off` persists it) |
| `listenerPort` | `8767` | |
| `maxTradeDistance` | `16.0` | max blocks between settlement parties (same dimension required); `<= 0` disables |
| `settlementToken` | `""` | if set, `/trade/execute` requires it in `X-Village-Token` (else 401) |
| `nodeAdminUrl` | `http://127.0.0.1:8766` | legacy v1 admin |
| `edenAvatarName` | `Dieu` | op'd on join |
| `edenAdminUrl` | `http://127.0.0.1:8770` | used by `/villagers` |

Source: `VillageConfig.java:23-88`. Eden's side mirrors `maxTradeDistance` as `settlement.maxTradeDistance` (default 16) and walks the accepting villager to within `settlement.reach` (default 8, must be `> 0` and `<` maxTradeDistance) before settling (`eden/src/config.ts:130,326-337`). See [eden/java-integration.md](../eden/java-integration.md).

### `god_agent.properties` — `GodAgentConfig` (docs/27; written on save or when a token is generated)

| Key | Default | Notes |
|---|---|---|
| `godAgent` | `builtin` | `builtin` = the in-mod ChatBot; `external` = start the MCP servers and hand prayers/builds to the external agent |
| `mcpPort` | `8771` | loopback port of `/mcp/god` + `/mcp/builder` |
| `mcpToken` | `""` | bearer token; `PAULSBRAWLS_MCP_TOKEN` wins. Blank and no env var → generated (32 random bytes) and saved at start in external mode |
| `agentUrl` | `http://127.0.0.1:4096` | opencode server |
| `agentUsername` / `agentPassword` | `opencode` / `""` | opencode Basic auth; `OPENCODE_SERVER_PASSWORD` wins |
| `godAgentName` / `builderAgentName` | `god` / `builder` | opencode agent names |
| `turnTimeoutSeconds` | `300` | cap on one agent turn |
| `ticketTtlSeconds` | `1800` | lifetime of a ticket handed to the agent |
| `subBuildIdleSeconds` | `120` | an idle sub-build lease is closed and its slot released |

Source: `GodAgentConfig.java`.

### Prompt files

| File | Read by | Notes |
|---|---|---|
| `prompt.txt` | `ChatBot.godBot` (`ChatBot.java:132`) | System persona of the Java God. No fallback if missing. `run/prompt.txt` is a dev stub. |
| `build_prompt.txt` | `ChatBot.buildBot` (`ChatBot.java:133`) | Build-agent grammar prompt. The repo-root and `run/` copies differ. |
| `run/max_build_prompt.txt` | nothing | never loaded |

Re-read by bare `/prompt`.

### World save — Gibber state

`<world>/data/gibbers_state.dat` — `PersistentState` id `gibbers_state`; NBT compounds `player_data` (UUID → coins
already paid) and `global_data` (`total_revenue`, `salary_per_day`, `salary_period`). See
[gibber/money-system.md](../gibber/money-system.md).

## Eden — files under `eden/`

| Path | Tracked? | Contents |
|---|---|---|
| `eden.example.json` → `eden.json` | example tracked, real gitignored | JSONC host config — every key in [eden/process-config-and-boot.md](../eden/process-config-and-boot.md) |
| `providers.example.json` → `providers.json` | real gitignored | Named presets `{strong, fast, apiKeyEnv}` (example: `deepseek`, `openai`, `local`). Selected by top-level `provider` in eden.json. Needed by a real boot with a `provider` and by `npm run live-test`; `npm test` reads the committed example instead. |
| `api-keys.example.env` → `api-keys.env` | real gitignored | `KEY=value` lines, loaded at boot when eden.json names a `provider` (`eden/src/main.ts:125-129`); an already-set env var wins |
| `roles.json` | tracked | Role → default subscriptions (JSONC) |
| `scenarios/*.json` | tracked | `farm`, `farming-hamlet`, `mining-crew`, `trading-post` |
| `ecosystem.config.cjs` | gitignored, absent | pm2 config (not verifiable here) |
| `.eden-data/eden.db` | gitignored | SQLite (WAL) — tables `journal` and `snapshots` (`eden/src/journal/journal.ts:51,68`) |
| `.eden-data/world.json` | gitignored | `{worldId:"host:port", stampedAt}` |
| `.eden-data/library/<skill>/skill.json`, `v<N>.js` | gitignored | Skill manifests (all versions) + code |
| `.eden-data/bots/<name>.json` | gitignored | `memory` (window/archive/relations/lifeSummary/worldId) + `anchors` |
| `.eden-data/subscriptions/<villager>.json` | gitignored | Subscription array |
| `.eden-data/llm/<callId>.json` | gitignored | `{request,response}` transcripts, only with `journal.debugPrompts:true` |
| `.eden-eval-data/` | gitignored | `npm run eval` scratch |
| `live-tests/.runs/<scenario>-<ts>/` | gitignored | Per-run evidence: `eden.json`, `.eden-data`, `journal-report.txt`, `result.json` |

Eden's SQLite file `eden.db` holds the journal and (B3.9) a `snapshots` table with God's working state (ledger,
directives, dossiers, rollouts, QA cache), restored at boot. See [eden/journal-and-views.md](../eden/journal-and-views.md).

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `OPENAI_API_KEY` | Java `LLMConfig.java:173`; Eden `LlmClient` default (`eden/src/llm/client.ts:224`) | Java: used when `openai.apikey` is empty (if neither, the provider *name* is sent as key). Eden: sent only to non-local base URLs; a real boot never falls back to it when the preset names another `apiKeyEnv` (R56). |
| `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` | Java `LLMConfig.java:116-118` | Optional OpenAI headers |
| `ANTHROPIC_API_KEY` | Java `LLMConfig.java:177` | Anthropic provider key fallback |
| `<preset>.apiKeyEnv` (e.g. `DEEPSEEK_API_KEY`) | Eden boot | **Required** when the chosen preset names one; boot throws (R56) without it (`eden/src/main.ts:564-571`) |
| `PAULSBRAWLS_MCP_TOKEN` | Java `GodAgentConfig.effectiveToken` | Bearer token of the `:8771` MCP servers (overrides `mcpToken`); the external agent sends the same value |
| `EDEN_LIVE_RUNDIR`, `EDEN_LIVE_PROVIDER` | Eden live-test child process | Set by the parent harness |
| `EDEN_SETTLEMENT_TOKEN` | Eden boot (`eden/src/main.ts:642`) | Sent as `X-Village-Token` on every `:8767` settlement POST. Must equal the mod's `settlementToken` in `village_config.properties` when that is set; unset/empty → no header (the mod's default). Can live in `api-keys.env` (loaded at boot when eden.json names a `provider`). |

## Login names (must be pairwise distinct)

| Name | Who | Op'd on join? |
|---|---|---|
| `LLMBot` (`BridgeConfig.botUsername`) | Java AI-God avatar (Node unified bridge) | yes |
| `Dieu` (`VillageConfig.edenAvatarName` / eden `god.name`) | Eden God avatar | yes |
| Scenario roster names | Eden villagers | yes, once `/villagers start|restart` returned them |
| `EvalBot*` | Eden eval harness | no |

Op-on-join matches by **username only** — on an offline-mode server anyone can claim these names.

## Related
- [reference/commands.md](commands.md)
- [00-overview.md](../00-overview.md)
- [platform/build-and-runtime.md](../platform/build-and-runtime.md)
- [VERIFICATION-NOTES.md](../VERIFICATION-NOTES.md)
