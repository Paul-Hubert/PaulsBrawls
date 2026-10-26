# run/: the dev server's folder

`./gradlew runServer` (from the repo root) starts a dedicated server here with the mod loaded straight from the
source. Loom downloads the Minecraft server into the Gradle cache, so **no server jar belongs in this folder**. It
listens on port 25599 (see `server.properties`).

`mods/` here is only for extra mods (WorldEdit, …). Never put Fabric API or a built `paulsbrawls` jar in it: Loom
already loads both, and a second copy crashes the server.

For a standalone server like the production one (a Fabric launcher, the mods, start scripts), run
`node scripts/setup-server.mjs` instead. It builds one in `server/` (see the header of that script).
