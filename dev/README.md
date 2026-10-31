# dev/: the server for dev tests

`./gradlew runDevServer` (from the repo root) starts a dedicated server here with the mod loaded straight from the
source, like `runServer` does for the production server in `run/`. Loom downloads the Minecraft server into the Gradle
cache, so **no server jar belongs in this folder**. Its world (`world/`) is generated at the first start and is a
scratch world: the live tests build arenas in it and kill entities there.

It runs beside production without a clash:

| | dev/ | run/ (production) |
|---|---|---|
| Minecraft | 25599 | 25565 |
| RCON | 25576 | 25575 |
| Trade-settlement listener (`village_config.properties`) | 8777 | 8767 |
| God MCP servers (`god_agent.properties` `mcpPort`) | 8781 | 8771 |
| Squad (`squad.properties`) | off | the runtime on :8772 |

Squad is off here so this server never talks to the production runtime. The live tests (`squad/live-tests/`, which
default to this server) start their own runtime; to test bound items through the mod, set `dev/squad.properties` to
`enabled=true`, `url=http\://127.0.0.1\:8779`, `token=live-test-token`, run the tests with `LIVE_RUNTIME_PORT=8779`,
and set `enabled=false` again afterwards (squad/README.md).

`mods/` here is only for extra mods (WorldEdit, …). Never put Fabric API or a built `paulsbrawls` jar in it: Loom
already loads both, and a second copy crashes the server.

Only this README, `server.properties` and `eula.txt` are tracked; the rest (the world, logs, the configs holding
tokens and keys, `god-agent/`) is local.
