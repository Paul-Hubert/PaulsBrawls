---
id: platform.build-and-runtime
title: Build, packaging and runtime layout of the Fabric mod
system: platform
summary: How the paulsbrawls Fabric mod is built (Loom, versions, jar-in-jar deps, copy tasks), what is tracked in run/, CI reality, the Java unit tests, the empty minecraft-mcp-server gitlink, supervisor/ and .claude/.
tags: [gradle, loom, junit, tests, fabric, build, jar-in-jar, langchain4j, okhttp, mixins, assets, ci, run-dir, server-properties, submodule, supervisor]
sources: [build.gradle, settings.gradle, gradle.properties, .gitignore, .gitattributes, src/main/resources/fabric.mod.json, src/main/resources/paulsbrawls.mixins.json, src/client/resources/paulsbrawls.client.mixins.json, src/main/java/com/paul/brawl/mixin/ExampleMixin.java, src/client/java/com/paul/brawl/mixin/client/ExampleClientMixin.java, src/main/resources/assets/paulsbrawls/items/coin.json, src/main/resources/assets/paulsbrawls/models/item/coin.json, src/main/resources/assets/paulsbrawls/lang/en_us.json, src/main/resources/assets/paulsbrawls/lang/fr_fr.json, run/server.properties, run/mcp_config.properties, run/eula.txt, run/prompt.txt, supervisor/SUPERVISOR.md, supervisor/check.ps1, .claude/launch.json, src/main/java/com/paul/brawl/ChatBot.java, src/main/java/com/paul/brawl/MCPGateway.java, src/main/java/com/paul/brawl/ChatCommand.java, src/main/java/com/paul/brawl/ImageReceiver.java, src/test/java/com/paul/brawl/TradeMathTest.java, src/test/java/com/paul/brawl/BuildGuardTest.java, src/test/java/com/paul/brawl/FlagGlowTest.java, src/test/java/com/paul/brawl/GodClampsTest.java, src/test/java/com/paul/brawl/BlockInfoJsonTest.java, src/test/java/com/paul/brawl/EdenRetryTest.java, src/test/java/com/paul/brawl/GibberMathTest.java, src/test/java/com/paul/brawl/GodToolGateTest.java, src/test/java/com/paul/brawl/ImageMimeTest.java, src/test/java/com/paul/brawl/ItemIdsTest.java, src/test/java/com/paul/brawl/GodActionQueueTest.java]
verified_at: 98cb908
---

# Build, packaging and runtime layout of the Fabric mod

**TL;DR** — `paulsbrawls` is a Fabric Loom project (Minecraft 1.21.1, Java 21, yarn mappings, split
client/main source sets). LangChain4j + Jackson + OkHttp/Okio/Kotlin stdlib are shipped jar-in-jar via
`include`. `build` is finalized by two `Copy` tasks that drop the remapped jar into Paul's local mods
folders. In this checkout there is **no Gradle wrapper and no `.github/` directory** (both are gitignored),
`minecraft-mcp-server/` is an **empty gitlink** (no `.gitmodules`), and the Java side has eleven JUnit 5 suites
for its Minecraft-free helpers (`./gradlew test`).

## Toolchain and versions

All versions come from `gradle.properties` and are interpolated into `build.gradle`.

| Property | Value | Where |
|---|---|---|
| `minecraft_version` | `1.21.1` | `gradle.properties:7` |
| `yarn_mappings` | `1.21.1+build.3` (used as `net.fabricmc:yarn:…:v2`) | `gradle.properties:8`, `build.gradle:32` |
| `loader_version` (Fabric Loader) | `0.17.3` | `gradle.properties:9` |
| `loom_version` (plugin `fabric-loom`) | `1.11-SNAPSHOT` | `gradle.properties:10`, `build.gradle:2` |
| `fabric_version` (Fabric API) | `0.116.7+1.21.1` | `gradle.properties:18` |
| `mod_version` | `1.0.0` | `gradle.properties:13` |
| `maven_group` | `com.paul.paulsbrawls` | `gradle.properties:14` |
| `archives_base_name` | `paulsbrawls` | `gradle.properties:15` |
| Gradle JVM | `-Xmx4G`, `org.gradle.parallel=true` | `gradle.properties:2-3` |
| Java release | `options.release = 21`, source/target `VERSION_21` | `build.gradle:113`, `build.gradle:123-124` |

`settings.gradle` only declares plugin repositories: Fabric maven (`https://maven.fabricmc.net/`),
Maven Central, Gradle Plugin Portal. Project repositories: `mavenCentral()` only (`build.gradle:14-16`).

Note the Java package is `com.paul.brawl` while `maven_group` is `com.paul.paulsbrawls` — they are unrelated.

## Source-set split

`loom { splitEnvironmentSourceSets() }` (`build.gradle:17-27`) creates two source sets, both assigned to
the single mod id `paulsbrawls`:

| Source set | Path | Contains |
|---|---|---|
| `main` (common/server) | `src/main/java`, `src/main/resources` | All gameplay code (Gibber, CTF, AI God, village listener), `fabric.mod.json`, assets, `paulsbrawls.mixins.json` |
| `client` | `src/client/java`, `src/client/resources` | `ClientEntryPoint`, `Screenshotter` (`/prove`, `/build`), `ExampleClientMixin`, `paulsbrawls.client.mixins.json` |

Client code may reference `main` classes (e.g. `ClientEntryPoint` calls `Money.register()`,
`Screenshotter` calls `ImageReceiver.commonRegister()`), never the reverse.

## Dependencies

### Compile/runtime (`build.gradle:29-98`)

| Configuration | Artifact | Version |
|---|---|---|
| `minecraft` | `com.mojang:minecraft` | 1.21.1 |
| `mappings` | `net.fabricmc:yarn` | 1.21.1+build.3:v2 |
| `modImplementation` | `net.fabricmc:fabric-loader` | 0.17.3 |
| `modImplementation` | `net.fabricmc.fabric-api:fabric-api` | 0.116.7+1.21.1 |
| `implementation` | `dev.langchain4j:langchain4j` | 1.0.0 |
| `implementation` | `dev.langchain4j:langchain4j-open-ai` | 1.0.0 |
| `implementation` | `dev.langchain4j:langchain4j-mcp` | 1.0.0-beta5 |
| `implementation` | `dev.langchain4j:langchain4j-anthropic` | 1.0.0-beta5 |
| `testImplementation` | `org.junit:junit-bom` (platform) + `org.junit.jupiter:junit-jupiter` | 5.11.4 |
| `testRuntimeOnly` | `org.junit.platform:junit-platform-launcher` | (from the BOM) |

Test dependencies (`build.gradle:94-97`) are not bundled; `test { useJUnitPlatform() }` is at `build.gradle:100-102`.

### Jar-in-jar (`include`) — the runtime closure shipped inside the mod jar

`implementation` alone does not ship anything at runtime in a Fabric mod; every runtime library must be
`include`d (nested JAR). The list is hand-maintained:

| Group | Artifacts (`include`) | Why (from comments) | Lines |
|---|---|---|---|
| LangChain4j | `langchain4j`, `langchain4j-core`, `langchain4j-open-ai`, `langchain4j-http-client`, `langchain4j-http-client-jdk` (all 1.0.0); `langchain4j-mcp`, `langchain4j-anthropic` (1.0.0-beta5) | LLM client + MCP client | `build.gradle:56-62` |
| jspecify | `org.jspecify:jspecify:1.0.0` | runtime-retained `@NullMarked`/`@Nullable` from langchain4j-core | `build.gradle:65` |
| jtokkit | `com.knuddels:jtokkit:1.1.0` | `OpenAiTokenCountEstimator` (ChatBot token budget) — without it: NCDFE `com/knuddels/jtokkit/Encodings` on boot | `build.gradle:69` |
| Jackson | `jackson-databind` 2.21.1, `jackson-core` 2.21.1, `jackson-bom` 2.21.1, `jackson-annotations` 2.21, `jackson-datatype-jdk8` 2.21.1, `jackson-datatype-jsr310` 2.21.1 | LangChain4j + `@JsonClassDescription`/`@JsonPropertyDescription` on tool POJOs read by `JsonSchemaAdapter`; the MCP SDK's Jackson 2 mapper (which lifts the line from 2.19 to 2.21, docs/27 phase 3) | `build.gradle:76-81` |
| MCP server (docs/27) | `mcp-core` + `mcp-json-jackson2` 2.0.1, `reactor-core` 3.7.0, `reactive-streams` 1.0.4, `json-schema-validator` 2.0.4 (networknt), `itu` 1.14.0, `jackson-dataformat-yaml` 2.21.1, `snakeyaml` 2.5 | The `god`/`builder` MCP servers ([aigod/mcp-servers.md](../aigod/mcp-servers.md)); the transport is the JDK `HttpServer`, so no servlet container | `build.gradle:86-93` |
| OkHttp pile | `okhttp` 4.12.0, `okhttp-sse` 4.12.0, `okio` 3.6.0, `okio-jvm` 3.6.0, `kotlin-stdlib`/`-jdk7`/`-jdk8` 1.9.10 | `langchain4j-mcp`'s `HttpMcpTransport` is OkHttp-based; without them the first `/pray` that builds tools NCDFEs on `okhttp3/Interceptor` | `build.gradle:102-108` |

`MCPGateway` really does use `HttpMcpTransport` (`src/main/java/com/paul/brawl/MCPGateway.java:16`,
`:219`). The comment at `build.gradle:43-47` still says "the stdio transport is part of this module" and
mentions `StdioMcpTransport` — that comment is stale; the stdio transport is not used.

When bumping `langchain4j-mcp`, the comment at `build.gradle:82-83` says to re-derive the OkHttp pins with
`./gradlew dependencyInsight --dependency okhttp`. For the MCP SDK closure, re-derive with
`gradle dependencies --configuration runtimeClasspath` (`build.gradle:83-85`).

## Packaging tasks

| Task / block | Behaviour | Lines |
|---|---|---|
| `processResources` | Expands `${version}` in `fabric.mod.json` from `project.version` (`1.0.0`) | `build.gradle:104-110` |
| `java { withSourcesJar() }` | Also produces a sources jar | `build.gradle:117-125` |
| `jar` | Bundles `LICENSE` renamed to `LICENSE_paulsbrawls` | `build.gradle:127-133` |
| `publishing` | `mavenJava` publication, no repositories configured (no-op publish target) | `build.gradle:136-151` |
| `copyToMods` (Copy) | Copies `remapJar` output into `mods_folder`; `onlyIf` the property exists and is not `path/to/your/mods` | `build.gradle:153-160` |
| `copyToClientMods` (Copy) | Same for `client_mods_folder` | `build.gradle:162-169` |
| `build.finalizedBy(...)` | Both copy tasks always run after `build` | `build.gradle:171-172` |

Output jar name is `paulsbrawls-1.0.0.jar` (from `archives_base_name` + `mod_version`) under
`build/libs/` (standard Loom layout; `build/` is gitignored).

Current copy targets (`gradle.properties:23-24`):

| Property | Value |
|---|---|
| `mods_folder` | `C:/Users/Paul/Desktop/PaulsBrawlsVanilla/mods` (the production dedicated server) |
| `client_mods_folder` | `C:/Users/Paul/AppData/Roaming/PrismLauncher/instances/PaulsBrawls/minecraft/mods` (PrismLauncher instance — dir is `minecraft/`, no dot) |

To disable the copy on another machine set either property to the literal `path/to/your/mods`.

> ⚠ Unverified: on a non-Windows host Gradle would resolve `C:/Users/...` as a path relative to the
> project directory rather than failing; this was not executed here.

## Mod metadata — `src/main/resources/fabric.mod.json`

| Field | Value |
|---|---|
| `id` | `paulsbrawls` |
| `name` | `Paul's Brawls` |
| `version` | `${version}` (expanded at build) |
| `description` | "The best path to a communist utopia is giving everyone a lot of money." |
| `authors` | `Paul Boursin` |
| `contact` | Fabric example-mod placeholders (`https://fabricmc.net/`, `fabric-example-mod` repo) |
| `license` | `CC0-1.0` (the repo `LICENSE` file is what is bundled) |
| `icon` | `assets/paulsbrawls/icon.png` (128×128 PNG) |
| `environment` | `*` |
| `entrypoints.server` | `com.paul.brawl.ServerEntryPoint` (a `DedicatedServerModInitializer`) |
| `entrypoints.client` | `com.paul.brawl.ClientEntryPoint` |
| `mixins` | `paulsbrawls.mixins.json`; `paulsbrawls.client.mixins.json` with `environment: client` |
| `depends` | `fabricloader >=0.16.14`, `minecraft ~1.21.1`, `java >=21`, `fabric-api *` |
| `suggests` | `another-mod: *` (template leftover) |

There is **no `main` entrypoint**. The `server` entrypoint only runs on a dedicated server, the `client`
entrypoint only on a client. Consequence: in single-player / Open-to-LAN (integrated server) none of the
server features (Gibber, CTF, AI God, village listener, op-on-join) are registered; only the `coin` item
(registered by `ClientEntryPoint`) and the client commands exist. See
[entrypoints-and-wiring.md](entrypoints-and-wiring.md).

## Mixins — stubs only

| Config | Package | Mixin | Target | Body |
|---|---|---|---|---|
| `src/main/resources/paulsbrawls.mixins.json` | `com.paul.brawl.mixin` | `ExampleMixin` (in `"mixins"`) | `MinecraftServer.loadWorld` @ HEAD | empty (`ExampleMixin.java:11-14`) |
| `src/client/resources/paulsbrawls.client.mixins.json` | `com.paul.brawl.mixin.client` | `ExampleClientMixin` (in `"client"`) | `MinecraftClient.run` @ HEAD | empty (`ExampleClientMixin.java:11-14`) |

Both configs: `required: true`, `compatibilityLevel: JAVA_21`, `injectors.defaultRequire: 1`. They do
nothing; all behaviour is done through Fabric API events instead. To add a real mixin, add the class under
the listed package and its simple name to the matching array.

## Assets (`src/main/resources/assets/paulsbrawls/`)

| File | Content |
|---|---|
| `models/item/coin.json` | `parent: minecraft:item/generated`, `layer0: paulsbrawls:item/coin` — the model 1.21.1 actually uses |
| `textures/item/coin.png` | 16×16 colormapped PNG |
| `items/coin.json` | `{"model":{"type":"minecraft:model","model":"paulsbrawls:item/coin"}}` — the 1.21.4+ item-definition format; ignored by a 1.21.1 client |
| `lang/en_us.json` | `"item.paulsbrawls.coin": "Coin"` |
| `lang/fr_fr.json` | `"item.paulsbrawls.coin": "Pièce"` |
| `icon.png` | 128×128 RGBA mod icon |

The item itself is registered in code (`Money.java:18-23`); see
[../gibber/money-system.md](../gibber/money-system.md).

## Gradle wrapper and IDE files are not tracked

`.gitignore` (CRLF line endings) ignores, among others: `.github` (line 1), `.gradle`, `.vscode`,
`build`, `gradle` (the wrapper directory), `gradlew*` (line 6), `bin/`, `out/`, `.idea/`, `*.jar`, `*.log`.
So a fresh clone has **no `gradlew`/`gradlew.bat` and no `gradle/wrapper/`** — the `./gradlew …` commands
in CLAUDE.md assume a locally present wrapper (or use a system Gradle compatible with Loom 1.11).
`.gitattributes` still declares `/gradlew text eol=lf` and `*.bat text eol=crlf`.

## CI — what really exists

`.github` is gitignored (`.gitignore:1`) and `git log --all -- .github` is empty: **no workflow file
(`ci.yml` or `eden-ci.yml`) has ever been committed** in this repository. Any claim about CI behaviour
(running `./gradlew test`, `jacocoTestReport`, uploading releases, the Eden CI gate) cannot be verified
from the repo.

> ⚠ Unverified: CI workflows may exist on Paul's machine (untracked). Nothing in the tracked tree runs them.

`build.gradle` applies no Jacoco plugin, so a `jacocoTestReport` task does not exist.

## Java unit tests (`src/test/java/com/paul/brawl/`)

Sixteen JUnit 5 suites (89 `@Test`s), run with `./gradlew test`. None boots Minecraft, so command trees, packets and
world effects still need an in-game check. Most cover a Minecraft-free helper class in `src/main/java/com/paul/brawl/`;
`GodServiceTest` / `BuildServiceTest` run the world layer's rules against recording world ports
(`RecordingGodWorld`, `RecordingBuildWorld`), and the MCP contract tests run the real `god`/`builder` servers on a
loopback port against the official MCP Java SDK client ([aigod/mcp-servers.md](../aigod/mcp-servers.md)).

| Suite | `@Test`s | Class under test | What it pins |
|---|---|---|---|
| `TradeMathTest` | 11 | `TradeMath` | Per-item aggregation + validation shared by the `:8767` settlement and God's `/accept` offers |
| `BuildGuardTest` | 5 | `BuildGuard` | Sub-agent cap (4) and per-call block cap (128), cancellation (bug #7) |
| `FlagGlowTest` | 4 | `FlagGlow` | Glow ownership: the mod clears only a glow it set itself, and reports it on leave so it is cleared before the save (bug #11) |
| `GodClampsTest` | 4 | `GodClamps` | Clamps on `Reward` amount, `Punishment` strikes and `SpawnCreature` offsets (bug #6) |
| `BlockInfoJsonTest` | 3 | `BlockInfoJson` | The `getBlockInfo` JSON shape (bug #18) |
| `EdenRetryTest` | 3 | `EdenRetry` | Which failed `/villagers` POSTs may be re-sent: `restart` only on a refused connection (bug #16) |
| `GibberMathTest` | 4 | `GibberMath` | Saturating revenue arithmetic; credit = the measured coin-count rise (bug #10) |
| `GodActionQueueTest` | 4 | `GodActionQueue` | Actions drain before bulk build placements; a withdrawn action never runs (bug #7 review) |
| `GodToolGateTest` | 3 | `GodToolGate` | MCP tools refused for a bodiless prayer or a disabled bridge (bug #8) |
| `ImageMimeTest` | 3 | `ImageMime` | MIME sniffing of image bytes for `/prove`/`/build` (bug #9) |
| `ItemIdsTest` | 3 | `ItemIds` | Registry-id extraction from an item string (components/NBT stripped, `minecraft:` default) (bug #6) |
| `GodServiceTest` | 12 | `GodService`, `GodSessionManager` | Every God clamp/refusal, the owner gate on the body, gestures only for a manifested owner, session generations |
| `BuildServiceTest` | 6 | `BuildService`, `BuildShapes` | Line walk, 128-block cap before allocation, unknown block, no pivot, offline player |
| `AgentTicketsTest` | 4 | `AgentTickets`, `McpHttpEndpoint` predicates | Ticket kind/expiry/revocation; bearer and Origin checks |
| `BuilderMcpServerTest` | 10 | `BuilderMcpServer`, `SubBuilds`, `McpHttpEndpoint` | Real MCP client: tool schemas, every refusal, the 4-sub-build and 128-block caps, HTTP 401/403/405/400 |
| `GodMcpServerTest` | 10 | `GodMcpServer` | Real MCP client: tool list, ownership and stale-session refusals, clamps, bridge gate, `wait` bound |

## `run/` — the dev server working directory (`./gradlew runServer`)

Tracked files (`git ls-files run/`):

| File | Purpose / notable values |
|---|---|
| `run/server.properties` | `server-port=25599`, `query.port=25565` (note: differs from server-port), `enable-rcon=true`, `rcon.port=25575`, `rcon.password=paulsbrawls-eval`, `online-mode=false` (lets Mineflayer bots log in offline), `spawn-protection=0`, `op-permission-level=4`, `function-permission-level=2`, `difficulty=easy`, `gamemode=survival`, `pvp=true`, `allow-flight=true`, `enable-command-block=true`, `view-distance=20`, `simulation-distance=10`, `white-list=false`, `enforce-secure-profile=true` |
| `run/eula.txt` | `eula=true` |
| `run/mcp_config.properties` | `enabled=true`, `sse_url=http\://127.0.0.1\:8765/mcp/sse`, `timeout_seconds=60` (read by `MCPConfig`; see [../aigod/mcp-gateway.md](../aigod/mcp-gateway.md)) |
| `run/prompt.txt` | The dev God persona — literally `do whatever I ask` (17 bytes). Differs from the 5 KB repo-root `prompt.txt`. Loaded at `ChatBot` construction from the JVM cwd (`ChatBot.java:195-198`, `readPrompt` at `:638-644`) and re-read by bare `/prompt` (`ChatCommand.java:145-146`) |
| `run/build_prompt.txt`, `run/max_build_prompt.txt`, `run/prompt - Copy.txt` | Build sub-agent prompt + variants (only `build_prompt.txt` is read by code) |
| `run/banned-ips.json`, `run/banned-players.json`, `run/whitelist.json` | Empty JSON arrays |

Ignored under `run/` (`.gitignore:102-111`): `world/`, `logs/`, `usercache.json`, `ops.json`,
`config/worldedit/worldedit.properties`, and **`run/llm_config.properties`** (holds a live provider API
key). `bridge_config.properties` and `village_config.properties` are not present in `run/`; they are created
in the JVM cwd on first save.

Runtime files the mod reads/writes **relative to the JVM working directory** (so `run/` for the dev server,
the server root for production):

| File | Owner class | Created when |
|---|---|---|
| `prompt.txt`, `build_prompt.txt` | `ChatBot` | read at registration and on bare `/prompt` (must pre-exist) |
| `llm_config.properties` | `LLMConfig` | on `/llm …` save |
| `bridge_config.properties` | `BridgeConfig` | on `/llm bridge …` or `/godbody on`/`off` save (`LLMCommand.java:120-170`, `ChatCommand.java:72,82`) |
| `mcp_config.properties` | `MCPConfig` | on load if missing (see aigod docs) |
| `village_config.properties` | `VillageConfig` | only on `/village on|off` |
| `proof_screen.png` | `ImageReceiver` (debug save; the call is commented out at `ImageReceiver.java:22`) | — |
| `world/data/gibbers_state.dat` | `PlayerPersistentState` (Minecraft `PersistentState`) | on world save after a change |

## `minecraft-mcp-server/` — an empty gitlink

`git ls-files -s minecraft-mcp-server` shows mode `160000` (a submodule gitlink) pointing at commit
`c0e56f2b96b8084b05a83c8882156c6ee1656c61`, but there is **no `.gitmodules`** file, so
`git submodule update` cannot fetch it and the directory is empty in this checkout. Everything CLAUDE.md
says about the unified bridge, MCP tools, the v1 village, `verify-mcp-tools.mjs` targets, etc. lives in
that missing tree.

> ⚠ Unverified: all Node code under `minecraft-mcp-server/` (bridge routes, MCP tools, v1 village admin
> API on 8766). Only the Java clients that call it (`BotBridgeClient`, `MCPGateway`, `VillageCommand`) can
> be verified.

## `supervisor/` — legacy v1 run-supervision protocol

`supervisor/SUPERVISOR.md` is a protocol for an AI supervisor (Claude Code) babysitting a **v1** village
food-production benchmark run; its header marks it **LEGACY** (Eden is primary). It describes topology
(dev server 25599, settlement 8767, v1 admin 8766, Eden admin 8770), the v1 admin API
(`/village/status`, `/village/metrics`, `/village/skills`, `/village/bot/<name>`, `…/tell`,
`/village/broadcast`, `/village/pause|resume`), an escalation ladder (observe → tell → restart → fix code;
"never edit Java"), and the append-only logs `supervisor/problems.jsonl` / `actions.jsonl`.

`supervisor/check.ps1` (PowerShell) produces the per-wake digest:

1. Loads/saves offsets in `supervisor/state.json` (`villageLog`, `villageOffset`, `skillsLog`,
   `skillsOffset`, plus any extra keys it preserves).
2. Tails the newest `minecraft-mcp-server/logs/village-*.log` from the saved byte offset (resets on
   rotation/truncation), filters lines matching errors/warnings/`FAILED`/`DISABLED`/`unhandled`/`kicked`/
   skill and benchmark markers, and if more than 120 are flagged prints a grouped tally (top 20) plus the
   last 40.
3. Tails the newest `minecraft-mcp-server/logs/skills-*.jsonl` and prints one line per skill event.
4. `GET http://127.0.0.1:8766/village/metrics` and `/village/status` (5 s timeout) and prints food
   counters and per-bot state.

It only talks to the v1 process (8766) and v1 log paths; it does not know about Eden's admin API.

## `.claude/launch.json`

Two launch configurations for Claude Code's preview tooling:

| Name | Command | Port |
|---|---|---|
| `docs-static` | `npx -y http-server docs -p 8088 -c-1` (serves `docs/` statically, no cache) | 8088 |
| `eden-dashboard` | `node eden/node_modules/tsx/dist/cli.mjs eden/.smoke/serve.ts` (`autoPort: true`) | 8791 |

`eden/.smoke/` is gitignored (`eden/.gitignore:12`) and absent in this checkout, so `eden-dashboard`
cannot run from a clean clone.

## Gotchas & known issues

- No Gradle wrapper and no CI workflows are tracked (both gitignored) — CLAUDE.md's `ci.yml` description is unverifiable.
- `minecraft-mcp-server/` gitlink has no `.gitmodules` entry; the directory is empty.
- `build.gradle:43-47` comment about the stdio MCP transport is stale (code uses `HttpMcpTransport`).
- `jackson-bom` is pinned to 2.18.2 while the other Jackson artifacts are 2.19.1 (`build.gradle:72`).
- `fabric.mod.json` `contact`/`suggests` are template leftovers.
- `items/coin.json` is a 1.21.4+ format file; harmless on 1.21.1.
- The copy tasks run on every `build`; with Paul's paths on another machine you must override them.
- `run/server.properties` has `query.port=25565` while `server-port=25599`; RCON password is committed in clear text.
- Integrated (single-player) servers never run `ServerEntryPoint` — features silently absent.

## Related

- [entrypoints-and-wiring.md](entrypoints-and-wiring.md)
- [../gibber/money-system.md](../gibber/money-system.md)
- [../aigod/mcp-gateway.md](../aigod/mcp-gateway.md)
- [../aigod/configuration-and-commands.md](../aigod/configuration-and-commands.md)
- [../reference/ports-files-config.md](../reference/ports-files-config.md)
- [../00-overview.md](../00-overview.md)
