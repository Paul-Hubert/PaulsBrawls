# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Where this repo lives now

This is a **vendored fork** living inside the [pauls-brawls](../) Fabric mod repo at `pauls-brawls/minecraft-mcp-server/`. Three entrypoints share the codebase:

1. **Unified entrypoint** (`src/unified/main.ts`, `npm run unified`) — **what pauls-brawls actually uses.** One Mineflayer bot, one HTTP listener, two surfaces:
   - Bridge HTTP routes (`/appear /chat /look /gesture /vanish /health`) — used by Java's `BotBridgeClient` to puppet the avatar.
   - MCP-over-SSE routes (`/mcp/sse` + `/mcp/messages?sessionId=…`) — consumed by Java's `MCPGateway` via langchain4j-mcp's `HttpMcpTransport` (the older two-endpoint SSE protocol; langchain4j-mcp 1.0.0-beta5 doesn't speak streamable HTTP yet).
2. **Original MCP server** (`src/main.ts`, `npm run dev` / `npm start`) — MCP stdio transport, used by Claude Desktop. Kept in tree for upstream compat and as a rollback path.
3. **Bridge-only entrypoint** (`src/bridge/main.ts`, `npm run bridge`) — HTTP-only. Also kept as a rollback path.

All three reuse `BotConnection` and the Mineflayer plumbing. **Never run two with the same `--username`** — Minecraft kicks the second login. Pick one entrypoint per Minecraft server.

## Project Goal (original — Simple Voice Chat integration)

The original upstream goal was to extend this MCP server so an LLM-driven bot can **hear nearby player chatter via Simple Voice Chat (SVC) and choose to respond out loud** in the same proximity voice channel. The two pieces of the upstream system live in sibling repos on disk:

- `../minecraft-mcp-server` (this repo when checked out standalone) — TypeScript/Node MCP server that drives a Mineflayer bot. Currently exposes text-chat tools (`send-chat`, `read-chat`) but no voice I/O.
- `../simple-voice-chat` — Java/Gradle Minecraft mod (Fabric/Forge/NeoForge/Quilt/Bukkit/Paper/Velocity/BungeeCord). Provides proximity voice chat and a server-side plugin API under `api/src/main/java/de/maxhenkel/voicechat/api/`.

The intended pipeline:

1. SVC server-side plugin API captures Opus-encoded microphone packets from nearby players (`MicrophonePacketEvent`, `MicrophonePacket.getOpusEncodedData()`, `AudioListener` / `PlayerAudioListener`). Decode Opus → PCM → run **speech-to-text** (local model like whisper.cpp, or an API like OpenAI/Deepgram/Groq).
2. Transcripts plus speaker identity flow into this MCP server (likely a new tool akin to `read-chat`, fed by a new event-stream alongside the existing `MessageStore`) so the LLM can decide whether to respond.
3. When the LLM responds, this server runs **text-to-speech** (local Piper/Coqui, or an API like ElevenLabs/OpenAI), encodes to Opus, and ships PCM/Opus frames back to SVC for playback via `AudioChannel` / `AudioPlayer` on a `LocationalAudioChannel` or `EntityAudioChannel` anchored to the bot.

The bridge between SVC (JVM) and this server (Node) does not exist yet — it will need to be designed (likely a small JVM-side companion plugin that talks to this Node process over stdio/HTTP/WebSocket, mirroring how `BotConnection` already brokers between Mineflayer events and MCP tools).

## Commands

```bash
npm run unified       # Unified entrypoint from source via tsx (preferred — what pauls-brawls uses)
npm run unified:start # node dist/unified/main.js (unified built output)
npm run dev           # Legacy: MCP-stdio server from source via tsx
npm run bridge        # Legacy: bridge-HTTP-only from source via tsx
npm run build         # tsc -p tsconfig.build.json → emits dist/
npm start             # node dist/main.js (MCP server built output)
npm run bridge:start  # node dist/bridge/main.js (bridge built output)
npm test              # ava on tests/**/*.test.ts
npm run lint          # eslint on src + tests
npm run lint:fix
npx tsc --noEmit      # Type check only (CI runs this between lint and build)
```

CLI flags (all entrypoints): `--host`, `--port`, `--username`. The bridge and unified entrypoints add `--bridge-host` (default `127.0.0.1`) and `--bridge-port` (default `8765`). The unified entrypoint also accepts `--mcp-sse-path` (default `/mcp/sse`) and `--mcp-messages-path` (default `/mcp/messages`).

Run a single test file: `npx ava tests/chat-tools.test.ts`. Run a single test by name: `npx ava tests/chat-tools.test.ts -m "read-chat returns recent messages"`.

CI (`.github/workflows/build.yml`) runs lint → `tsc --noEmit` → build → test on Node 22.

## Architecture

`src/main.ts` is the composition root. It wires three long-lived singletons and then registers tools:

- **`BotConnection`** (`bot-connection.ts`) owns the Mineflayer bot lifecycle: connect, spawn, reconnect-on-disconnect, kicked/error handling. It exposes `checkConnectionAndReconnect()` which every tool call funnels through. Callbacks (`onLog`, `onChatMessage`) are injected so the connection layer doesn't import the MCP server or the message store directly.
- **`MessageStore`** (`message-store.ts`) is an in-memory ring buffer (cap 100) of incoming chat lines. `BotConnection`'s `'chat'` handler pushes into it; the `read-chat` tool reads from it. **This is the pattern voice transcripts should follow** — a parallel store fed by an SVC bridge, exposed via a new tool registration module.
- **`ToolFactory`** (`tool-factory.ts`) wraps `McpServer.tool()`. Every registered tool gets (1) an automatic connection check + reconnect, (2) Zod schema validation with friendly error formatting, (3) uniform error → `{ isError: true }` responses. New tools should always go through `factory.registerTool(...)` rather than calling `server.tool()` directly.

Tool modules live in `src/tools/` and are pure registration functions: `registerXxxTools(factory, getBot, ...deps)`. They close over `getBot = () => connection.getBot()!` so tool handlers always see the *current* bot instance after reconnects (do not capture the bot reference at registration time). When adding voice tools, follow this shape and add a `registerVoiceTools(factory, getBot, transcriptStore, audioSink)` module.

**Every new tool module must be registered in BOTH `src/main.ts` AND `src/unified/main.ts`.** Pauls-brawls runs unified exclusively; missing the unified-side registration means production silently doesn't see the tool. The two entrypoints currently call the same 12 `register*Tools(...)` functions; if you diverge them deliberately, document why next to the call sites.

### Plugin stack

Beyond pathfinder (pre-spawn), the unified bot auto-loads five Mineflayer plugins inside the `bot.once('spawn', ...)` handler in `bot-connection.ts`:

| Plugin | Tool-providing? | Notes |
|---|---|---|
| `mineflayer-pvp` | Yes — `attack-entity`, `stop-combat` in `tools/combat-tools.ts` | `bot.pvp.attack(target)` is fire-and-forget; pvp owns its own internal loop |
| `mineflayer-collectblock` | Yes — `collect-block` in `tools/collection-tools.ts` | Chains into mineflayer-tool internally for auto-equip during the mine step |
| `mineflayer-tool` | No (invisible) | Only used internally by `collect-block` and (when restored) `dig-block` via `bot.tool.equipForBlock(block, {})` |
| `mineflayer-auto-eat` | No (autonomous) | `bot.autoEat.setOpts({...})` + `bot.autoEat.enableAuto()` once at spawn. `returnToLastItem: true` is load-bearing for combat-after-eat |
| `mineflayer-armor-manager` | No (autonomous) | Listens to `playerCollect` and auto-equips best armor |

**ESM/CJS import shape trap** — `mineflayer-pvp`, `mineflayer-collectblock`, and `mineflayer-tool` are compiled CJS with `__esModule: true` set and named `exports.plugin` (no `exports.default`). `import pkg from 'x'; const { plugin } = pkg;` works under `npm run unified` (tsx synthesises default) but lands `undefined` under `npm test` (ava-tsx honours `__esModule` strictly). **Use named imports for those three** (`import { plugin as pvp } from 'mineflayer-pvp'`). `mineflayer-armor-manager` (raw `module.exports = inject`, no flag) works either way; `mineflayer-auto-eat` (native ESM) requires named imports natively.

### Tool inventory

25 tools currently registered (26 when `dig-block` is restored). The canonical list and verification harness are in the parent repo: `pauls-brawls/verify-mcp-tools.mjs` (executable check via `tools/list`) and `pauls-brawls/MCP_TOOLS_VERIFICATION.md` (the ground-truth table). `dig-block` is TEMP-disabled at user request — registration commented out in `tools/block-tools.ts` with restoration markers. `move-in-direction` was permanently removed (blind WASD, strictly worse than `move-to-position`).

`src/stdio-filter.ts` is load-bearing and easy to break: it silences `console.error` and gates `stdout` to only JSON-RPC frames + ISO-timestamped log lines. Mineflayer and its deps log chattily to stdout, which corrupts the MCP stdio transport. **Never log to stdout outside `logger.ts`** — use `log()` (which writes to stderr) for diagnostics. If you add a voice bridge that shells out or spawns processes, route their stdout/stderr away from this process's stdout.

The transport is `StdioServerTransport`; the server is invoked by the MCP client (e.g. Claude Desktop) via `npx github:yuniko-software/minecraft-mcp-server`. CLI flags (`--host`, `--port`, `--username`) are parsed in `src/config.ts`. Add voice-related flags there.

## God-Body bridge (src/bridge/)

A second, smaller entrypoint that exposes a localhost-only HTTP control server. pauls-brawls' Java mod (`BotBridgeClient`) drives it to puppet the bot avatar — `Appear` does a `/tp ... facing entity <player>`, `say` does a `bot.chat`, `gesture` does swing/jump/sneak/nod/summon, `vanish` `/tp`s the bot to a parking spot.

Files:

- `src/bridge/main.ts` — CLI entry. Constructs a `BotConnection` (reused as-is), waits for spawn, starts the HTTP server.
- `src/bridge/server.ts` — Native `http` server. JSON in / JSON out. Routes `GET /health` + `POST /{appear,chat,look,gesture,vanish}`. Body capped at 64 KiB. Errors → `{ ok: false, error }`.
- `src/bridge/actions.ts` — One handler per endpoint. Defensive about missing fields and missing-bot state.

Design rules to preserve:

- **Localhost-only by default** (`127.0.0.1`). Don't bind to `0.0.0.0` — there's no auth.
- **No new transports, no fan-out.** The bridge is a dumb RPC: any non-trivial decision (where to appear, what to say) belongs in pauls-brawls Java, not here.
- **Strip leading `/` in `POST /chat`.** Otherwise the model can make the (op'd) bot run arbitrary slash commands by sending them as "speech."
- **Best-effort semantics.** The Java caller treats every bridge call as fire-and-forget; never throw in a way that leaves the in-game effect in a half-applied state.
- **No `POST /spawn`.** Creature spawns happen server-side in the mod (`ChatBotActions.spawnCreature`, queued on the main thread). Adding a `/spawn` endpoint here would create a second, drifting path.

The stdio-filter rule still applies: log only via `log()` → stderr; never `console.log` to stdout. The bridge isn't an MCP server but the project guarantees one clean stdout.

## Simple Voice Chat integration notes

When working on the SVC side (the `../simple-voice-chat` sibling repo), the relevant entry points are:

- Server-side plugin API surface: `api/src/main/java/de/maxhenkel/voicechat/api/`. A Bukkit/Paper or Fabric/Forge companion plugin registers via `BukkitVoicechatService` (Bukkit) or the platform-equivalent, then subscribes to `MicrophonePacketEvent` for inbound audio and uses `VoicechatServerApi.createAudioChannel(...)` + `AudioPlayer` to emit outbound audio anchored to the bot entity.
- SVC is built with Gradle: `./gradlew build` from the repo root. The `api` subproject is the thinnest dependency to compile against for a companion plugin. Subprojects: `api, common, common-client, common-proxy, fabric, fabric:api-stub, neoforge, forge, bukkit, paper, velocity, bungeecord`.
- SVC requires UDP `24454` open and server-side install — Open-to-LAN singleplayer (this repo's default test setup) will NOT load SVC. Voice work needs a real dedicated server (Paper or Fabric) with both SVC and the companion bridge plugin installed.

## Mineflayer / Minecraft version

`SUPPORTED_MINECRAFT_VERSION = '1.21.1'` is hard-coded in `bot-connection.ts` and surfaced in error messages. This was bumped down from the upstream `1.21.11` to match the pauls-brawls Fabric mod's target. Bumping this in either direction requires:

1. Verifying `mineflayer` and `minecraft-data` versions in `package.json` carry the new protocol.
2. Keeping pauls-brawls' Minecraft target (`minecraft = "1.21.1"` in `gradle.properties`) in sync, or accepting that the MCP/bridge consumer will be on a different protocol.
3. Updating the README (which pins the version in user-facing prose).

The dedicated Fabric/Paper server, the mod, and the bot must all agree on one protocol version, or login fails silently with a "version mismatch" kick.
