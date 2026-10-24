# Prompt: test the god/builder MCP servers and the external agents on Paul's machine

> Paste everything below the line into a Claude Code session started in the repo on the Windows machine
> (`claude` in the `PaulsBrawls` folder, PowerShell). It works with you: it runs the commands, and asks you for the
> steps only a human with a Minecraft client can do.

---

You are testing, on a real Windows machine with a real Minecraft client, the AI-God work on branch `rework`:
- the `god` and `builder` MCP servers the Fabric mod hosts on `127.0.0.1:8771` when `godAgent=external`;
- the two external agent backends (`agentKind=opencode` and `agentKind=claude-code`);
- `/construction ticket`, which lets an interactive Claude Code session build.

Everything so far was verified only in a Linux container, with no Minecraft client and no second player. Your job
is to find what breaks for real, fix it, and record the results.

## Read first
- `CLAUDE.md` (orientation and gotchas, especially the Fabric mod / AI God gotchas).
- `docs/27-god-builder-mcp-design.md` (the design).
- `docs/system/aigod/mcp-servers.md`, `external-agent.md`, `mcp-test-bench.md`.
- `god-agent/README.md` (how both agents and an interactive Claude Code session plug in).
- The latest entries of `docs/PROGRESS.md`.
- `docs/26-god-builder-mcp-prompt.md` §6 (the in-game checklist you will finally run).

## Rules
- **Branch.** Work on `rework`: `git pull` first, then commit and push there. No pull request.
- **Hands off.** Never touch `eden/`, `docs/system/eden/` or `minecraft-mcp-server/`.
- **Every commit.** One logical change, with its test and its docs (docs/system pages, CLAUDE.md, PROGRESS). After
  doc edits, run `node docs/system/build-index.mjs` and then `node docs/system/build-index.mjs --check`.
  `.\gradlew build` must stay green.
- **Never commit secrets or generated files.** Not `run/god_agent.properties`, not tokens, not `logs/`, not
  `run/world/`.
- **Player strings stay French.** Do not remove the builtin ChatBot loop, even if everything passes. That decision
  is Paul's, in a separate step.
- **Dev server only.** Use `.\gradlew runServer` in `run/` (port 25599). Do not touch the production server or world
  in `C:\Users\Paul\Desktop\PaulsBrawlsVanilla\` unless Paul explicitly asks.
  - Both servers use RCON port 25575, and `runServer` also takes the `:8767` settlement port (R29). If the
    production server is running, ask Paul to stop it, or change `rcon.port` in `run/server.properties` for the
    session only (do not commit it).
- **Cheap models.** For real-model runs use a cheap one (e.g. `claudeModel=haiku`), and say how many turns you ran.
- **Report honestly.** Anything not run is reported as NOT RUN.

## Steps

### 1. Prerequisites (report each with its version)
- `java -version` gives 21.
- `.\gradlew --version` gives Gradle 8.14 or newer (Loom 1.11 needs it). If there is no wrapper, or an older one,
  run `gradle wrapper --gradle-version 8.14.3`. The wrapper is gitignored.
- `git config core.autocrlf` (just report it).
- `node -v` and `claude --version`. Run `where.exe claude`: if it resolves only to `claude.cmd` (an npm install),
  note it. The mod launches `claudeBin` with Java's `ProcessBuilder`, which cannot start a `.cmd` file. See step 6.
- `opencode --version`, if installed (`npm i -g opencode-ai`).
- Check that the two mods folders in `gradle.properties` exist.

### 2. Build and tests
1. Run `.\gradlew build` with no flags, exactly as Paul does. It must be green. It also copies the jar into both
   mods folders: check the timestamps.
2. Run the end-to-end suites too. Use the `.exe` or the opencode entry point you found in step 1:
   ```powershell
   $env:CLAUDE_BIN = (Get-Command claude).Source
   $env:OPENCODE_BIN = (Get-Command opencode).Source
   .\gradlew test --rerun
   ```
3. Report the totals from `build\test-results\test\*.xml` (currently 974, of which 22 are e2e).
4. Any failure that happens only on Windows is a real bug: fix it (paths, CRLF, process launch, command-line
   length, locale). Commit and push.

### 3. Dev server with the MCP servers
1. Create `run/god_agent.properties` (do not commit it):
   ```properties
   godAgent=external
   agentKind=claude-code
   claudeModel=haiku
   ```
2. Copy `god-agent/` (including the hidden `.mcp.json` and `.claude/`) into `run/god-agent/`. `claudeDir` is
   resolved from the server's working directory.
3. Run `.\gradlew runServer` in a separate terminal. Wait for `MCP servers on http://127.0.0.1:8771 (/mcp/god,
   /mcp/builder)`. Read the generated `mcpToken` from `run/god_agent.properties`.
4. Run `.\gradlew mcpProbe -PmcpToken=<token>`. It must end with `ALL PASS`.
5. For God's body (appear/vanish), the unified bridge must be running with the avatar `LLMBot`. Ask Paul whether
   `minecraft-mcp-server` is set up on this machine. If not, test without the body (`/godbody off`) and mark the
   body items NOT RUN.

### 4. Interactive Claude Code as the builder (`/construction ticket`)
1. Register the servers:
   ```powershell
   claude mcp add --transport http builder http://127.0.0.1:8771/mcp/builder --header "Authorization: Bearer <token>"
   claude mcp add --transport http god http://127.0.0.1:8771/mcp/god --header "Authorization: Bearer <token>"
   claude mcp list
   ```
   Both must show `✔ Connected`.
2. Ask Paul to join the dev server (`localhost:25599`) with the PrismLauncher client, op himself from the server
   console (`op <name>`), look at a block, then run `/construction` and `/construction ticket 30`. Check that the
   ticket appears only to him, that clicking copies it, and that it shows the pivot.
3. With that ticket, in a separate Claude Code session (or `claude -p`), build a small structure. For example, a
   5×5 stone floor, four 4-high oak log pillars, and an oak stairs roof edge (`minecraft:oak_stairs[facing=north]`).
   Use `mcp__builder__*` only.
4. Verify the blocks really are in the world. Use the server console, or RCON on `run/server.properties`'s port:
   `execute if block <x> <y> <z> minecraft:stone`, at several absolute positions computed from the pivot. Have Paul
   confirm visually.
5. Check the limits:
   - a 129-block `place_line` is refused;
   - a fifth `begin_sub_build` is refused while 4 are open;
   - `/construction ticket revoke` makes the next tool call fail;
   - `/godbody off` kills a fresh ticket.
6. Watch the server log for "Can't keep up!" during a build of a few hundred blocks.

### 5. In-game checklist (docs/26 §6), with the external agent
Run every item of `docs/26-god-builder-mcp-prompt.md` §6 with Paul. A second player is needed for "God is busy":
ask whether a second client or account is available, or connect a scripted Mineflayer bot as the second player.
Record pass, fail or NOT RUN per item, with what you saw.
- **Prayers:** `/pray` in French. Check appear, reward and vanish, a reward with components
  (`enchanted_book[…]`), the clamps, `offer_trade` then `/accept`, an expired offer, and weather and spawn.
- **Kill switch:** `/godbody off` mid-session.
- **Agent dies mid-turn:** kill the `claude` process mid-prayer (`Get-Process claude | Stop-Process`). The player
  must get a French message and the avatar must be restored.
- **Builds:** `/construction` then `/build <text>` from the client, with the screenshot. The builder runs
  sub-builders; the caps hold; the tick stays healthy.
- **Memory:** `/pray reset` and a second prayer that remembers (or not) the first.
- **Body tools:** the Node Mineflayer body tools still work for God.

Repeat a short subset (one prayer and one build) with `agentKind=opencode`. Start
`opencode serve --hostname 127.0.0.1 --port 4096` from `god-agent/`, with `OPENCODE_CONFIG`,
`OPENCODE_SERVER_PASSWORD` and `PAULSBRAWLS_MCP_TOKEN` set as in `god-agent/README.md`.

### 6. Known Windows risk to settle
If `claude` is only `claude.cmd`, either:
- set `claudeBin` to a real `claude.exe` (the native installer), or
- if Paul wants the npm install to work, fix `ClaudeCodeClient`. Resolve `claudeBin` through `PATH`/`PATHEXT`, and
  run a `.cmd`/`.bat` through `cmd.exe /c`. The prayer goes on stdin, so no user text is on the command line. Add a
  unit test for the resolution, and make sure the abort still kills the whole process tree, `cmd.exe` included.

### 7. Wrap up
- Restore `run/` to its tracked state: delete `run/god_agent.properties`, `run/god-agent/`, `run/world/`,
  `run/logs/`, `run/mods/`, `run/ops.json`, `run/usercache.json`, and `git checkout run/server.properties`. Then
  `claude mcp remove builder` and `claude mcp remove god` if Paul does not want to keep them.
- Add a dated `docs/PROGRESS.md` entry (newest first):
  - the machine and versions;
  - the build and test results;
  - every checklist item, as pass, fail or NOT RUN, with evidence;
  - the bugs found and their fix commits;
  - what is left.
  Commit and push.
- End with a short report to Paul: what works, what broke and was fixed, what is still NOT RUN, and whether the
  docs/26 §6 checklist now fully passes. If it does, removing the builtin loop is his call.
