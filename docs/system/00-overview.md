---
id: overview
title: Paul's Brawls — system overview
system: meta
summary: Start here. The four gameplay systems, the three runtimes, how they connect, what is actually wired today vs only designed, and where to read next.
tags: [overview, architecture, runtimes, gibber, ctf, aigod, eden, map, wiring-status]
sources: [src/main/resources/fabric.mod.json, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/client/java/com/paul/brawl/ClientEntryPoint.java, eden/src/main.ts, build.gradle]
verified_at: 4a8081f
---

# Paul's Brawls — system overview

**TL;DR** — A Fabric mod for Minecraft **1.21.1** (Java 21, mod id `paulsbrawls`) plus a Node/TypeScript AI-village
brain (**Eden**) beside it. Four systems: **Gibber** (server-wide coin money), **Capture the Flag**, the **AI God**
(a LangChain4j `/pray` chatbot with a Mineflayer body and an LLM building agent) and **Eden** (ten LLM villagers + a
God that writes, judges and curates a shared skill library). Everything below was checked against the code at
commit `4a8081f`; where the code and older docs disagree, see [VERIFICATION-NOTES.md](VERIFICATION-NOTES.md).

## The systems at a glance

| System | Runtime | Entry | What it does | Doc |
|---|---|---|---|---|
| **Gibber** (money) | JVM mod | `GibCommand`, `RevenueManager`, `SalaryScheduler`, `Money` | A `paulsbrawls:coin` item; a global `total_revenue` everyone is entitled to; offline players receive their backlog on join; admin gifts + periodic salary. | [gibber/money-system.md](gibber/money-system.md) |
| **Capture the Flag** | JVM mod | `FlagManager` | A banner whose name contains `Flag` drops when its holder is hurt, disables elytra while carried, makes the holder glow. | [ctf/capture-the-flag.md](ctf/capture-the-flag.md) |
| **AI God** (`/pray`) | JVM mod + Node bridge | `ChatBot`, `ChatBotFunctions`, `GodBody`, `MCPGateway` | Per-player LLM conversation with tools (reward, trade, punish, weather, spawn, appear/vanish/wait, terrain query) + MCP tools from the Node bot; a French-speaking God ("Dieu : …"). | [aigod/overview.md](aigod/overview.md) |
| **AI God — building** | JVM mod (+ client) | `/construction`, `BuildSubAgent`, `buildBot` | An LLM build agent that emits `PlaceBlock` / `PlaceLine` / `PlaceBlocks` text, parsed and placed relative to an admin-set pivot. | [aigod/building.md](aigod/building.md) |
| **Eden** (AI village) | One Node process (`eden/`) | `eden/src/main.ts` | Villager bots (mineflayer) + a God with critic/curriculum/orchestrator desks; skills are JS functions in one versioned library; everything journaled to SQLite; admin API on :8770. | [eden/overview.md](eden/overview.md) |
| **Eden ↔ mod glue** | JVM mod | `VillageHttpListener`, `VillagersCommand`, op-on-join | `:8767` trade-settlement listener, `/villagers start|stop|restart`, op'ing bot names on join. | [eden/java-integration.md](eden/java-integration.md) |

## Runtimes and how they connect

```
             ┌──────────────────────── Minecraft 1.21.1 dedicated server (JVM) ─────────────────────────┐
 players ───►│ paulsbrawls mod: Gibber · CTF · AI God (ChatBot/LangChain4j) · :8767 settlement listener │
             └───▲────────────────────────▲──────────────────────────────▲───────────────▲────────────┘
                 │ game protocol          │ HTTP :8765 (bridge)          │ HTTP :8767    │ game protocol
                 │ (LLMBot avatar)        │ + MCP/SSE :8765/mcp/sse      │ (trade POST)  │ (villagers + Dieu)
        ┌────────┴────────────────────────┴───────┐               ┌──────┴───────────────┴───────────────┐
        │ minecraft-mcp-server "unified" (Node)   │               │ Eden (Node, eden/)                   │
        │ ⚠ EMPTY submodule in this checkout      │               │ bots · God · skills · journal (SQLite)│
        └─────────────────────────────────────────┘               │ admin HTTP/WS :8770  ◄── /villagers   │
                                                                  └───────────────────────────────────────┘
  LLM providers: Java God → OpenAI / LM Studio / Ollama / Anthropic (LangChain4j)
                 Eden     → OpenAI-compatible presets from eden/providers.json (eden.example.json picks "openai"; live tests default to "deepseek")
```

| Runtime | Path | Start | Status in this checkout |
|---|---|---|---|
| Fabric mod (JVM) | `src/` | `./gradlew build` / `runServer` (note: `gradlew` and `gradle/` are **gitignored**, so a clean clone has no wrapper) | Active. Server features load **only on a dedicated server** (`DedicatedServerModInitializer`). |
| Eden | `eden/` | `npx tsx src/main.ts eden.json` | Active. |
| Unified bridge + MCP | `minecraft-mcp-server/` | `npm run unified …` | A gitlink (mode 160000, commit `c0e56f2`) **with no `.gitmodules`** — the directory is empty, so its source cannot be verified here. Java-side contracts are documented from the Java client code. |
| v1 village brain | `minecraft-mcp-server/src/village/` | `npm run village` | Legacy; same absent submodule. Only reachable from Java via `/village status|pause|resume` (:8766). |

There are **two Gods**: the Java `/pray` God (avatar login `LLMBot`, chat prefix `Dieu : `) and Eden's village God
(avatar login `Dieu`). They are separate programs and never share a login.

## Mod wiring order (server)

`ServerEntryPoint.onInitializeServer` registers, in order: `GibCommand`, `RevenueManager`, `SalaryScheduler`,
`Money` (coin item), `FlagManager`, `ChatBot` (all God commands + tools), `GodActionQueue`, `GodScheduler`,
`VillageCommand`, `VillagersCommand`; then lifecycle hooks (`SERVER_STARTED` → start `:8767`; `SERVER_STOPPING` →
clear queue/session, stop listener) and the op-on-join hook (`LLMBot`, `Dieu`, active scenario bots). The client
entrypoint registers `Screenshotter` (`/prove`, `/build`) and `Money`. Full detail:
[platform/entrypoints-and-wiring.md](platform/entrypoints-and-wiring.md).

## Designed vs actually wired (read before relying on a feature)

The older design docs (`docs/*.md`, `CLAUDE.md`) describe several features that exist as tested classes but are **not
constructed or not called** by the production composition root. Agents should treat these as *not live*:

| Feature | Reality in code | Where |
|---|---|---|
| Eden trade settlement → `:8767` | `SettlementClient` is built then discarded; `TradeService`/`Conversation` never constructed; and the JSON shapes **don't match** (Eden sends `{from,to,give,want}`, Java requires `{botA,botB,aGives,bGives}` → HTTP 400). | [eden/social-and-trade.md](eden/social-and-trade.md) |
| Villager social tools (`say`, `tell`, trade…) | Not in the 11-tool registry. | [eden/villager-runtime.md](eden/villager-runtime.md) |
| Most villager events (chat, entity-spotted, night-falls, new-day, inbox…) | The live signal bus forwards only health/death/hurt; plus a 30 s tick. Half of `roles.json` is inert. | [eden/villager-runtime.md](eden/villager-runtime.md) |
| God body delivering verdicts, divine interventions | `GodBody` instance discarded; `intervene` never called. | [eden/god.md](eden/god.md) |
| Critic tripwire tickets, description pass, anchors, drives, `combineDesks`, daily-cap reset, D-09 recovery | Unwired / no-op in production. | [eden/god.md](eden/god.md), [eden/skills-library.md](eden/skills-library.md) |
| CI workflows (`ci.yml`, `eden-ci.yml`) | `.github/` is gitignored and absent from history. | [platform/build-and-runtime.md](platform/build-and-runtime.md) |
| Client `/prove` | Mis-wired command tree; cannot execute. | [aigod/images-and-client.md](aigod/images-and-client.md) |

What **is** live in Eden: the bot pool, stock skills, the skill engine with its watchdogs, villager deliberation with
the 11 tools, subscriptions → reflex skills / deliberation on the events that do fire, the curriculum (idle trigger) →
orchestrator directive → villager rollout → critic verdict → library admission loop, the journal, derived views, and
the admin API.

## How to navigate this corpus

- Every document has YAML frontmatter (`id`, `system`, `summary`, `tags`, `sources`) and is listed in
  [index.json](index.json). See [README.md](README.md) for reading paths and the MCP serving model.
- Cross-cutting lookups: [reference/commands.md](reference/commands.md), [reference/ports-files-config.md](reference/ports-files-config.md).
- Code citations are `path:line` at commit `4a8081f` — re-check after code changes.

## Related
- [README.md](README.md) · [VERIFICATION-NOTES.md](VERIFICATION-NOTES.md)
- [platform/build-and-runtime.md](platform/build-and-runtime.md) · [platform/entrypoints-and-wiring.md](platform/entrypoints-and-wiring.md)
- [gibber/money-system.md](gibber/money-system.md) · [ctf/capture-the-flag.md](ctf/capture-the-flag.md)
- [aigod/overview.md](aigod/overview.md) · [aigod/building.md](aigod/building.md)
- [eden/overview.md](eden/overview.md) · [eden/java-integration.md](eden/java-integration.md)
