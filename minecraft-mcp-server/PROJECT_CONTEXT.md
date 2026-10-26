# Minecraft MCP Server — Project Context

A living context document for the `minecraft-mcp-server` project: what it is, how it's structured, how to run it, and where it's going.

> **As-checked-out:** this copy lives inside the pauls-brawls Fabric mod repo at `pauls-brawls/minecraft-mcp-server/`. Beyond the upstream MCP server, it now hosts a small **God-Body HTTP bridge** under `src/bridge/` that pauls-brawls drives to give its AI God a physical avatar in-game. Full architecture in [../GOD_BOT_INTEGRATION_PLAN.md](../GOD_BOT_INTEGRATION_PLAN.md). When this doc says "this MCP server," it means the original entrypoint (`src/main.ts`); the bridge is a sibling entrypoint sharing the same `BotConnection`.

---

## 1. What this project is

An MCP (Model Context Protocol) server that drives a Minecraft bot via [Mineflayer](https://github.com/PrismarineJS/mineflayer), exposing the bot's actions as tools an LLM can call. The LLM (e.g. Claude Desktop) connects to this server over stdio, sees a set of bot tools (`send-chat`, `read-chat`, `get-position`, movement, mining, etc.), and uses them to play.

### The bigger picture

Two consumers share the codebase today:

- **MCP transport** (`src/main.ts`, original) — Claude Desktop or another MCP client speaks JSON-RPC over stdio. Long-running session, large tool surface.
- **HTTP bridge** (`src/bridge/main.ts`) — pauls-brawls' Java mod POSTs `appear/chat/look/gesture/vanish` to localhost:8765. Tiny tool surface, no MCP framing, no Claude Desktop in the loop.

Future upstream goal (not in scope here): **Simple Voice Chat integration.** Sibling repo on disk: `../simple-voice-chat` (a Java Minecraft mod for proximity voice chat). The eventual pipeline:

1. Capture nearby-player voice via SVC's plugin API → speech-to-text → feed transcripts into this MCP server.
2. LLM decides whether to respond.
3. Response → text-to-speech → Opus encode → played back through SVC anchored to the bot entity.

Today the server handles text only. Voice is a future bridge between the JVM (SVC) and Node (this repo).

---

## 2. Repo layout

```
minecraft-mcp-server/
├── src/
│   ├── main.ts                # MCP composition root (stdio transport)
│   ├── bot-connection.ts      # Mineflayer lifecycle (connect, spawn, reconnect) — shared
│   ├── message-store.ts       # In-memory ring buffer (cap 100) of chat lines
│   ├── tool-factory.ts        # Wraps McpServer.tool() with checks + Zod validation
│   ├── stdio-filter.ts        # Gates stdout to JSON-RPC only (load-bearing)
│   ├── logger.ts              # log() → stderr
│   ├── config.ts              # CLI flag parsing (yargs): --host, --port, --username
│   ├── tools/                 # MCP tool modules — pure registration functions
│   └── bridge/                # God-Body HTTP bridge (pauls-brawls consumer)
│       ├── main.ts            #   Bridge entrypoint (npm run bridge)
│       ├── server.ts          #   HTTP routing
│       └── actions.ts         #   appear / chat / look / gesture / vanish handlers
├── tests/                     # ava tests
├── dist/                      # Build output (tsc → dist/main.js, dist/bridge/main.js)
├── package.json
├── tsconfig.json / tsconfig.build.json
└── CLAUDE.md                  # Codebase guidance (this doc complements it)
```

### Key singletons

| Singleton | File | Job |
|---|---|---|
| `BotConnection` | `bot-connection.ts` | Owns Mineflayer bot lifecycle. Every tool call funnels through `checkConnectionAndReconnect()`. Callbacks injected (`onLog`, `onChatMessage`) so the connection layer doesn't import MCP or the store directly. |
| `MessageStore` | `message-store.ts` | Ring buffer of chat lines (max 100). `read-chat` reads from it. **Voice transcripts should follow this same pattern** — a parallel store fed by an SVC bridge. |
| `ToolFactory` | `tool-factory.ts` | Wraps `server.tool()`. Every registered tool gets (1) auto connection check + reconnect, (2) Zod schema validation, (3) uniform error → `{ isError: true }`. **Always go through `factory.registerTool(...)`, never `server.tool()` directly.** |

### Tool module pattern

```ts
// src/tools/your-tools.ts
export function registerYourTools(factory, getBot, ...deps) {
  factory.registerTool('your-tool', schema, async (input) => {
    const bot = getBot();
    // ...
  });
}
```

`getBot = () => connection.getBot()!` is passed in. **Never capture `bot` at registration time** — after a reconnect the reference is stale. Always read it fresh inside the handler.

---

## 3. The stdio constraint (don't break this)

The MCP transport is `StdioServerTransport`. Claude Desktop spawns this process and communicates over stdin/stdout JSON-RPC frames.

`src/stdio-filter.ts`:
- Silences `console.error`
- Gates stdout to JSON-RPC frames + ISO-timestamped log lines only

Mineflayer and its deps log chattily to stdout. Without the filter, those logs corrupt the MCP transport.

**Rules**:
- Never `console.log` outside `logger.ts`.
- All diagnostics go through `log()` (stderr).
- If you spawn subprocesses (voice bridge, etc.), pipe their stdout/stderr away from this process's stdout.
- Do **not** edit `stdio-filter.ts` casually.

---

## 4. Minecraft version

`SUPPORTED_MINECRAFT_VERSION = '1.21.11'` is hard-coded in `src/bot-connection.ts` and shown in error messages.

To bump:
1. Change the constant in `bot-connection.ts`.
2. Verify `mineflayer` + `minecraft-data` in `package.json` support the new protocol.
3. Update `README.md` (it pins the version too).

Your Minecraft server **must match this version exactly**.

---

## 5. Commands

```bash
npm install
npm run dev      # Run from source with tsx (use during iteration)
npm run build    # tsc -p tsconfig.build.json → emits dist/
npm start        # node dist/main.js (what npx ships)
npm test         # ava on tests/**/*.test.ts
npm run lint
npm run lint:fix
npx tsc --noEmit # Type check only
```

Single test file: `npx ava tests/chat-tools.test.ts`
Single test by name: `npx ava tests/chat-tools.test.ts -m "read-chat returns recent messages"`

CI (`.github/workflows/build.yml`): lint → `tsc --noEmit` → build → test on Node 22.

---

## 6. Running it — Minecraft server options

### Option A: Open-to-LAN singleplayer (quickest)
1. Launch Minecraft 1.21.11 Java Edition, open a singleplayer world.
2. `ESC → Open to LAN` — Minecraft prints a random port in chat (e.g. `Local game hosted on port 51234`).
3. Use that port in the MCP config below.

Downsides: port changes every time you Open-to-LAN, can't install SVC, can't run server-side mods. Fine for quick text-only smoke tests.

### Option B: Fabric dedicated server (recommended)

Stable port, mod-capable (required later for SVC), and you can join it from your own MC client and play alongside the bot.

1. Download Fabric server launcher for MC 1.21.11 from https://fabricmc.net/use/server/.
2. Put it in an empty dir, e.g. `~/minecraft-fabric-server/`.
3. First run to generate config: `java -Xmx2G -jar fabric-server-launch.jar nogui`
4. Edit `eula.txt`: `eula=true`.
5. Edit `server.properties`:
   ```
   online-mode=false
   server-port=25565
   spawn-protection=0
   ```
   `online-mode=false` lets Mineflayer connect with any username. **Only safe on a LAN-bound or firewalled server.**
6. Restart: `java -Xmx2G -jar fabric-server-launch.jar nogui`. Wait for `Done (Xs)!`.

### Playing alongside the bot
With a Fabric server running, you connect from your own Minecraft client to `localhost:25565` (or wherever) — same world as ClaudeBot, both players visible to each other.

Gotchas:
- Don't name yourself `ClaudeBot` in your launcher (collision will kick one of you).
- Server, MC client, and Node process all run on the same machine fine (~2 GB server, ~3-4 GB client).
- For creative testing: `op <your-name>` in the server console, then `/gamemode creative`.

### Two AI bots
Add a second MCP server entry to `claude_desktop_config.json` with a different `--username`. Both will join the world as separate players.

---

## 7. Claude Desktop wiring

Config file location:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%AppData%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Merge — don't clobber existing `mcpServers`:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "node",
      "args": [
        "C:\\Users\\Paul\\Desktop\\minecraft-mcp-server\\dist\\main.js",
        "--host", "localhost",
        "--port", "25565",
        "--username", "ClaudeBot"
      ]
    }
  }
}
```

Use `node` + absolute path to local `dist/main.js` for dev iteration. The README's `npx github:yuniko-software/minecraft-mcp-server` form re-clones from GitHub on each run and skips local changes — don't use it during development.

**Fully quit Claude Desktop** (from system tray / menu bar, not just close the window) and reopen after editing the config.

### Verify
Prompt Claude Desktop: *"What is the bot's position in Minecraft?"* Claude should call `get-position` and `ClaudeBot` should appear in the world.

### Troubleshooting
- MCP logs:
  - macOS: `~/Library/Logs/Claude/mcp-server-minecraft.log`
  - Windows: `%AppData%\Claude\logs\mcp-server-minecraft.log`
- Confirm port matches the server's actual port.
- Confirm absolute path to `dist/main.js` is correct and the file exists.
- Watch the Minecraft server console for kick/connect messages.

---

## 8. The reactive vs. autonomous distinction

**Current**: the MCP server is **reactive**. Tools are idle until Claude Desktop (driven by your prompt) calls them. There is no autonomous loop. If you don't prompt Claude, the bot stands still.

**Goal for "run indefinitely on triggers"**: a second process that owns its own bot and decides when to act.

### Recommended architecture: standalone agent process

Don't bolt autonomy onto the MCP server itself — Claude Desktop owns its lifecycle and stdio, you'd fight the transport. Instead, add a parallel Node entry point that reuses the same primitives.

```
src/
  agent/
    main.ts                # CLI entry: `npm run agent`
    triggers.ts            # Trigger definitions + dispatcher
    loop.ts                # Polling loop + LLM call orchestration
    tools-as-functions.ts  # Reuse tool logic without MCP wrapping
```

Refactor existing tools so the *handler* is separable from MCP *registration*:
```ts
export const getPositionHandler = async (bot) => ({ x: bot.entity.position.x, ... });
export function registerMovementTools(factory, getBot) {
  factory.registerTool('get-position', schema, () => getPositionHandler(getBot()!));
}
```
Both the MCP server and the agent loop call `getPositionHandler` — no duplication.

### Trigger taxonomy

| Trigger | Detection |
|---|---|
| Player addresses bot | New `MessageStore` entry mentions `ClaudeBot` |
| Player nearby | `bot.nearestEntity(e => e.type === 'player')` distance < N |
| Low HP | `bot.health < 10` (event `'health'`) |
| Night falls | `bot.time.timeOfDay` crosses 13000 |
| Got hit | Event `'entityHurt'` where entity is bot |
| Idle check-in | No trigger fired for N minutes |
| Inventory change | Events `'playerCollect'` / `'itemDrop'` |

Each trigger needs a cooldown so it doesn't fire every tick.

### Loop sketch

```ts
while (true) {
  const events = drainEventQueue();
  const fired = triggers.evaluate(events, bot);
  if (fired.length === 0) { await sleep(500); continue; }

  const ctx = snapshotContext(bot, messageStore);
  const decision = await callClaude({
    system: AGENT_SYSTEM_PROMPT,
    user: renderTriggerContext(fired, ctx),
    tools: BOT_TOOL_SCHEMAS,
  });

  for (const call of decision.tool_calls) {
    await executeBotTool(call, bot);
  }
  await sleep(200);
}
```

`callClaude` = Anthropic SDK with tool use. Tool schemas mirror existing MCP tools 1:1 (Zod → JSON Schema).

### Running the agent
```bash
npm run agent -- --host localhost --port 25565 --username ClaudeBot --anthropic-key $ANTHROPIC_API_KEY
```

`BotConnection.checkConnectionAndReconnect()` already handles reconnects, so the bot can stay alive for hours.

### Safety / cost
- **Rate limit**: cap LLM calls to e.g. 1 per 5s + hourly ceiling.
- **Cooldowns** per trigger.
- **Kill switch**: a chat command like `!stop` from any player sets a flag that halts the loop.
- **Log to stderr**, never stdout (keep the convention).
- **Token budget**: send only what's needed (last N chat lines, position, HP, time, nearby entities), not full world state.

---

## 9. Simple Voice Chat integration (future)

Not in scope for current text-only setup. Captured here for when the time comes.

### Where to look in `../simple-voice-chat`
- Server-side plugin API: `api/src/main/java/de/maxhenkel/voicechat/api/`
- A Bukkit/Paper or Fabric/Forge companion plugin would:
  - Register via `BukkitVoicechatService` (Bukkit) or platform-equivalent
  - Subscribe to `MicrophonePacketEvent` for inbound audio
  - Use `VoicechatServerApi.createAudioChannel(...)` + `AudioPlayer` to emit outbound audio anchored to the bot entity

### Build / requirements
- SVC builds with Gradle: `./gradlew build` from the SVC repo root.
- The `api` subproject is the thinnest dependency for a companion plugin.
- SVC subprojects: `api, common, common-client, common-proxy, fabric, fabric:api-stub, neoforge, forge, bukkit, paper, velocity, bungeecord`.
- SVC requires UDP `24454` open and server-side install — **Open-to-LAN singleplayer will NOT load SVC**. Needs a real dedicated server (Paper or Fabric) + companion bridge plugin.

### Pipeline (intended)
1. SVC plugin captures Opus packets from `MicrophonePacketEvent` (also `MicrophonePacket.getOpusEncodedData()`, `AudioListener` / `PlayerAudioListener`).
2. Decode Opus → PCM → STT (whisper.cpp local or OpenAI/Deepgram/Groq API).
3. Transcripts + speaker identity flow into this MCP server (likely a new `read-voice` tool fed by a parallel `TranscriptStore` mirroring `MessageStore`).
4. LLM decides to respond.
5. TTS (Piper/Coqui local or ElevenLabs/OpenAI) → Opus encode → ship frames back to SVC for playback via `AudioChannel` / `AudioPlayer` on a `LocationalAudioChannel` or `EntityAudioChannel` anchored to the bot.

### The JVM ↔ Node bridge
Doesn't exist yet. Likely a small JVM-side companion plugin that talks to this Node process over stdio/HTTP/WebSocket — mirroring how `BotConnection` brokers between Mineflayer events and MCP tools today.

---

## 10. Out of scope (for current text-only setup)

- Anything in `../simple-voice-chat`
- Audio capture/playback, Opus, STT, TTS, Gradle, Java
- New MCP tools beyond those already in `src/main.ts`
- Edits to `src/stdio-filter.ts`

---

## 11. "Done" checklist for current setup

- `npm install`, `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm test` all green.
- Claude Desktop shows the `minecraft` server under its MCP tools panel.
- `ClaudeBot` joins the world and `get-position` returns coordinates when prompted.

---

## 12. Quick reference

| Thing | Value |
|---|---|
| Minecraft version | 1.21.11 Java Edition |
| Node version | ≥ 20.10.0 |
| Default bot username | `ClaudeBot` (configurable via `--username`) |
| Default port (this server CLI) | `25565` (Vanilla/Fabric default; LAN games randomize) |
| SVC UDP port | `24454` |
| MCP transport | stdio |
| Build output | `dist/main.js` |
| Existing tools | text chat (`send-chat`, `read-chat`), position, movement, mining, etc. — see `src/tools/` |
