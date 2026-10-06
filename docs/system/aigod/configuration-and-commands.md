---
id: aigod.configuration-and-commands
title: AI God — LLMConfig, llm_config.properties, /llm, /pray, /prompt and prompt.txt
system: aigod
summary: LLMConfig fields, llm_config.properties keys, env vars, every AI God command (/llm, /llm bridge, /pray, /accept, /prompt, /godbody, /block, /construction), prompt.txt loading.
tags: [aigod, config, llmconfig, llm_config.properties, env, openai_api_key, commands, llm, pray, prompt, godbody, accept, prompt.txt, permissions]
sources: [src/main/java/com/paul/brawl/LLMConfig.java, src/main/java/com/paul/brawl/LLMCommand.java, src/main/java/com/paul/brawl/ChatCommand.java, src/main/java/com/paul/brawl/ChatBot.java, src/main/java/com/paul/brawl/ChatBotActions.java, src/main/java/com/paul/brawl/TradeOffers.java, src/main/java/com/paul/brawl/BridgeConfig.java, src/main/java/com/paul/brawl/MCPCommand.java, src/main/java/com/paul/brawl/Prompts.java, src/main/java/com/paul/brawl/BuildGuard.java, prompt.txt, build_prompt.txt, build.gradle]
verified_at: 98cb908
---

# AI God — configuration and commands

**TL;DR.** LLM settings live in the `LLMConfig.INSTANCE` singleton, loaded at class init from `llm_config.properties`
in the server cwd and rewritten in full on every `/llm` change. Four providers: `openai` (default, `gpt-5`),
`lmstudio`, `ollama`, `anthropic`. API keys: config value wins, else `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. All admin
commands are perm 2; `/pray`, `/pray stop`, `/accept` are perm 0. The persona is read from `prompt.txt` in the cwd
(no bundled fallback) and re-read by `/prompt`.

## LLMConfig (`src/main/java/com/paul/brawl/LLMConfig.java`)

### Fields

| Field | Type | Default | Line |
|---|---|---|---|
| `CONFIG_PATH` | `Path` | `llm_config.properties` (relative → server cwd) | `:29` |
| `providers` | `LinkedHashMap<String, ProviderSettings>` | 4 entries below | `:51`, `:70-73` |
| `activeProvider` | `String` | `"openai"` | `:52` |
| `timeoutSeconds` | `int` | `180` | `:64` |
| `sharedModel` | cached `ChatModel` | lazily built; reset by `invalidateClient()` | `:66`, `:130-133`, `:166-168` |
| `sharedExecutor` | `ExecutorService` | virtual-thread-per-task, names `llm-worker-1…` | `:67`, `:155-163` |

`ProviderSettings` (`:33-49`): `host`, `port`, `model`, `apiKey`; `baseUrl() = host + ":" + port + "/v1"`.

| Provider key | host | port | model | apiKey default |
|---|---|---|---|---|
| `openai` | `https://api.openai.com` | `443` | `gpt-5` | `""` (→ env) |
| `lmstudio` | `http://localhost` | `1234` | `openai/gpt-oss-20b` | `lm-studio` |
| `ollama` | `http://localhost` | `11434` | `llama3.2` | `ollama` |
| `anthropic` | `https://api.anthropic.com` | `443` | `claude-opus-4-8` | `""` (→ env) |

Anthropic uses `AnthropicChatModel` and ignores host/port (dependency `langchain4j-anthropic:1.0.0-beta5`,
`build.gradle:49`, `:57`). Builder details: [llm-pipeline.md](llm-pipeline.md) (section "Provider construction").

### Environment variables

| Var | Used when | Line |
|---|---|---|
| `OPENAI_API_KEY` | provider `openai` and its configured `apikey` is empty | `:172-175` |
| `ANTHROPIC_API_KEY` | provider `anthropic` and configured `apikey` empty | `:176-179` |
| `OPENAI_ORG_ID` | provider `openai`, non-empty → `.organizationId(...)` | `:116-117` |
| `OPENAI_PROJECT_ID` | provider `openai`, non-empty → `.projectId(...)` | `:118-119` |

Fallback when no key is found: the provider name itself (e.g. `"openai"`) is sent as the key (`:180-181`) — a real
OpenAI/Anthropic call then fails with an auth error that only shows in the server log.

### `llm_config.properties` format

Written by `save()` (`:184-201`) with header comment `LLM provider configuration`; read by `load()` (`:203-232`) once,
from the private constructor (`:74`).

| Key | Meaning |
|---|---|
| `active` | active provider key (ignored on load if not one of the 4) |
| `timeout_seconds` | int seconds |
| `<provider>.host` | e.g. `openai.host` |
| `<provider>.port` | int |
| `<provider>.model` | model name |
| `<provider>.apikey` | API key in **plaintext** (`""` = use env) |

Rules: a missing file means pure defaults (no file is created until the first `/llm` change); unparsable ints are
ignored; unknown keys are ignored; providers cannot be added via the file (only the 4 built-ins are read). `save()`
writes all 4 providers every time.

## `/llm` (`src/main/java/com/paul/brawl/LLMCommand.java`)

Root `requires(hasPermissionLevel(2))` (`:24-25`) — every subcommand is perm 2.

| Syntax | Lines | Effect | Persists | Rebuilds client + wipes all memories (`ChatBot.reloadClients`) |
|---|---|---|---|---|
| `/llm` | `:26-29` | Print status | — | no |
| `/llm provider <name>` (`word`, suggests the 4 keys) | `:30-40`, `:179-188` | Switch active provider; unknown → error `Unknown provider: <name>. Available: [openai, lmstudio, ollama, anthropic]` | yes | **yes** |
| `/llm model <name…>` (greedy) | `:41-45`, `:190-196` | Set model of active provider | yes | **no** (see gotchas) |
| `/llm host <host…>` (greedy) | `:46-50`, `:198-205` | Set host of active provider (include scheme, e.g. `http://192.168.1.5`) | yes | yes |
| `/llm port <1..65535>` | `:51-55`, `:207-214` | Set port of active provider | yes | yes |
| `/llm apikey <key…>` (greedy) | `:56-60`, `:216-223` | Set key of active provider; replies `API key updated for <provider>` | yes (plaintext) | yes |
| `/llm timeout <5..1800>` | `:61-65`, `:225-233` | Set `timeoutSeconds` | yes | yes |
| `/llm reload` | `:66-72` | `ChatBot.reloadClients()` + status | — | yes |

`ChatBot.reloadClients()` (`ChatBot.java:178-192`): `LLMConfig.invalidateClient()`, then for both bots cancel all Wait
deferrals and clear `memories`, `functionCallDepth`, `sessionBound`. It does not touch the avatar session lock.

Status output (`printStatus`, `:235-253`):

```
LLM active provider: <key> | timeout=<n>s
* openai -> https://api.openai.com:443/v1 | model=gpt-5 | apikey=<env>
  lmstudio -> http://localhost:1234/v1 | model=openai/gpt-oss-20b | apikey=<set>
  ...
Active baseUrl: <url>
```

`apikey=<env>` means the configured key is empty; `<set>` means non-empty (the default local keys show `<set>`).

### `/llm bridge …` subtree (syntax only — semantics in [god-body.md](god-body.md))

All perm 2, all persist to `bridge_config.properties` via `BridgeConfig.save()` and then print `BridgeConfig.describe()`.

| Syntax | Lines | Field (default) | Validation |
|---|---|---|---|
| `/llm bridge` | `:73-77` | print status | — |
| `/llm bridge enabled <true\|false>` | `:78-82`, `:118-123` | `enabled` (`true`) | Brigadier bool |
| `/llm bridge url <url…>` | `:83-87`, `:125-130` | `bridgeUrl` (`http://127.0.0.1:8765`) | greedy string |
| `/llm bridge bot <name>` | `:88-92`, `:132-137` | `botUsername` (`LLMBot`) | single word |
| `/llm bridge griefing <true\|false>` | `:93-97`, `:139-144` | `creatureGriefingAllowed` (`false`) | bool |
| `/llm bridge waitmax <1..600>` | `:98-102`, `:146-155` | `waitMaxSeconds` (`30`) | if `idleTimeoutSeconds <= seconds`, bumps idle to `seconds + 30` |
| `/llm bridge spawnmax <1..64>` | `:103-107`, `:157-162` | `spawnCountMax` (`8`) | int range |
| `/llm bridge idle <5..3600>` | `:108-112`, `:164-173` | `idleTimeoutSeconds` (`90`) | must be `> waitMaxSeconds`, else error `idle timeout must exceed waitMax (<n>s)` |

Status line format: `BridgeConfig{enabled=…, url=…, bot=…, appear=[1.0..6.0], h=[0.0..4.0], wait=[1..30s], spawnMax=8, rewardMax=64, punishMax=3, spawnOffsetMax=16, griefing=false, idle=90s}`
(`BridgeConfig.java:151-164`). The bug #6 clamps `rewardMax`, `punishmentMax` and `spawnOffsetMax` have **no** `/llm bridge`
subcommand: they are set only by editing `bridge_config.properties` (keys of the same names) and restarting.

## Prayer and trade commands

### `/pray` (`ChatCommand.java:25-51`)

| Syntax | Perm | Behaviour |
|---|---|---|
| `/pray <text…>` (`MessageArgumentType.message()`, greedy) | 0 | `onChatCommand` (`:91-113`): private echo `<name> : <text>`; `GodSessionManager.claim(player)`; if not owned, private `Dieu : (occupé ailleurs — je t'écoute, mais sans forme.)`; then `ChatBot.godBot.sendChatRequest(text, player)`. Exceptions are logged, not shown. |
| `/pray reset` | 0 | Forgets the caller's conversation: `ExternalAgent.resetGod` with `godAgent = external` (the next prayer opens a fresh opencode session), else `ChatBot.godBot.clearMemory`. Private `Dieu : (je t'oublie. Prie à nouveau.)`. |
| `/pray stop` | 0 | If the caller owns the avatar session: `ChatBot.endPrayerSession(player)` + private `Dieu : (la séance est close.)`. Otherwise silently does nothing. Does not clear memory or cancel an in-flight LLM call (its response is then dropped by the session-ended check). |

Note `/pray stop` and `/pray reset` are literal branches: praying the single word "stop" or "reset" is impossible.

With `godAgent = external` (`god_agent.properties`), `onChatCommand` hands the prayer to `ExternalAgent.pray`
instead of `godBot`, and a busy avatar is a refusal rather than a bodiless answer. See
[external-agent.md](external-agent.md).

### `/accept` (`TradeOffers.java:116-126`)

`/accept` — no `requires` → perm 0. Executes the caller's pending trade. Details:
[actions-and-trades.md](actions-and-trades.md) (section "Trades").

### `/godbody` (`ChatCommand.java:57-89`)

| Syntax | Perm | Behaviour (semantics: [god-body.md](god-body.md)) |
|---|---|---|
| `/godbody off` | 2 | `GodActionQueue.clear()`, `ChatBotActions.restoreAvatarOnMain(server)`, `BuildGuard.cancelAll()` (bug #7 — running sub-builds stop at their next turn), `GodBody.vanish()`, `GodSessionManager.forceEndSession()`, `BridgeConfig.enabled=false` + save; broadcast-to-ops feedback `Killed god-body: <n> queued action(s) dropped, session released, bridge disabled.` |
| `/godbody on` | 2 | `BridgeConfig.enabled=true` + save; feedback `Bridge re-enabled.` |

`/godbody off` restores avatar invulnerability directly (bug #5) but does not clear chat memory.

## Prompt and build-debug commands

| Syntax | Perm | Lines | Behaviour |
|---|---|---|---|
| `/prompt` | 2 | `ChatCommand.java:140-152` | Re-reads `prompt.txt` and `build_prompt.txt` (`readPrompt()` on both bots) and sends the caller `Hardcoded prompt : <godBot file text>\nCustom Prompt : <override>`. |
| `/prompt <text…>` | 2 | `ChatCommand.java:116-138` | Sets the runtime override `prompt` on **both** `godBot` and `buildBot` (RAM only, appended after the file text with `"\n"`); replies `Changed prompt <text>`. There is no command to clear it except setting it to something else or restarting. |
| `/block <x> <y> <z>` | 2 | `ChatBotActions.java:172-188` | Places `minecraft:stone` at the `/construction` pivot + offset. See [building.md](building.md). |
| `/construction` | 2 | `ChatBotActions.java:190-204` | Sets the build pivot by raycast and clears the caller's `buildBot` memory. See [building.md](building.md). |

Both `/prompt` forms reply through `getSource().sendFeedback(…)`, so they work from the console (bug #18; they used to
call `getSource().getPlayer()` and NPE). `/block` and `/construction` use `getPlayerOrThrow()` (bug #18): still
player-only, but the console now gets a readable error instead of an NPE.

Related commands documented elsewhere: `/mcp`, `/mcp status` (perm 0), `/mcp reload` (perm 2) (`MCPCommand.java:32-57`; since bug #18 `reload` runs on the LLM worker pool, replies
`MCP: rechargement en cours…` at once and prints the status when done) → [mcp-gateway.md](mcp-gateway.md); client `/prove`, `/build` → [images-and-client.md](images-and-client.md).

## prompt.txt loading

- Path: `ChatBot.godBot = new ChatBot("prompt.txt")`, `buildBot = new ChatBot("build_prompt.txt")`
  (`ChatBot.java:132-133`) — relative paths, resolved against the **JVM working directory** (production: the
  `PaulsBrawlsVanilla` server dir; dev: `run/`). Not bundled in the jar.
- `readPrompt()` (`ChatBot.java:638-644`): `hardcodedPrompt = Files.readString(Path.of(promptPath))`; on `IOException`
  prints the stack trace and keeps the previous value — `""` at startup. **No fallback prompt**: a missing file means
  an empty persona.
- Read once in the constructor and on every `/prompt` (no-arg). Also used verbatim as the sub-agent system prompt base
  by `BuildPlan` (`ChatBotFunctions.java:234-235`).
- Sent each turn as `SystemMessage(hardcodedPrompt + "\n" + prompt)` (`ChatBot.java:453`).
- `Prompts.buildPrompt` / `Prompts.proofPrompt` (`Prompts.java:4-5`) are empty, unused statics.

### `prompt.txt` content (repo copy, 54 lines, French)

| Lines | Section | Gist |
|---|---|---|
| 1-35 | Persona | You play God in Minecraft; punish disrespect with `Punishment` ("Sois sévère"); give quests in categories with 4 difficulty levels; verify completion **only with a single image proof**; reward with `Reward` (e.g. `minecraft:diamond`), never twice for the same quest nor for quests you did not give; no punishment together with rewards; several rewards = several calls; **always write plain text explaining any function call**; don't let players dictate rewards; ancient, enigmatic, majestic, omniscient, unpredictable, sometimes cruel tone. |
| 37-39 | `# Ton corps` | You have one shared physical avatar; manifest only when you choose; one player at a time; others get bodiless replies; invulnerability is automatic. |
| 41-46 | `## Les nouveaux outils` | `Appear({distance?, height?, lookAtPlayer?})` (sparingly — trivial prayers answered in text only), `Vanish()` (optional), `Wait({seconds})` (1 à 30), `SpawnCreature({entityType, count, x, y, z})` (rarely; server-capped). |
| 48-50 | `## Parler tout haut` | When manifested your words also go to public chat; bodiless replies are private. |
| 52-54 | `## Mise en scène recommandée` | Suggested chain `Appear` → `Wait(2)` → speak → `Wait(3)` → strike (`Punishment`/`Reward`/`SpawnCreature`) → `Vanish` or empty turn; gestures accompany each power automatically. |

The prompt does not mention `Trade`, `ChangeWeather`, `QueryTerrain`, `ListTools`, or the MCP (Mineflayer) tools — the
model learns those only from the tool specs. `build_prompt.txt` (114 lines, English, "You are Dieu, the master builder
of Minecraft…") is covered in [building.md](building.md).

## Persisted files summary (AI God)

| File (server cwd) | Owner | Written by |
|---|---|---|
| `llm_config.properties` | `LLMConfig` | any `/llm` setter |
| `bridge_config.properties` | `BridgeConfig` | `/llm bridge …`, `/godbody on|off` |
| `mcp_config.properties` | `MCPConfig` | see [mcp-gateway.md](mcp-gateway.md) |
| `prompt.txt`, `build_prompt.txt` | `ChatBot` | never (read-only, hand-edited) |
| `proof_screen.png` | `ImageReceiver.saveImage` | never (call commented out) |

## Gotchas & known issues

- **`/llm model` is not applied until a reload**: `setModel` saves but does not call `ChatBot.reloadClients()`, so the
  cached `ChatModel` keeps the old model name. Run `/llm reload` after it.
- Every other `/llm` setter wipes **all players' memories** for both bots (and cancels pending Waits) as a side effect.
- API keys set via `/llm apikey` are stored in plaintext in `llm_config.properties` and take precedence over env vars.
- `/llm` applies to the *active* provider only; to configure another provider, switch to it first.
- The root README lists three providers (line 18); the code also ships `anthropic` (CLAUDE.md now lists all four).
- `/pray` responses in English/other languages are possible — the French persona lives only in `prompt.txt`; a missing
  file silently yields an un-personified assistant.

## Related

- [llm-pipeline.md](llm-pipeline.md) · [overview.md](overview.md) · [god-body.md](god-body.md) · [mcp-gateway.md](mcp-gateway.md)
- [actions-and-trades.md](actions-and-trades.md) · [building.md](building.md) · [images-and-client.md](images-and-client.md)
- [../reference/commands.md](../reference/commands.md) · [../reference/ports-files-config.md](../reference/ports-files-config.md)
