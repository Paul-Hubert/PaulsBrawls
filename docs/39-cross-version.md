# 39 — One mod, several Minecraft versions (1.21.1 and 26.1.2)

Status: **set up, 26.1.2 not ported** (2026-11-03). 1.21.1 builds, tests and runs from the new layout exactly as
before (same jar entries, same `fabric.mod.json`, 1137 tests, the mixins checked on the dev server). 26.1.2 resolves
its dependencies and compiles the shared sources with **178 errors in 30 files** (§4). The as-built Gradle layout is
[docs/system/platform/build-and-runtime.md](system/platform/build-and-runtime.md) ("One project per Minecraft version").

## 1. Decisions (Paul, 2026-11-03)

- **Fabric only, no Architectury.** Architectury's 26.x line is Fabric + NeoForge (Forge is gone), it would be one
  more required mod on every server and client, and NeoForge bundles jars and loads classes differently (JarJar, Java
  modules), which the LangChain4j / OkHttp / Kotlin pile would have to survive. If NeoForge is ever wanted, it is one
  more thin project next to the Fabric ones: the shared code already has no loader in it beyond Fabric API calls.
- **Mojang's names first.** Minecraft 26.1+ ships unobfuscated and Fabric dropped Yarn, so the 1.21.1 code moved to
  Mojang's official names (`2167bea`, Loom's `migrateMappings`). The two versions now share their names, and what
  differs is only real API change.
- **26.1.2, not the newest (26.3).** The bots (Squad, the unified bridge) must match the server's version exactly, and
  mineflayer 4.39 (the newest, already installed) joins up to 26.1 (protocol 775, which 26.1.1 and 26.1.2 share).
  Move to a newer version when mineflayer does.
- **Gradle downloads JDK 25** (the foojay toolchain resolver, into `~/.gradle/jdks`); nothing is installed
  system-wide. Each version compiles, tests and runs on its own Java (21 or 25) whatever JVM Gradle runs on.

## 2. The layout

```
src/                      shared: every class that compiles on every version (all of it, today)
gradle/mod.gradle         the build every version shares
versions/1.21.1/          remapping Loom, Mojang mappings, Java 21: production
versions/26.1.2/          plain Loom (nothing remapped), Java 25: being ported
  build.gradle, gradle.properties, src/main/java/…  (the version's own classes, when one differs)
```

- `mc_versions` (root `gradle.properties`) picks the versions that build; the first is the primary one, the only one
  with `runServer`, `runDevServer`, `runClient` and `mcpProbe` (Gradle runs a command-line task in every project that
  has it). `build` and `test` run in every included version, so a shared change is tested on all of them.
- While 26.1.2 is ported it stays out of `mc_versions`; work on it with
  `./gradlew -Pmc_versions=1.21.1,26.1.2 :26.1.2:compileJava`. Its `build.gradle` lifts javac's 100-error cap.
- IntelliJ cannot put one source folder in two modules: with both versions in `mc_versions` it shows `src/` under one
  of them. Import with the default `mc_versions` for everyday work.

## 3. Porting a file

1. **Keep the file shared whenever possible.** Move only the lines that differ into a small per-version class with the
   same name and signatures in each `versions/<v>/src/main/java` (one package for them, `com.paul.brawl.compat`), and
   call it from the shared file. Example: `Compat.hasPermission(source, 2)` over 1.21.1's `source.hasPermission(2)` and
   26.x's permission sets.
2. **A type that was renamed** (`ResourceLocation` → `Identifier`) cannot appear in a shared signature. Keep it inside
   the compat class (take and return `String` ids or the objects both versions share), or use `var` locally.
3. **Only when most of a file differs**, move the file itself into each version's `src/` (it then exists once per
   version and must be kept in step by hand; say so in its header).
4. Never `if (version …)` at run time: each version's jar contains only its own code.
5. Mixins: a target that moved (26.x `AbstractArrow` is in `…projectile.arrow`) needs the mixin class per version,
   or a compat-free target. Check every mixin at run time, as for the migration (a bot joins, an arrow hits, the bot
   is killed), because a missing target fails only when the class loads.

## 4. The 26.1.2 catalogue (first compile, `main` only)

javac reports in phases, so fixing these will show more; `client` and `test` are not compiled yet.

| File | Errors | | File | Errors |
|---|---|---|---|---|
| `ChatBotActions` | 28 | | `PlayerPersistentState` | 9 |
| `squad/Squad` | 21 | | `MinecraftBuildWorld` | 8 |
| `squad/SquadCommand` | 17 | | `FlagManager` | 6 |
| `squad/SquadSpawn` | 14 | | `squad/SquadBinding`, `PlayerDataCollector` | 5 each |
| `squad/SquadTriggers`, `squad/SquadLook` | 10 each | | 20 more files | 1–4 each |
| `VillageHttpListener` | 9 | | | |

What changed, by count:

| Change in 26.1.2 | Errors | Where it hits |
|---|---|---|
| `CommandSourceStack.hasPermission(int)` gone: permission sets (`net.minecraft.server.permissions`) | 25 | every command's `.requires` |
| `ResourceLocation` → `Identifier` | 23 | item ids, registries, the image payload |
| `GameProfile.getName()` / `getId()` gone (a record now) | 18 | profiles in Squad, op-on-join |
| `ServerPlayer.getServer()` (12) and `serverLevel()` (7) gone | 19 | Squad, ChatBotActions |
| `AbstractArrow` moved to `world.entity.projectile.arrow` | 8 | `AbstractArrowMixin`, `SquadTriggers` |
| `Inventory.items` / `selected` / `armor` / `offhand` private (accessors) | 13 | Squad kits, ChatBotActions |
| NBT getters return `Optional` (`getString`, `getInt`, `getCompound`) | 7 | `PlayerPersistentState`, `SquadBinding` |
| `ClickEvent` / `HoverEvent` are records per action, no constructor | 8 | chat links |
| `GameProfile` → `NameAndId` for the whitelist and op list | 4 | op-on-join, squad spawn |
| `InteractionResultHolder`, `MobSpawnType` (→ `EntitySpawnReason`), `getMin/MaxBuildHeight`, `moveTo`, `START_WORLD_TICK` | ~10 | various |

## 5. What is left, in order

1. **Port `main`** (§3, §4), then `client` and the tests (`SquadBindingTest` reads NBT), until
   `-Pmc_versions=1.21.1,26.1.2 build` is green with both versions' tests.
2. **A 26.1.2 dev server** of its own: a directory (`dev-26.1.2/`) with its own ports (game, RCON, the settlement
   listener, the God MCP, Squad), copied from `dev/`, and a `runDevServer26` run in `versions/26.1.2/build.gradle`
   (named so it never collides with the primary's). Then the mixin check (§3.5).
3. **The bots, one version per runtime:** Squad hard-codes 1.21.1 in `SUPPORTED_MINECRAFT_VERSION`
   (`squad/src/bots/pool.ts`), the protocol hardening keyed on `'1.21'` (`bots/protocol.ts`), the arrow constants read
   from the 1.21.1 jar (`aim/arrow.mjs`), the chunk decoder (`world/decode.mjs`, the format changed in 1.21.5), the
   block-state tables, and three `patch-package` patches. Make the version a setting (`squad.json`
   `minecraft.version` already exists) and key those by version; run the live tests on the 26.1.2 dev server. The
   unified bridge pins it too (`minecraft-mcp-server/src/bot-connection.ts`). Eden is dead code: not ported.
4. **The server's other mods** for 26.1.2 (WorldEdit, Simple Voice Chat) in `scripts/setup-server.mjs`
   (`--mc=26.1.2` refuses without `--no-extras` until then).
5. **Add 26.1.2 to `mc_versions`.** From then on every shared change must compile on both.
