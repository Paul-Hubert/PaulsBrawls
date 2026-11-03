# 39 — One mod, several Minecraft versions (1.21.1 and 26.1.2)

Status: **26.1.2 compiles and passes the tests; not run yet** (2026-11-03). Both versions build `main`, `client` and
the tests from the shared `src/`, and both pass the same 1137 tests (22 skipped: the E2E tests that need an external
binary). What differs lives in two compat classes and one mixin per version (§4). Nothing has run on a 26.1.2 server
or client yet (§5). The as-built Gradle layout is
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
src/                      shared: every class that compiles on every version
gradle/mod.gradle         the build every version shares
versions/1.21.1/          remapping Loom, Mojang mappings, Java 21: production
versions/26.1.2/          plain Loom (nothing remapped), Java 25: compiles and tests, not run yet
  build.gradle, gradle.properties
  src/main/java/com/paul/brawl/compat/Compat.java          what differs, server side (§4)
  src/main/java/com/paul/brawl/mixin/AbstractArrowMixin.java   its target moved package
  src/client/java/com/paul/brawl/compat/ClientCompat.java  what differs, client side
```

- `mc_versions` (root `gradle.properties`) picks the versions that build; the first is the primary one, the only one
  with `runServer`, `runDevServer`, `runClient` and `mcpProbe` (Gradle runs a command-line task in every project that
  has it). `build` and `test` run in every included version, so a shared change is tested on all of them.
- 26.1.2 stays out of `mc_versions` until it has run (§5); test it with
  `./gradlew -Pmc_versions=1.21.1,26.1.2 :26.1.2:test :26.1.2:jar` (not `build`, whose copy tasks fill the 1.21.1 mods
  folders too). Its `build.gradle` lifts javac's 100-error cap.
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
5. Mixins: a target that moved (26.x `AbstractArrow` is in `…projectile.arrow`) needs the mixin class per version.
   A target whose signature changed but whose name is unique in its class can be named alone (`PlayerMixin`:
   `method = "dropEquipment"`, which is `dropEquipment()` on 1.21.1 and `dropEquipment(ServerLevel)` on 26.x; Loom
   still remaps it to `method_16078`), with a handler that takes no target arguments. Check every mixin at run time
   (a bot joins, an arrow hits, the bot is killed), because a missing target fails only when the class loads.
6. A test that reads Minecraft's API goes through `Compat` too: `CompoundTag.getString` compiles on 26.x (it returns
   an `Optional`) and only fails at the assertion.

## 4. The port to 26.1.2 (as built)

The first compile of `main` had 178 errors in 30 files; javac reports in phases, so there were more. `main`, `client`
and the tests now compile and pass on both versions. The shared code calls these instead of what changed:

| What changed in 26.1.2 | Shared code now uses |
|---|---|
| `CommandSourceStack.hasPermission(int)`, `ServerPlayer.hasPermissions(int)` gone: permission sets | `Compat.hasPermission(source or player, level)` |
| `ResourceLocation` → `Identifier`; `ResourceKey.location()` → `identifier()` | `Compat.item(id)`, `entityType(id)`, `key(registry, ns, path)`, `id(key)`, `path(key)`, `registerItem` (26.x needs the key in `Item.Properties`), `payloadType` |
| `GameProfile` a record (`name()`, `id()`); whitelist and op list take `NameAndId`; the user cache is `services().nameToIdCache()` | `Compat.name/id(profile)`, `isOp`, `op`, `whitelist(players, profile, add)`, `cachedProfile(server, name)` |
| `Entity.getServer()`, `ServerPlayer.serverLevel()` gone | `x.level().getServer()`, `(ServerLevel) x.level()`, the same on both (no compat) |
| `displayClientMessage(c, false)` gone | `sendSystemMessage(c)`, on both |
| `Inventory` fields private, armour and off-hand in `EntityEquipment` | `Compat.mainItems(inv)` (the live list), `selectedSlot(inv)`; `getContainerSize()`/`getItem(i)` and `getOffhandItem()` on both |
| NBT getters return `Optional`; `getAllKeys` → `keySet`; `contains(key, type)` gone; `TagParser.parseTag` → `parseCompoundFully` | `Compat.getInt/getString/getBoolean/getCompound/keys(tag…)`, `parseTag(snbt)` |
| `SavedData.Factory` → `SavedDataType` with a codec and an id | `Compat.savedData(server, name, create, load, toTag)` (below) |
| `ClickEvent`/`HoverEvent` are records per action | `Compat.runCommand`, `suggestCommand`, `copyToClipboard`, `showText` |
| `EntityType.create`, `loadEntityRecursive`, `finalizeSpawn` take an `EntitySpawnReason`; `moveTo` → `snapTo` | `Compat.create`, `loadEntity`, `finalizeCommandSpawn`, `moveTo` |
| `getMinBuildHeight/getMaxBuildHeight/getMin/MaxSection` → `getMinY`/`getMaxY` (inclusive) | `Compat.minY(world)` + `getHeight()` (on both); `SquadLook.CopiedView` declares both `getMinBuildHeight` and `getMinY`, without `@Override` |
| `getDayTime()` → `getOverworldClockTime()`, `getTags()` → `entityTags()`, `Unbreakable` → `Unit` | `Compat.dayTime`, `tags`, `makeUnbreakable` |
| Fabric API: `UseItemCallback` returns `InteractionResult`, `START_WORLD_TICK` → `START_LEVEL_TICK`, `PayloadTypeRegistry.playC2S` → `serverboundPlay` | `Compat.watchItemUse`, `onLevelTickStart`, `registerServerboundPayload` |
| `AbstractArrow` moved package | `Compat.isArrow(entity)`; `SquadTriggers` takes a `Projectile`; `AbstractArrowMixin` per version |
| Client: `ClientCommandManager` → `ClientCommands`, `ChatComponent.addMessage` → `addClientSystemMessage`, `Screenshot.takeScreenshot` asynchronous, `NativeImage.asByteArray` gone | `ClientCompat.literal/argument`, `chat`, `screenshot(w, h, png -> …)` (26.x writes the PNG to a temp file) |

**The Gibber state on 26.x.** 1.21.1 keeps it in the overworld's `data/gibbers_state.dat`. 26.x keeps server-wide
data in `<world>/data/<namespace>/<name>.dat`, and its world upgrade moves only vanilla's files, so the 26.x
`Compat.savedData` uses `paulsbrawls:gibbers_state` and, on first use, moves a `data/gibbers_state.dat` it finds
there into `data/paulsbrawls/`. The codec is `CompoundTag.CODEC` with `DataFixTypes.SAVED_DATA_COMMAND_STORAGE` (an
untyped compound to the fixers; a null fix type would make the load fail and start an empty state). Not run yet.

What was checked: both versions' 1137 tests; both jars' mixin targets in the bytecode (1.21.1 remapped to
`method_16078`, `method_7454`, `method_24920`; 26.1.2 the Mojang names); the 1.21.1 jar on the dev server (a bot
joins, an arrow hits the ground, the bot is killed, no mixin error, the Gibber state saved).

## 5. What is left, in order

1. ~~Port `main`, `client` and the tests~~ (done, §4).
2. **A 26.1.2 dev server** of its own: a directory (`dev-26.1.2/`) with its own ports (game, RCON, the settlement
   listener, the God MCP, Squad), copied from `dev/`, and a `runDevServer26` run in `versions/26.1.2/build.gradle`
   (named so it never collides with the primary's). Then the mixin check (§3.5), the commands and their permission
   levels, the coin item, the Gibber state (a fresh world, then a copy of a 1.21.1 world: the move in §4), and a
   26.1.2 client for `/prove` and `/build` (the asynchronous screenshot).
3. **The bots, one version per runtime:** Squad hard-codes 1.21.1 in `SUPPORTED_MINECRAFT_VERSION`
   (`squad/src/bots/pool.ts`), the protocol hardening keyed on `'1.21'` (`bots/protocol.ts`), the arrow constants read
   from the 1.21.1 jar (`aim/arrow.mjs`), the chunk decoder (`world/decode.mjs`, the format changed in 1.21.5), the
   block-state tables, and three `patch-package` patches. Make the version a setting (`squad.json`
   `minecraft.version` already exists) and key those by version; run the live tests on the 26.1.2 dev server. The
   unified bridge pins it too (`minecraft-mcp-server/src/bot-connection.ts`). Eden is dead code: not ported.
4. **The server's other mods** for 26.1.2 (WorldEdit, Simple Voice Chat) in `scripts/setup-server.mjs`
   (`--mc=26.1.2` refuses without `--no-extras` until then).
5. **Add 26.1.2 to `mc_versions`.** From then on every shared change must compile on both.
