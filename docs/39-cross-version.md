# 39 — One mod, several Minecraft versions (1.21.1 and 26.1.2)

Status: **26.1.2 is the default version** (Paul, 2026-11-04): first in `mc_versions`, production in `run-26.1.2/`
(a copy of the 1.21.1 world, upgraded at its first start), the dev server in `dev-26.1.2/`, Squad on 26.1.2. The
unified bridge, a 26.1.2 client and the extra mods are still open (§5). Both versions build `main`, `client` and the tests from the shared `src/`, and both
pass the same 1137 tests (22 skipped: the E2E tests that need an external binary). What differs lives in two compat
classes and a per-version mixin config (§4). The as-built Gradle layout is
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
versions/1.21.1/          remapping Loom, Mojang mappings, Java 21: the old production (run/, dev/)
versions/26.1.2/          plain Loom (nothing remapped), Java 25: the default (run-26.1.2/, dev-26.1.2/)
  build.gradle, gradle.properties
  src/main/java/com/paul/brawl/compat/Compat.java          what differs, server side (§4)
  src/main/java/com/paul/brawl/mixin/AbstractArrowMixin.java   its target moved package
  src/main/java/com/paul/brawl/mixin/RegistrySyncVanillaClientsMixin.java   26.1.2 only (§4)
  src/main/resources/paulsbrawls.version.mixins.json        the mixins that exist per version
  src/client/java/com/paul/brawl/compat/ClientCompat.java  what differs, client side
run-26.1.2/               the production server on 26.1.2 (run-26.1.2/README.md)
dev-26.1.2/               the dev server on 26.1.2 (dev-26.1.2/README.md)
```

- `mc_versions` (root `gradle.properties`) picks the versions that build; the first is the primary one, the only one
  with `runServer`, `runDevServer`, `runClient` and `mcpProbe` (Gradle runs a command-line task in every project that
  has it). `build` and `test` run in every included version, so a shared change is tested on all of them.
- The default is `26.1.2,1.21.1` (since 2026-11-04): both build and test, 26.1.2 has the runs (`runServer` in
  `run-26.1.2/`, `runDevServer` in `dev-26.1.2/`, `runClient`). A non-primary version's run tasks are disabled
  (`gradle/mod.gradle`), because Loom creates `runServer`/`runClient` before a version's `runs.clear()`.
  `"-Pmc_versions=1.21.1"` makes 1.21.1 primary again (`run/`, `dev/`). In PowerShell quote a `-P` with a version
  in it: Windows PowerShell splits `-Pmc_versions=1.21.1,…` at the first dot and Gradle sees `mc_versions=1`.
  `:26.1.2:build` copies its jar into the PrismLauncher instance "26.1.2"; a plain `build` also copies the 1.21.1
  jar into the 1.21.1 folders.
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
   and so does a mixin only one version has. Those are listed in `paulsbrawls.version.mixins.json`, one per version in
   `versions/<v>/src/main/resources` (both named in the shared `fabric.mod.json`); the shared `paulsbrawls.mixins.json`
   lists only the mixins in `src/`. A target whose signature changed but whose name is unique in its class can be named alone (`PlayerMixin`:
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

**Clients without Fabric (the bots).** 26.1.2's Fabric API (`fabric-registry-sync-v0` 7.1.1) disconnects a client
that cannot take its registry sync, unless every registry with modded entries is marked optional: the coin is in the
item registry, so every mineflayer bot was kicked with "This server requires Fabric Loader and Fabric API installed on
your client!". 1.21.1's (5.3.1) skipped the sync for such a client instead. Fabric API has no switch for it, so the
26.1.2-only `RegistrySyncVanillaClientsMixin` makes `RegistrySyncManager.areAllRegistriesOptional` (whose only caller is
that branch) answer true: no sync and no kick, as on 1.21.1. A vanilla client that is sent a coin gets an item id it
does not know, as on 1.21.1.

What was checked: both versions' 1137 tests; both jars' mixin targets in the bytecode (1.21.1 remapped to
`method_16078`, `method_7454`, `method_24920`; 26.1.2 the Mojang names); the 1.21.1 jar on the dev server (a bot
joins, an arrow hits the ground, the bot is killed, no mixin error, the Gibber state saved). On the 26.1.2 dev server
(2026-11-04, a mineflayer 4.39 bot, `version: '26.1.2'`, protocol 775):

- the bot joins; no mixin or other error in the log;
- permission levels: `/mcp status` and `/bots status` (0) answer, `/gib 3` (2) is an unknown command until the bot is
  op'd, then gives 3 coins (`clear … paulsbrawls:coin 0` finds 3);
- `/village` shows the listener running on 8778;
- capture the flag: a banner named Flag makes its holder glow, a hit drops it (unbreakable) and clears the glow;
- two arrows (one on the ground, one on the bot) and a death: no error, and a non-roster bot drops its coins and items;
- the Gibber state: saved to `world/data/paulsbrawls/gibbers_state.dat` and read back after a restart; on a copy of
  the 1.21.1 dev world, `data/gibbers_state.dat` (DataVersion 3955, `total_revenue` set to 7) was moved to
  `data/paulsbrawls/` and saved again by 26.1.2 with `total_revenue` 7 (DataVersion 4790).

Found on the way, on both versions, and fixed: the coins owed at login were not paid at
`ServerPlayConnectionEvents.JOIN`, because Fabric fires it inside `PlayerList.placeNewPlayer` before the player is in
the player list, so `RevenueManager`'s lookup by UUID was always null ("player is null", in the 1.21.1 production log
too) and the next salary tick paid them instead. `RevenueManager` now pays `handler.getPlayer()`; checked on both dev
servers with an hour-long salary period, so no tick could pay: a new player had its backlog 3 s after joining.

## 5. What is left, in order

1. ~~Port `main`, `client` and the tests~~ (done, §4).
2. ~~**A 26.1.2 dev server**~~ (done, §4): `dev-26.1.2/` (game 25602, RCON 25579, settlement 8778, God MCP 8782,
   Squad and the God-Body bridge off; [dev-26.1.2/README.md](../dev-26.1.2/README.md)) and
   `./gradlew runDevServer` (since 26.1.2 is primary). **Still open:** a 26.1.2 client for `/prove` and
   `/build` (the asynchronous screenshot), from `runClient` or the PrismLauncher instance "26.1.2".
3. **The bots.** Squad runs on 26.1.2: `squad.json` `minecraft.version` (the default, and `SUPPORTED_MINECRAFT_VERSION`
   in `squad/src/bots/pool.ts`, are 26.1.2 since 2026-11-04); `npm run start:dev` (`squad-dev.json`) is the dev
   runtime for `dev-26.1.2/` (port 8783, the mod's `squad.properties` there points at it). Its mineflayer 4.39 joins
   26.1, and the live tests' core group passed on the 26.1.2 dev server (2026-11-04: spawn, gather, come, defend with
   an archer's shots, two ladders, despawn), with the shared world and the reader workers on. Not yet: the live tests
   take the server's version (`MC_VERSION` / RCON `/version`, uncommitted, and not run since), the bound-item and
   range scenarios, the protocol hardening for 26.1 (`bots/protocol.ts` keys only `'1.21'`: no `declare_recipes`
   bypass, the decoders stay alive), the arrow constants read from the 1.21.1 jar (`aim/arrow.mjs`), the unit tests'
   1.21.1 fakes. The unified bridge cannot join 26.x: its mineflayer is 4.35 and it pins 1.21.1
   (`minecraft-mcp-server/src/bot-connection.ts`); 26.1 needs 4.39. Eden is dead code: not ported.
4. **The server's other mods** for 26.1.2 (WorldEdit, Simple Voice Chat) in `scripts/setup-server.mjs`
   (`--mc=26.1.2` refuses without `--no-extras` until then).
5. ~~**Add 26.1.2 to `mc_versions`**~~ (done 2026-11-04, first: the default). Every shared change must compile on both.
