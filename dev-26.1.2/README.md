# dev-26.1.2/: the dev server (Minecraft 26.1.2)

The dev-test server for the 26.1.2 build of the mod, the default version since 2026-11-04 (docs/39). From the repo
root:

```powershell
./gradlew runDevServer
```

Like `runServer` for production (`run-26.1.2/`), Loom downloads the 26.1.2 server into the Gradle cache and loads the
mod straight from the source (no server jar and no `paulsbrawls` jar belong here), on Java 25 (Gradle fetches it into
`~/.gradle/jdks`). Its world (`world/`) is generated at the first start and is a scratch world. The 1.21.1 dev server
is `dev/` (`./gradlew "-Pmc_versions=1.21.1" runDevServer`).

It runs beside the other servers without a clash:

| | dev-26.1.2/ | dev/ (1.21.1) | run-26.1.2/ (production) |
|---|---|---|---|
| Minecraft | 25602 | 25599 | 25565 |
| RCON | 25579 | 25576 | 25575 |
| Trade-settlement listener (`village_config.properties`) | 8778 | 8777 | 8767 |
| God MCP servers (`god_agent.properties` `mcpPort`, external mode only) | 8782 | 8781 | 8771 |
| Squad (`squad.properties`) | the dev runtime on :8783 (`cd squad; npm run start:dev`, `squad/squad-dev.json`) | off | the runtime on :8772 (`npm start`) |
| God-Body bridge and MCP tools (`bridge_config.properties`, `mcp_config.properties`) | off | on (:8765) | on (:8765) |

The unified bridge's `LLMBot` cannot join 26.x yet (its mineflayer is 4.35; 26.1 needs 4.39, docs/39 §5), so the
bridge is off here. Ports 25601, RCON 25578 and 8780 are the docs/36 bench worktree's.

`runDevServer` writes those five configs at its start when they are missing (`versions/26.1.2/build.gradle`), copies
the repo root's `prompt.txt` and `build_prompt.txt`, and copies `server.defaults.properties` to `server.properties`; it
never touches an existing file. Change a setting for everyone in `server.defaults.properties`; `server.properties` stays
local because 26.x writes a generated `management-server-secret` into it (the management server itself is off).
`mods/` here is only for extra mods built for 26.1.2 (none yet: the 1.21.1 WorldEdit in `dev/mods/` does not load on
26.x). Never put Fabric API or a built `paulsbrawls` jar in it.

Only this README, `server.defaults.properties` and `eula.txt` are tracked; the rest (the world, logs, the configs,
`server.properties`) is local.
