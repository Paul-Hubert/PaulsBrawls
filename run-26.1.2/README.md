# run-26.1.2/: the production server, Minecraft 26.1.2

`./gradlew runServer` (from the repo root) starts the production server here (port 25565, RCON 25575) with the
26.1.2 mod loaded straight from the source, on Java 25 (Gradle fetches it into `~/.gradle/jdks`). Loom downloads the
Minecraft server into the Gradle cache, so **no server jar belongs in this folder**. 26.1.2 is the default version
since 2026-11-04 (docs/39); the 1.21.1 production server is kept in `run/` for a rollback
(`./gradlew "-Pmc_versions=1.21.1" runServer`). Never run both: they share the ports.

The world (`world/`) is a copy of `run/world` made on 2026-11-04, before its first 26.1.2 start: the first start
upgrades it to 26.1.2 (the mod moves the Gibber state to `world/data/paulsbrawls/`, docs/39 §4), and `run/world`
stays as it was. The ops, whitelist, bans, user cache, the God's and Squad's configs (`llm_config.properties`,
`bridge_config.properties`, `god_agent.properties`, `squad.properties`, `mcp_config.properties`), `god-agent/` and
the prompts were copied from `run/` at the same time.

- **The bots:** Squad's runtime joins 26.1.2 (`cd squad; npm start`, `squad.json` `minecraft.version` 26.1.2). The
  unified bridge's `LLMBot` (the Java God's body) cannot yet: its mineflayer is 4.35, and 26.1 needs 4.39
  (docs/39 §5).
- `mods/` is for extra mods built for 26.1.2 (none yet: WorldEdit and Simple Voice Chat for 26.1.2 are docs/39 §5
  step 4). Never put Fabric API or a built `paulsbrawls` jar in it: Loom already loads both.
- `server.properties` stays local, because 26.x writes a generated `management-server-secret` into it (the
  management server itself is off); `runServer` copies the tracked `server.defaults.properties` to it when it is
  missing. Change a setting for everyone in `server.defaults.properties`.

Dev tests never run here: they use the dev server in `dev-26.1.2/` (`./gradlew runDevServer`, port 25602,
dev-26.1.2/README.md).
