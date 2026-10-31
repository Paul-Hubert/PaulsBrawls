# run/: the production server's folder

`./gradlew runServer` (from the repo root) starts the production server here (port 25565, RCON 25575) with the mod
loaded straight from the source. Loom downloads the Minecraft server into the Gradle cache, so **no server jar belongs
in this folder**. The world is `world/`, Paul's own (since 2026-10-31; before, this was the dev server and production
ran in `C:\Users\Paul\Desktop\PaulsBrawlsVanilla`, which is kept but no longer used).

Dev tests never run here: they use the dev server in `dev/` (`./gradlew runDevServer`, port 25599, dev/README.md),
and the live tests default to it.

`mods/` here holds the extra mods of production (WorldEdit, Simple Voice Chat, Universal Shops). Never put Fabric API
or a built `paulsbrawls` jar in it: Loom already loads both, and a second copy crashes the server.

For a standalone server (a Fabric launcher, the mods, start scripts), run `node scripts/setup-server.mjs` instead. It
builds one in `server/` (see the header of that script).
