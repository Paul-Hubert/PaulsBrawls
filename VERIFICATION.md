You are verifying the God-Body integration in pauls-brawls just landed by another agent. Your job:
prove every claim in GOD_BOT_INTEGRATION_PLAN.md §11 ("Testing & verification") holds end-to-end.

Constraint: you may run builds, read code, edit files to fix what's broken, and run the dedicated
server + bridge + a test client (mineflayer or otherwise) to drive the system. You may NOT skip a
check by inspection — every test below must produce concrete evidence (a log line, a tool-result,
a screenshot, an inventory diff). If a check is impossible in your environment, say so explicitly
and don't pretend it passed.

# 0. Environment

Read first:
  - GOD_BOT_INTEGRATION_PLAN.md (the contract)
  - CLAUDE.md (project conventions)
  - These specific files, since they implement the contract:
      src/main/java/com/paul/brawl/{BridgeConfig,BotBridgeClient,GodBody,GodActionQueue,
        GodScheduler,GodSessionManager,ChatBot,ChatBotFunctions,ChatBotActions,
        ChatCommand,ServerEntryPoint,LLMCommand,JsonSchemaAdapter,OptionalField}.java
      C:/Users/Paul/Desktop/minecraft-mcp-server/src/bridge/{main,server,actions}.ts
      C:/Users/Paul/Desktop/minecraft-mcp-server/src/bot-connection.ts (version pin)
      prompt.txt (the God body section)

Prerequisites:
  - $env:OPENAI_API_KEY is set.
  - A dedicated Fabric 1.21.1 server is reachable (NOT Open-to-LAN — it must op the bot).
    If you don't have one, set one up: vanilla fabric-server-launch.jar + fabric-loader, drop
    the built mod into mods/, set online-mode=false, start it. Note the port.
  - Node 20+ for the bridge.

# 1. Static checks (cheap, do these first)

  1a. `./gradlew build` resolves with the LangChain4j stack and produces a remapped jar.
      Expected: BUILD SUCCESSFUL; jar copied to mods/ via copyToMods.
  1b. Greps that must return zero hits (Phase-0 / migration hygiene):
        rg "com\.openai"      src/main/java/com/paul/brawl
        rg "previousResponseId" src/main/java/com/paul/brawl
        rg "ClaudeBot"        src/main/java/com/paul/brawl   (default bot name is LLMBot, not ClaudeBot)
  1c. Node side: `npm run lint && node ./node_modules/typescript/bin/tsc --noEmit src/bridge/*.ts
      --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop
      --skipLibCheck --isolatedModules` — only errors should be inside node_modules/@types/node
      (pre-existing upstream lib mismatch), nothing in src/bridge/.
  1d. Confirm bot-connection.ts has SUPPORTED_MINECRAFT_VERSION = '1.21.1' (not '1.21.11').
  1e. Confirm BridgeConfig.idleTimeoutSeconds (default 90) > waitMaxSeconds (default 30) — this
      invariant is load-bearing for the Wait deferral story (§6c, §10).

# 2. Boot + connection + op

  2a. Start the dedicated server. Start the bridge:
        npm run bridge -- --host <mc-host> --port <mc-port> --username LLMBot --bridge-port 8765
      Confirm in stderr: "bridge listening on http://127.0.0.1:8765" and "Bot spawned in world".
  2b. `curl http://127.0.0.1:8765/health` → `{"ok":true,"detail":{"connected":true,"username":"LLMBot",
      "position":{...}}}`.
  2c. Op check: the JOIN hook in ServerEntryPoint should op LLMBot automatically. Run
      `op` (with no args) in the server console — LLMBot must appear in the operator list.
      If not, the username/config don't match — fix BridgeConfig.botUsername or the --username flag.
  2d. Manual /tp via bridge:
        curl -X POST http://127.0.0.1:8765/appear -H 'content-type: application/json'
             -d '{"x":0,"y":80,"z":0}'
      → bot teleports to (0,80,0). Verifies op + /tp.

# 3. Phase-0 regressions still pass (cheap sanity)

  3a. /llm prints status, lists openai/lmstudio/ollama. /llm provider <name> switches; first prayer
      under each succeeds. Skip lmstudio/ollama if not installed but say so.
  3b. /pray salut → French reply from God, NO tool calls (verify in mod logs:
      "function_call(s)=0"), bot does NOT appear (this is the §5 "no-show path" fix).
  3c. /pray donne-moi un diamant → diamond in inventory; logs show Reward fired; bot appears
      first (Appear tool), nods, then vanishes on the terminal turn. Memory replays cleanly —
      no "tool_call without tool_result" errors from the model.
  3d. /prouver <text> ships a screenshot; verify the model received it (look for image content
      in the request log or its response acknowledging the image).
  3e. /construire <text> triggers BuildPlan → sub-agents place blocks via the textual scanner.

# 4. The four new tools

  4a. Appear — defaults
        /pray apparais devant moi
      Expected: bot /tp's ~3 blocks along your look direction at your Y, facing you. Verify by:
      - Standing at a known spot, looking +X. Bot should land at (you.x + 3, you.y, you.z).
      - Rotate 90° and pray again. Bot should land along the new look direction.
      Confirms GodBody.appear's yaw math (§6b).
  4b. Appear — clamps
        Issue an Appear with distance:100 via /llm or by prompting God explicitly. Verify the
        bot still spawns at distance ≤ appearMaxDistance (default 6). Repeat with negative.
  4c. Vanish
        After Appear, ask God to leave deliberately. Bot /tp's to the parking spot (default
        0,-64,0); GodSessionManager.isBusy() returns false; next prayer succeeds.
  4d. Wait — non-blocking deferral
        /pray apparais, attends 5 secondes, puis frappe-moi
        Expected timeline:
          t=0   Appear, swing/idle pose, NO further LLM request scheduled
          t=5   Punishment fires (lightning at player), bot swings
          t=~6  Terminal turn, vanish
        Verify:
          - There is no LLM API call between t=0 and t=5 (check llm-worker logs).
          - The idle watchdog does NOT fire during the wait (logs would say
            "Idle watchdog fired"). idleTimeoutSeconds (90) >> waitMaxSeconds (30) by design.
  4e. Wait — clamp
        Ask God for Wait(seconds: 9999). Verify the actual delay is waitMaxSeconds (30) by
        timing the LLM-call gap.
  4f. SpawnCreature
        /pray fais surgir 3 vaches près de moi
        Expected: exactly 3 minecraft:cow entities spawn within a few blocks of you. Verify
        with F3: at most BridgeConfig.spawnCountMax (default 8). Bridge has no /spawn endpoint
        (mod-side path); confirm by `rg spawn src/bridge/` returning no handlers.
  4g. SpawnCreature — bad entity id
        Force-call with entityType: "minecraft:nonexistent". The tool result must be the
        French error string "Spawn annulé : type d'entité inconnu" and the chain must continue
        (model gets the error, can react). No exception in logs.
  4h. SpawnCreature — griefing toggle
        /llm bridge griefing true ; spawn a creeper. It may damage terrain.
        /llm bridge griefing false ; spawn a creeper. Terrain stays intact (the MobEntity.
        setCanPickUpLoot(false) is the cheap knob; this is best-effort, document any gaps).

# 5. Avatar invulnerability (§6d)

  5a. With God present (Appear fired), summon a hostile mob next to the bot:
        /summon minecraft:zombie ~ ~ ~ {Health: 100f}
      Bot must take zero damage; the mob hits but the HP bar in `data get entity LLMBot` does
      not move. Set fire next to it (`fill`-place lava) — `bot.extinguish()` clears fire ticks
      immediately on Appear; verify Fire ticks stay 0.
  5b. After Vanish (or zero-tool terminal): re-issue the same hostile-mob test. The bot DOES
      take damage now — Invulnerable NBT tag is back to 0. This is the "restoreAvatar on every
      exit path" guarantee.
  5c. Repeat 5b after the depth-cap exit (force a runaway loop by prompting God to call a tool
      forever) and the idle watchdog (start a session, walk away for >90 s). Bot must be mortal
      again after both.

# 6. Busy lock (§5)

You need a second player or a second mineflayer client connected as a regular player.

  6a. Player A prays; God Appears. While the session is live (before terminal turn), Player B
      prays. Expected for B:
        - immediate text from the mod: "Dieu : (occupé ailleurs — je t'écoute, mais sans forme.)"
        - LLM still answers in B's chat (bodiless)
        - bot does NOT teleport to B; stays with A
        - GodSessionManager.currentOwner() == A.uuid throughout
  6b. After A's session ends naturally, B can claim. Verify by B's next prayer triggering an
      Appear that teleports the bot to B, not back to A.
  6c. Re-entrant claim: A prays again mid-encounter. Idle timer resets but the avatar stays
      put — no double-Appear.

# 7. Termination / exit hygiene

For each of these, confirm BOTH the bot vanishes AND Invulnerable NBT goes back to 0:

  7a. Natural terminal: zero-tool-call response on the last turn.
  7b. Explicit Vanish from the model.
  7c. Depth cap: prompt God in a way that loops (e.g. "After each reward, give another reward
      immediately"). Verify the depth-cap log line at MAX_FUNCTION_CALL_DEPTH=100, the
      "chaîne d'appels coupée" message to the player, and avatar cleanup.
  7d. API error: temporarily break the LLM client (e.g. /llm apikey garbage; /llm reload) mid-
      session. The chain throws; logApiError fires; avatar cleanup runs.
  7e. /pray stop while a session is live: same cleanup.
  7f. /godbody off (admin kill-switch): everything in the GodActionQueue is dropped, the
      scheduled Wait (if any) is left to expire but BridgeConfig.enabled=false silences bridge
      calls, session lock released. Re-enable with /godbody on.

# 8. Bridge resilience (§10)

  8a. Kill the Node bridge mid-session (Ctrl-C). Prayers must still resolve server-side:
      - tool results land (diamond appears, lightning strikes)
      - logs show "bridge /chat failed" / "bridge /appear failed" warnings, NOT exceptions
        bubbling into the LLM chain
      - the mod does NOT deadlock waiting for the bridge
  8b. Restart the bridge. Next prayer attaches cleanly; bot re-ops on JOIN.

# 9. Thread safety (§7)

  9a. Spawn-burst test: prompt God to call SpawnCreature with count=8 many times back-to-back.
      Confirm:
      - MAX_PER_TICK=8 is respected: in a tick where the queue is full, only 8 entities spawn,
        the rest roll to the next tick — verify by adding a temporary debug log inside the
        ServerTickEvents.END_SERVER_TICK drain (count items drained per tick) or by reading
        GodActionQueue.size() between ticks.
      - No ConcurrentModificationException or chunk-thread warnings in the server log.
  9b. Reward + SpawnCreature in the same response: both must produce results in order (the
      model's tool_result message list mirrors the request order). Verify by inspecting the
      ChatMemory snapshot or by giving them visibly different effects.

# 10. Session-mgmt configuration round-trip

  10a. `/llm bridge` prints BridgeConfig.describe().
  10b. `/llm bridge waitmax 60` sets the cap AND bumps idleTimeoutSeconds to at least 65 (the
       LLMCommand handler enforces the invariant). Restart the server: bridge_config.properties
       persisted the values.
  10c. `/llm bridge idle 10` (where waitmax is 60) is rejected with "idle timeout must exceed
       waitMax".

# 11. Multi-player chat visibility

  11a. While God is manifested for A, have B stand within chat range. When God speaks, B sees
       the line in public chat (via GodBody.say → POST /chat → bot.chat). A also sees it via
       ChatPrinter.sendMessage. Bodiless prayers (B's) should NOT appear in public chat — only
       in B's player chat.

# Final report

Produce a markdown table with one row per numbered check (1a, 1b, …) with columns:
  ID | Check | Status (PASS / FAIL / SKIP-with-reason) | Evidence (log line, file:line, screenshot path)

Then a short prose section listing every FAIL, what the symptom was, the suspected root cause, and
the smallest fix you can think of. If everything passes, say so plainly and stop — do not invent
follow-ups.
