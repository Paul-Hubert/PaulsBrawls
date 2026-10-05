---
id: overview
title: Paul's Brawls — system overview
system: meta
summary: Start here. The four gameplay systems, the three runtimes, how they connect, what is actually wired today vs only designed, and where to read next.
tags: [overview, architecture, runtimes, gibber, ctf, aigod, eden, map, wiring-status]
sources: [src/main/resources/fabric.mod.json, src/main/java/com/paul/brawl/ServerEntryPoint.java, src/client/java/com/paul/brawl/ClientEntryPoint.java, eden/src/main.ts, build.gradle, eden/src/config.ts, eden/src/villagers/tools.ts, eden/src/villagers/brain.ts, eden/src/llm/scheduler.ts]
verified_at: 98cb908
---

# Paul's Brawls — system overview

**TL;DR** — A Fabric mod for Minecraft **1.21.1** (Java 21, mod id `paulsbrawls`) plus a Node/TypeScript AI-village
brain (**Eden**) beside it. Four systems: **Gibber** (server-wide coin money), **Capture the Flag**, the **AI God**
(a LangChain4j `/pray` chatbot with a Mineflayer body and an LLM building agent) and **Eden** (ten LLM villagers + a
God that writes, judges and curates a shared skill library). Everything below was checked against the code at
commit `98cb908`; where the code and older docs disagree, see [VERIFICATION-NOTES.md](VERIFICATION-NOTES.md).

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
clear the action queue, restore the avatar's
`Invulnerable` flag, cancel sub-builds, force-end the session, stop the listener) and the op-on-join hook (`LLMBot`, `Dieu`, active scenario bots). The client
entrypoint registers `Screenshotter` (`/prove`, `/build`) and `Money`. Full detail:
[platform/entrypoints-and-wiring.md](platform/entrypoints-and-wiring.md).

## Designed vs actually wired (read before relying on a feature)

The older design docs (`docs/*.md`) describe a few features that exist as code but are **not constructed or not
called** by the production composition root (`eden/src/main.ts`). Most of what was unwired at `4a8081f` (speech
tools, the reactivity signals, the God body, tripwire, describer, anchors, drives, D-09 recovery) has since been
wired. Agents should treat the remaining rows as *not live*:

| Feature | Reality in code | Where |
|---|---|---|
| `god.authoring`, `god.gamemode` | Parsed (`eden/src/config.ts:263-267`), read nowhere else in `eden/src/`. `combineDesks` was **removed** (D-19). | [eden/god.md](eden/god.md) |
| Curriculum triggers other than `idle` | The only production caller of the curriculum is the idle loop (`eden/src/main.ts:1483`, `trigger: 'idle'`); dawn/decompose never fire. | [eden/god.md](eden/god.md) |
| Daily token-cap reset | `BudgetTracker.resetDay()` (`eden/src/llm/scheduler.ts:255`) has no caller. | [eden/llm-and-scheduling.md](eden/llm-and-scheduling.md) |
| `report_to_god` | The brain collects `reportsToGod` (`eden/src/villagers/brain.ts:126-195`), but `main.ts` never reads it. | [eden/villager-runtime.md](eden/villager-runtime.md) |
| Revision history | The coordinator always passes `history: []` (`eden/src/main.ts:1308`), so the oldest-first trim never runs. | [eden/god.md](eden/god.md) |
| Journal retention, R32 `wipe|migrate` | `journal.retentionDays` is a fixed default (`eden/src/config.ts:353`, never pruned); the admin route does not exist. | [eden/journal-and-views.md](eden/journal-and-views.md) |
| CI workflows (`ci.yml`, `eden-ci.yml`) | `.github/` is gitignored and absent from history. | [platform/build-and-runtime.md](platform/build-and-runtime.md) |

What **is** live in Eden: the bot pool (with anchor healing after spawn and `library.verifyHashes()` at boot), stock
skills, the skill engine with its watchdogs and abort fence, villager deliberation with the **17** tools
(`eden/src/villagers/tools.ts:92-191`: skills, memory, subscriptions, consent-based trade settled on `:8767`, and the
D-18 speech tools `say`/`tell`/`start_conversation` backed by `ConversationBook`), the D-17 reactivity signals (chat,
entity-spotted/-lost, night-falls/new-day, inbox, health/death/hurt) plus a 30 s tick that also decays the drives,
subscriptions → reflex skills / deliberation, the curriculum (idle trigger) → orchestrator directive (with the
`intervene` tool through `GodBody`) → villager rollout → critic verdict (embodied when `embodiedVerdicts` is on) →
library admission loop with the fast-tier `DescriptionPass` and the auto-quarantine tripwire, God's state persisted in
the `snapshots` table and restored before D-09 rollout recovery, the journal, derived views replayed at boot, and the
admin API.

## How to navigate this corpus

- Every document has YAML frontmatter (`id`, `system`, `summary`, `tags`, `sources`) and is listed in
  [index.json](index.json). See [README.md](README.md) for reading paths and the MCP serving model.
- Cross-cutting lookups: [reference/commands.md](reference/commands.md), [reference/ports-files-config.md](reference/ports-files-config.md).
- Code citations are `path:line` at the commit in each doc's `verified_at` — re-check after code changes.

## Related
- [README.md](README.md) · [VERIFICATION-NOTES.md](VERIFICATION-NOTES.md)
- [platform/build-and-runtime.md](platform/build-and-runtime.md) · [platform/entrypoints-and-wiring.md](platform/entrypoints-and-wiring.md)
- [gibber/money-system.md](gibber/money-system.md) · [ctf/capture-the-flag.md](ctf/capture-the-flag.md)
- [aigod/overview.md](aigod/overview.md) · [aigod/building.md](aigod/building.md)
- [eden/overview.md](eden/overview.md) · [eden/java-integration.md](eden/java-integration.md)
