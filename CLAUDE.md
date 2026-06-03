# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Fabric mod for Minecraft 1.21.1 (Java 21). Three loosely-coupled gameplay features bundled into one mod (`paulsbrawls`):

- **Gibber** — server-wide money system (a custom `coin` item) with admin gift commands and a periodic salary scheduler.
- **Capture the Flag** — auto-drops any banner named "Flag" when its holder takes damage, disables elytra while a Flag is carried, and makes flag-holders glow.
- **AI God** — LLM-driven `Dieu` entity (OpenAI Responses API). Players pray via `/prier`, propose proofs via `/prouver`, accept trades via `/accepter`, and ask God to design builds via `/construire`. Most player-facing strings are French.

## Build / run commands

```powershell
./gradlew build                # compile + run remap; also auto-copies to mods folders (see below)
./gradlew runServer            # launch dev dedicated server
./gradlew runClient            # launch dev client
./gradlew genSources           # generate Minecraft sources for IDE navigation
./gradlew clean
```

There are no tests in this project. The `ci.yml` workflow runs `./gradlew test` and `jacocoTestReport`, but no test sources exist — those steps are effectively no-ops/will fail on a clean checkout.

`build` is finalized by two `Copy` tasks (`copyToMods`, `copyToClientMods`) defined in [build.gradle:117](build.gradle:117). They copy the remapped jar into the paths set by `mods_folder` and `client_mods_folder` in [gradle.properties](gradle.properties). These properties point at Paul's local Minecraft installs — if you build on a different machine, either set them to your own mods folder or revert them to the placeholder `path/to/your/mods` so the copy is skipped.

The AI God feature requires `OPENAI_API_KEY` (optionally `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`) in the environment — the OpenAI client is built with `fromEnv()` in [ChatBot.java:46](src/main/java/com/paul/brawl/ChatBot.java:46). The system prompt is loaded at runtime from [prompt.txt](prompt.txt) in the working directory (not bundled into the jar).

## Architecture

### Entry points

Wired in [fabric.mod.json](src/main/resources/fabric.mod.json):

- [ServerEntryPoint.java](src/main/java/com/paul/brawl/ServerEntryPoint.java) (`DedicatedServerModInitializer`) registers everything: Gibber commands, RevenueManager, SalaryScheduler, the `coin` item, FlagManager, ChatBot.
- [ClientEntryPoint.java](src/client/java/com/paul/brawl/ClientEntryPoint.java) (`ClientModInitializer`) registers `Screenshotter` (which owns the `/prouver` and `/construire` client commands) and re-registers `Money` so the item is also known client-side.

Source set split is configured via `loom.splitEnvironmentSourceSets()` — client-only code lives under `src/client/`, shared/server code under `src/main/`.

### Gibber money flow

Designed so offline players still "earn" salary and receive their coins on next login:

1. The "total revenue" everyone is *entitled* to is a single global int stored in [PlayerPersistentState](src/main/java/com/paul/brawl/PlayerPersistentState.java) under key `total_revenue`.
2. Each player's *paid-out* revenue is stored per-UUID in the same persistent state.
3. `SalaryScheduler` ticks every `salary_period` seconds (default 10) and increments `total_revenue` by `salary_per_day`. It does NOT iterate players directly — it calls `RevenueManager.UpdateRevenueAll`.
4. `RevenueManager.updateRevenue(uuid)` computes `totalRevenue - currentRevenue` and gives that many `coin` items to the player, then writes back the new `currentRevenue`. The same path runs on `ServerPlayConnectionEvents.JOIN`, so offline players get their backlog at login.

`PlayerPersistentState` uses Minecraft's `PersistentState` API (saved per-world in the overworld's persistent state manager). NBT keys: `gibbers_state` → `player_data` (UUID→int) and `global_data` (string→int).

### AI God data flow

The complete request pipeline lives in [ChatBot.java](src/main/java/com/paul/brawl/ChatBot.java). Every request to OpenAI is built from scratch via `getPromptList(player)` and bundles four system messages: the hardcoded prompt + custom override, a JSON snapshot of the player from `PlayerDataCollector`, the recent global chat/command/game-message log from `ChatMessageHistory`, and a list of nearby blocks from `ChatBotActions.getBlockInfo` (uses the player's last raycast hit as origin). It then appends per-player conversation history from `ChatBotPlayerHistory`.

The model is gated on tool calls defined as Jackson-annotated POJOs in [ChatBotFunctions.java](src/main/java/com/paul/brawl/ChatBotFunctions.java): `Recompense`, `Echange`, `Punition`, `ChangerMeteo`, `Placer`. After the model responds, `checkForFunctions` dispatches each call by name; if any tool ran, `sendFunctionOutput` re-invokes the model with the tool outputs so it can continue reasoning. Tool calls and their outputs are appended to that player's history.

Image inputs: the client `/prouver` and `/construire` commands trigger `Screenshotter` to capture the framebuffer, resize to 854×480, and ship it via the custom `ImagePayload` C2S packet. The server-side `ImageReceiver` calls `ChatBot.sendImageChatRequest`, which inlines the JPEG as a base64 data URL. The user text gets prefixed with `Prompts.proofPrompt` or `Prompts.buildPrompt` depending on whether it contains `prouver :` or `construire :` — those prefix constants are empty by default and meant to be filled in.

The `Placer` tool needs an origin. Admins set it by running `/construction`, which calls `Raycaster.setLastPos` to store the block the admin is currently looking at, keyed by UUID. `Placer`'s `x/y/z` parameters are offsets from that stored position.

### Commands (Brigadier)

Server (require permission level 2 unless noted):
- `/gib <amount>` — bump global revenue, immediately pays all online players.
- `/gib_salary <amount>`, `/gib_salary_period <seconds>` — configure the scheduler. Period change restarts the scheduler.
- `/prier <text>` — open to everyone (perm 0); send a message to God.
- `/accepter` — open to everyone; accept the pending trade for this player.
- `/prompt [text]` — read or replace the custom prompt overlay (in-memory only, not persisted; the hardcoded prompt is reloaded from `prompt.txt`).
- `/bloc <x> <y> <z>` — debug stone placement at offset from the last raycast position.
- `/construction` — set the admin's current look target as the placement origin.

Client (registered in `Screenshotter`):
- `/prouver <text>`, `/construire <text>` — screenshot + ship to server with text prefix.

### Per-player chat history caveats

[ChatBotPlayerHistory](src/main/java/com/paul/brawl/ChatBotPlayerHistory.java) is in-memory only (`HashMap<UUID, List<ResponseInputItem>>`) and grows unbounded for the server's lifetime. Images are intentionally NOT added to history (see comment at [ChatBot.java:96](src/main/java/com/paul/brawl/ChatBot.java:96)) to keep token counts bounded, but the corresponding text input *is* saved. `ChatMessageHistory` is the global chat log (capped at 200 entries, shared across all players).

### Mixins

Both `paulsbrawls.mixins.json` and `paulsbrawls.client.mixins.json` exist and reference single `ExampleMixin` stubs — currently no real mixin logic. Add new mixins under the matching package and register them in those JSON files.

## Gotchas

- The CI workflow uploads to GitHub Releases on push to `main`/`master` — see [.github/workflows/ci.yml](.github/workflows/ci.yml). The `test` job still calls `./gradlew test` and `jacocoTestReport` even though no tests exist and the Jacoco plugin isn't applied — both will fail until tests are added or those steps are removed.
- Conversation continuity uses OpenAI's server-side `previousResponseId` chaining, keyed per-player in `ChatBot.previousResponseIds`. The first turn for a player sends the static system prompt + tools; follow-up turns omit the static prompt (the server retains it via the chain) but still re-send the dynamic context block (player JSON + global chat log + nearby blocks) so the model sees current state. Each refresh of dynamic state accumulates in the chain — token cost still grows over a long conversation, just more slowly than rebuilding everything. `/construction` resets the buildBot chain for the calling admin via `clearPreviousResponseId`.
- A large number of OpenAI/Jackson/Kotlin transitive deps are bundled via `include` (jar-in-jar) — see [build.gradle:38-65](build.gradle:38). When bumping versions, check that loom's `include` still pulls compatible artifacts.
