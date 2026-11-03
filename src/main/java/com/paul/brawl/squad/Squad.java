package com.paul.brawl.squad;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import com.paul.brawl.AgentBackend;
import com.paul.brawl.AgentClient;
import com.paul.brawl.ClaudeCodeClient;
import com.paul.brawl.compat.Compat;

import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.ChatFormatting;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.UUIDUtil;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.level.storage.LevelResource;

/**
 * The mod's side of Squad (docs/29 §2): a thin front over the squad runtime. It holds no squad state of its own,
 * only a cache of the runtime's (fed by SSE) for tab completion and the join gate, and does what only the server
 * can: identities and permissions, the commander's exact snapshot, whitelist entries, kicking an impostor,
 * teleporting a new bot to the admin, chat with click events, and the authoring turns.
 */
public final class Squad {

    private static final Logger LOGGER = LoggerFactory.getLogger("Squad");
    private static final long[] BACKOFF_MS = { 1_000, 2_000, 5_000, 10_000, 30_000 };

    private static volatile MinecraftServer server;
    private static volatile SquadClient client;
    private static volatile SquadAuthoring authoring;
    private static volatile Thread events;
    private static volatile boolean running;
    private static volatile JsonObject state = new JsonObject();
    /** Who must not hurt whom (owners per bot), rebuilt with each state so the damage hook does no JSON work. */
    private static volatile SquadFriends friends = SquadFriends.EMPTY;

    /** Lines for players who were offline (an order ending while they were away). */
    private static final Map<UUID, List<SquadNotice>> pending = new ConcurrentHashMap<>();
    /** Bots spawned by an admin, teleported on their first join (lower-case name → where, and what to do then). */
    private static final Map<String, Spot> arrivals = new ConcurrentHashMap<>();

    /** Where a new bot goes on its first join; `then` (may be null) runs on the next tick, once it stands there. */
    private record Spot(ServerLevel world, double x, double y, double z, float yaw, float pitch, Consumer<ServerPlayer> then) {}

    private Squad() {}

    // -- lifecycle -------------------------------------------------------------------------------------------------

    public static synchronized void start(MinecraftServer s) {
        SquadConfig cfg = SquadConfig.INSTANCE;
        LOGGER.info("{}", cfg.describe());
        server = s;
        if (!cfg.enabled) return;
        cfg.ensureToken();
        client = new SquadClient(() -> SquadConfig.INSTANCE.url, SquadConfig.INSTANCE::effectiveToken, Duration.ofSeconds(30));
        authoring = new SquadAuthoring(client, backend(cfg), Squad::tell, cfg.authorAgentName,
            Duration.ofSeconds(cfg.authorTimeoutSeconds), cfg.maxAuthoring);
        running = true;
        events = Thread.ofVirtual().name("squad-events").start(Squad::eventLoop);
    }

    public static synchronized void stop() {
        running = false;
        if (authoring != null) authoring.abortAll();
        if (events != null) events.interrupt();
        events = null;
        server = null;
    }

    static AgentBackend backend(SquadConfig cfg) {
        if (cfg.opencode()) return new AgentClient(cfg.agentUrl, cfg.agentUsername, cfg.agentPassword);
        return new ClaudeCodeClient(cfg.claudeBin, Path.of(cfg.claudeDir), cfg.claudeModel, cfg.claudeEffort,
            Map.of(SquadConfig.TOKEN_ENV, cfg.effectiveToken(), SquadConfig.URL_ENV, cfg.url));
    }

    public static boolean enabled() {
        return SquadConfig.INSTANCE.enabled && client != null;
    }

    static SquadClient client() {
        return client;
    }

    static SquadAuthoring authoring() {
        return authoring;
    }

    private static void eventLoop() {
        int attempt = 0;
        boolean warned = false;
        while (running) {
            try {
                client.streamEvents((event, data) -> {
                    switch (event) {
                        case "hello", "state" -> refreshState();
                        case "notice" -> deliver(data);
                        // A General's army (docs/38): the runtime asks, the server spawns or despawns.
                        case "general-spawn" -> {
                            MinecraftServer srv = server;
                            if (srv != null) SquadGeneral.onSpawn(srv, data);
                        }
                        case "general-despawn" -> {
                            MinecraftServer srv = server;
                            if (srv != null) SquadGeneral.onDespawn(srv, data);
                        }
                        default -> { }
                    }
                });
                attempt = 0; // the stream ended normally (runtime restarted): reconnect at once
                warned = false;
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                if (!warned) {
                    LOGGER.info("Squad runtime not reachable at {} ({}); retrying in the background.", SquadConfig.INSTANCE.url, e.toString());
                    warned = true;
                }
            }
            if (!running) return;
            try {
                Thread.sleep(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    static void refreshState() {
        SquadClient c = client;
        if (c == null) return;
        c.post("/api/state", new JsonObject()).thenAccept(s -> {
            if (s.has("ok") && s.get("ok").getAsBoolean()) {
                state = s;
                friends = SquadFriends.of(stateArray("bots"));
                MinecraftServer srv = server;
                if (srv != null) srv.execute(() -> syncWhitelist(srv));
            }
        });
    }

    // -- friendly fire -----------------------------------------------------------------------------------------------

    /**
     * Cancel damage a squad bot deals to a bot sharing an owner with it, or to one of its owners (SquadFriends). The
     * attacker of an arrow is its shooter. Registered before FlagManager's hook, so a cancelled friendly hit does not
     * make the victim drop a Flag either (the first hook returning false ends the event).
     */
    public static void registerFriendlyFire() {
        ServerLivingEntityEvents.ALLOW_DAMAGE.register((entity, source, amount) -> {
            if (!(entity instanceof ServerPlayer victim)) return true;
            if (!(source.getEntity() instanceof ServerPlayer attacker) || attacker == victim) return true;
            return !friends.spare(Compat.name(attacker.getGameProfile()), Compat.name(victim.getGameProfile()), victim.getUUID());
        });
    }

    // -- the cache (tab completion, join gate) ----------------------------------------------------------------------

    static JsonArray stateArray(String key) {
        JsonElement e = state.get(key);
        return e != null && e.isJsonArray() ? e.getAsJsonArray() : new JsonArray();
    }

    /** Every roster bot name. */
    public static List<String> botNames() {
        List<String> out = new ArrayList<>();
        for (JsonElement b : stateArray("bots")) out.add(b.getAsJsonObject().get("name").getAsString());
        return out;
    }

    /** A roster bot's tags, from the cache (empty for an unknown name). */
    static List<String> tagsOf(String bot) {
        List<String> out = new ArrayList<>();
        for (JsonElement el : stateArray("bots")) {
            JsonObject b = el.getAsJsonObject();
            if (!b.get("name").getAsString().equalsIgnoreCase(bot) || !b.has("tags")) continue;
            for (JsonElement t : b.getAsJsonArray("tags")) out.add(t.getAsString());
        }
        return out;
    }

    /** The bots a player owns. */
    static List<String> botsOf(UUID player) {
        List<String> out = new ArrayList<>();
        for (JsonElement el : stateArray("bots")) {
            JsonObject b = el.getAsJsonObject();
            for (JsonElement o : b.getAsJsonArray("owners")) {
                if (o.getAsJsonObject().get("uuid").getAsString().equals(player.toString())) out.add(b.get("name").getAsString());
            }
        }
        return out;
    }

    /** Commands a player can order: own, shared with them (as owner:NAME when the name is also theirs), stock. */
    static List<String> commandsOf(UUID player, boolean ownOnly) {
        List<String> own = new ArrayList<>();
        List<String> other = new ArrayList<>();
        String me = player.toString();
        for (JsonElement el : stateArray("commands")) {
            JsonObject c = el.getAsJsonObject();
            String name = c.get("name").getAsString();
            JsonObject author = c.getAsJsonObject("author");
            if (author.get("uuid").getAsString().equals(me)) own.add(name);
            else if (!ownOnly) {
                for (JsonElement s : c.getAsJsonArray("shares")) if (s.getAsString().equals(me)) other.add(name);
            }
        }
        if (ownOnly) return own;
        List<String> out = new ArrayList<>(own);
        for (String n : other) if (!out.contains(n)) out.add(n);
        for (JsonElement s : stateArray("stock")) if (!out.contains(s.getAsString())) out.add(s.getAsString());
        return out;
    }

    static List<String> orderIds() {
        List<String> out = new ArrayList<>();
        for (JsonElement o : stateArray("orders")) out.add("#" + o.getAsJsonObject().get("id").getAsString());
        return out;
    }

    // -- telling players --------------------------------------------------------------------------------------------

    /** Show a line to a player (main thread); kept until they log in when offline. */
    public static void tell(UUID player, SquadNotice line) {
        MinecraftServer srv = server;
        if (srv == null) return;
        srv.execute(() -> {
            ServerPlayer p = srv.getPlayerList().getPlayer(player);
            if (p == null) {
                List<SquadNotice> q = pending.computeIfAbsent(player, k -> new CopyOnWriteArrayList<>());
                if (q.size() < 50) q.add(line);
                return;
            }
            for (Component t : render(line)) p.sendSystemMessage(t);
        });
    }

    /** A runtime notice: {@code {to: [uuid…], text, click?}}. */
    static void deliver(JsonObject notice) {
        SquadNotice line = SquadNotice.fromJson(notice);
        JsonArray to = notice.has("to") && notice.get("to").isJsonArray() ? notice.getAsJsonArray("to") : new JsonArray();
        for (JsonElement u : to) {
            try {
                tell(UUID.fromString(u.getAsString()), line);
            } catch (IllegalArgumentException ignored) {
                // not a UUID
            }
        }
    }

    /** One chat line per text line; the click (if any) on the last one. */
    public static List<Component> render(SquadNotice n) {
        String[] lines = n.text().split("\n", -1);
        List<Component> out = new ArrayList<>();
        for (int i = 0; i < lines.length; i++) {
            MutableComponent t = Component.literal(lines[i]);
            if (i == 0 && lines[i].startsWith("[Bots]")) t = Component.literal("[Bots]").withStyle(ChatFormatting.AQUA).append(Component.literal(lines[i].substring(6)));
            if (i == lines.length - 1 && n.hasClick()) {
                String hover = n.hover() != null ? n.hover() : (n.run() ? "Clique pour lancer" : "Clique pour préparer la commande");
                t.append(Component.literal(n.clickLabel()).withStyle(s -> s
                    .withColor(ChatFormatting.GOLD)
                    .withUnderlined(true)
                    .withClickEvent(n.run() ? Compat.runCommand(n.clickCommand()) : Compat.suggestCommand(n.clickCommand()))
                    .withHoverEvent(Compat.showText(Component.literal(hover)))));
            }
            out.add(t);
        }
        return out;
    }

    // -- bots as players: whitelist, join gate, arrival -----------------------------------------------------------

    /** A bot's profile in offline mode (the only mode bots can join, docs/29 §4). */
    static GameProfile botProfile(String name) {
        return new GameProfile(UUIDUtil.createOfflinePlayerUUID(name), name);
    }

    /**
     * Whether someone already played under this name (offline mode: their save is keyed by the offline UUID, and a
     * bot of that name would load it). The user cache cannot tell: in offline mode it makes up a profile for any
     * name it is asked about.
     */
    static boolean hasPlayed(MinecraftServer srv, String name) {
        Path data = srv.getWorldPath(LevelResource.PLAYER_DATA_DIR).resolve(UUIDUtil.createOfflinePlayerUUID(name) + ".dat");
        return Files.exists(data);
    }

    // -- a despawned bot's save (SquadSaves) ------------------------------------------------------------------------

    private static final SquadSaves saves = new SquadSaves();

    /** A bot was despawned: its save is deleted once it has left, so its name can be given again. */
    static void forgetSave(String bot) {
        saves.forget(bot, System.currentTimeMillis());
    }

    /**
     * Each tick, the saves of the despawned bots that have left. The server writes a player's save while removing it
     * (one server-thread call), so a bot no longer online has its last save on disk, and nothing writes it again.
     */
    public static void registerSaveCleanup() {
        ServerTickEvents.END_SERVER_TICK.register(srv -> {
            if (saves.isEmpty()) return;
            List<String> roster = botNames();
            SquadSaves.Due due = saves.due(System.currentTimeMillis(), n -> srv.getPlayerList().getPlayerByName(n) != null,
                n -> roster.stream().anyMatch(r -> r.equalsIgnoreCase(n)));
            for (String name : due.delete()) {
                int files = deleteSave(srv, name);
                if (files > 0) LOGGER.info("Squad bot {} despawned: its save is deleted ({} file(s)).", name, files);
            }
            for (String name : due.givenUp()) LOGGER.warn("Squad bot {} despawned but still online or in the roster after {} s: its save is kept.", name, SquadSaves.WAIT_MS / 1000);
        });
    }

    /** A player's save under a name's offline UUID: the player data and its backup, stats, advancements. */
    private static List<Path> saveFiles(MinecraftServer srv, UUID id) {
        Path data = srv.getWorldPath(LevelResource.PLAYER_DATA_DIR);
        return List.of(data.resolve(id + ".dat"), data.resolve(id + ".dat_old"),
            srv.getWorldPath(LevelResource.PLAYER_STATS_DIR).resolve(id + ".json"),
            srv.getWorldPath(LevelResource.PLAYER_ADVANCEMENTS_DIR).resolve(id + ".json"));
    }

    /** Delete the save of a bot that is not online (server thread). Returns how many files went. */
    static int deleteSave(MinecraftServer srv, String name) {
        int n = 0;
        for (Path f : saveFiles(srv, UUIDUtil.createOfflinePlayerUUID(name))) {
            try {
                if (Files.deleteIfExists(f)) n++;
            } catch (IOException e) {
                LOGGER.warn("Could not delete {} (save of squad bot {}): {}", f, name, e.toString());
            }
        }
        return n;
    }

    /**
     * {@code /bots squad purge}: the saves left by despawned bots from before {@link #forgetSave}, i.e. every save of a
     * name the mod gives bots ({@link SquadSaves#generatedNames}) that is not in {@code roster} (lower-case, fresh from
     * the runtime), not online and not reserved. Server thread. Returns {names, files}.
     */
    static int[] purgeSaves(MinecraftServer srv, Set<String> roster) {
        Set<UUID> saved = savedUuids(srv);
        int names = 0, files = 0;
        for (String name : SquadSaves.generatedNames(SquadSaves.prefixes())) {
            if (saved.isEmpty()) break;
            if (!saved.remove(UUIDUtil.createOfflinePlayerUUID(name))) continue;
            if (roster.contains(name.toLowerCase(Locale.ROOT)) || srv.getPlayerList().getPlayerByName(name) != null || SquadCommand.reservedName(name)) continue;
            int n = deleteSave(srv, name);
            if (n > 0) {
                names++;
                files += n;
            }
        }
        LOGGER.info("Squad purge: deleted the saves of {} despawned bot(s) ({} file(s)).", names, files);
        return new int[] { names, files };
    }

    /** The UUIDs that have a save file (player data, stats or advancements). */
    private static Set<UUID> savedUuids(MinecraftServer srv) {
        Set<UUID> out = new HashSet<>();
        for (LevelResource dir : List.of(LevelResource.PLAYER_DATA_DIR, LevelResource.PLAYER_STATS_DIR, LevelResource.PLAYER_ADVANCEMENTS_DIR)) {
            try (var list = Files.list(srv.getWorldPath(dir))) {
                list.forEach(f -> {
                    String n = f.getFileName().toString();
                    int dot = n.indexOf('.');
                    try {
                        out.add(UUID.fromString(dot < 0 ? n : n.substring(0, dot)));
                    } catch (IllegalArgumentException ignored) {
                        // not a player's file
                    }
                });
            } catch (IOException | java.io.UncheckedIOException e) {
                // no such directory (nobody has played yet)
            }
        }
        return out;
    }

    /** Remember where to put a bot an admin just spawned (their position). */
    static void expectArrival(String bot, ServerPlayer admin) {
        expectArrival(bot, ((ServerLevel) admin.level()), admin.getX(), admin.getY(), admin.getZ(), admin.getYRot(), null);
    }

    /**
     * Remember where to put a new bot on its first join, and what to do with it once there (`/bots raid`: its kit
     * and the start of the raid). `then` runs on the server thread, the tick after the teleport.
     */
    static void expectArrival(String bot, ServerLevel world, double x, double y, double z, float yaw, Consumer<ServerPlayer> then) {
        arrivals.put(bot.toLowerCase(Locale.ROOT), new Spot(world, x, y, z, yaw, 0, then));
    }

    /** Forget the arrivals not yet seen (`/bots raid clear` before every raider came). */
    static void forgetArrivals(java.util.Collection<String> bots) {
        for (String b : bots) arrivals.remove(b.toLowerCase(Locale.ROOT));
    }

    static void whitelist(MinecraftServer srv, String bot, boolean add) {
        Compat.whitelist(srv.getPlayerList(), botProfile(bot), add);
    }

    /** Every roster bot is whitelisted (a bot spawned while the server was down, a whitelist edited by hand). */
    static void syncWhitelist(MinecraftServer srv) {
        for (String name : botNames()) {
            try {
                whitelist(srv, name, true);
            } catch (RuntimeException e) {
                LOGGER.warn("Could not whitelist bot {}: {}", name, e.toString());
            }
        }
    }

    /**
     * On join: a roster name from a non-allowed address is kicked (offline mode trusts names); a bot an admin just
     * spawned is teleported to them; a player gets the lines they missed.
     */
    public static void onJoin(ServerPlayer player, Consumer<Component> disconnect) {
        String name = player.getName().getString();
        boolean isBot = botNames().stream().anyMatch(n -> n.equalsIgnoreCase(name));
        if (isBot && SquadConfig.INSTANCE.joinGate && !allowedAddress(player.connection.getRemoteAddress())) {
            LOGGER.warn("Kicked {}: a squad bot name joining from {}.", name, player.connection.getRemoteAddress());
            disconnect.accept(Component.literal("Ce nom est réservé à un bot."));
            return;
        }
        Spot spot = arrivals.remove(name.toLowerCase(Locale.ROOT));
        if (spot != null) {
            Compat.teleport(player, spot.world(), spot.x(), spot.y(), spot.z(), spot.yaw(), spot.pitch());
            MinecraftServer srv = server;
            if (spot.then() != null && srv != null) srv.execute(() -> spot.then().accept(player));
        }
        List<SquadNotice> missed = pending.remove(player.getUUID());
        if (missed != null) for (SquadNotice n : missed) for (Component t : render(n)) player.sendSystemMessage(t);
    }

    static boolean allowedAddress(SocketAddress addr) {
        if (!(addr instanceof InetSocketAddress inet)) return true; // local (in-memory) connections
        String host = inet.getAddress() != null ? inet.getAddress().getHostAddress() : inet.getHostString();
        Set<String> allowed = Set.copyOf(Arrays.stream(SquadConfig.INSTANCE.allowedBotAddresses.split(",")).map(String::trim).toList());
        return allowed.contains(host) || (inet.getAddress() != null && inet.getAddress().isLoopbackAddress());
    }

    // -- kits ---------------------------------------------------------------------------------------------------------

    /** Kits go out one at a time, {@link SquadConfig#kitStaggerMs} apart. Server thread only. */
    private static final SquadPacer kitPacer = new SquadPacer();

    /**
     * {@link #equip}, paced: at least {@link SquadConfig#kitStaggerMs} after the kit before it, whoever asked. Then
     * {@code then} gets the French answer. Both run on the server thread; call it from there.
     */
    static void equipLater(MinecraftServer srv, String botName, SquadKits.Kit kit, Consumer<String> then) {
        paced(srv, () -> then.accept(equip(srv, botName, kit)));
    }

    /** {@link #resetToKit}, paced like {@link #equipLater}. */
    static void resetToKitLater(MinecraftServer srv, String botName, SquadKits.Kit kit, Consumer<String> then) {
        paced(srv, () -> then.accept(resetToKit(srv, botName, kit)));
    }

    /** Run {@code give} on the server thread, at least {@link SquadConfig#kitStaggerMs} after the kit before it. */
    private static void paced(MinecraftServer srv, Runnable give) {
        long wait = kitPacer.reserve(System.currentTimeMillis(), SquadConfig.INSTANCE.kitStaggerMs);
        if (wait <= 0) {
            give.run();
            return;
        }
        java.util.concurrent.CompletableFuture.delayedExecutor(wait, java.util.concurrent.TimeUnit.MILLISECONDS)
            .execute(() -> srv.execute(give));
    }

    /**
     * Give a kit to an online bot (main thread): armor into the armor slots, the weapon into the main hand, the shield
     * into the off-hand, the rest into the inventory. What a slot held before goes into the inventory (dropped at
     * the bot's feet when full), never lost. Returns the French answer.
     */
    static String equip(MinecraftServer srv, String botName, SquadKits.Kit kit) {
        ServerPlayer p = srv.getPlayerList().getPlayerByName(botName);
        if (p == null) return "[Bots] " + botName + " n'est pas connecté : impossible de l'équiper.";
        List<String> given = new ArrayList<>();
        for (SquadKits.Item it : kit.items()) {
            Optional<Item> item = Compat.item("minecraft:" + it.id());
            if (item.isEmpty()) {
                LOGGER.warn("Kit {}: unknown item minecraft:{}", kit.name(), it.id());
                continue;
            }
            ItemStack stack = new ItemStack(item.get(), it.count());
            List<String> enchants = enchant(srv, stack, it);
            switch (it.slot()) {
                case INVENTORY -> give(p, stack);
                case MAINHAND -> {
                    Inventory inv = p.getInventory();
                    int selected = Compat.selectedSlot(inv);
                    ItemStack old = inv.getItem(selected);
                    inv.setItem(selected, stack);
                    if (!old.isEmpty()) give(p, old);
                }
                default -> {
                    EquipmentSlot slot = switch (it.slot()) {
                        case HEAD -> EquipmentSlot.HEAD;
                        case CHEST -> EquipmentSlot.CHEST;
                        case LEGS -> EquipmentSlot.LEGS;
                        case FEET -> EquipmentSlot.FEET;
                        default -> EquipmentSlot.OFFHAND;
                    };
                    ItemStack old = p.getItemBySlot(slot).copy();
                    p.setItemSlot(slot, stack);
                    if (!old.isEmpty()) give(p, old);
                }
            }
            String what = it.count() > 1 ? it.count() + " " + it.id() : it.id();
            given.add(enchants.isEmpty() ? what : what + " (" + String.join(", ", enchants) + ")");
        }
        LOGGER.info("Equipped squad bot {} as {}: {}", p.getName().getString(), kit.name(), given);
        return "[Bots] " + p.getName().getString() + " équipé en " + kit.label() + " : " + String.join(", ", given) + ".";
    }

    /**
     * The kit item's enchantments on its stack, from the server's enchantment registry (dynamic since 1.21: it is the
     * server's, not a static one). An unknown id is logged and skipped. Returns « infinity 1 »… for the answer.
     */
    private static List<String> enchant(MinecraftServer srv, ItemStack stack, SquadKits.Item it) {
        List<String> out = new ArrayList<>();
        if (it.enchantments().isEmpty()) return out;
        HolderLookup.RegistryLookup<Enchantment> registry = srv.registryAccess().lookupOrThrow(Registries.ENCHANTMENT);
        for (Map.Entry<String, Integer> e : new java.util.TreeMap<>(it.enchantments()).entrySet()) {
            Optional<Holder.Reference<Enchantment>> entry = registry.get(Compat.key(Registries.ENCHANTMENT, "minecraft", e.getKey()));
            if (entry.isEmpty()) {
                LOGGER.warn("Kit item {}: unknown enchantment {}", it.id(), e.getKey());
                continue;
            }
            stack.enchant(entry.get(), e.getValue());
            out.add(e.getKey() + " " + e.getValue());
        }
        return out;
    }

    /**
     * A bot back from the dead ({@code /bots squad respawn}, docs/35 D3): its whole inventory cleared (main, armor,
     * off-hand), then its kit given as {@link #equip} does, so an archer has its Infinity bow again. A null kit (a bot
     * with no kit tag) leaves it empty. {@code /bots equip} is unchanged: it keeps what the bot carries. Main thread.
     */
    static String resetToKit(MinecraftServer srv, String botName, SquadKits.Kit kit) {
        ServerPlayer p = srv.getPlayerList().getPlayerByName(botName);
        if (p == null) return "[Bots] " + botName + " n'est pas connecté : impossible de le rééquiper.";
        p.getInventory().clearContent();
        if (kit == null) {
            LOGGER.info("Squad bot {} back without a kit: inventory cleared", p.getName().getString());
            return "[Bots] " + p.getName().getString() + " revient sans kit.";
        }
        return equip(srv, botName, kit);
    }

    private static void give(ServerPlayer p, ItemStack stack) {
        if (!p.getInventory().add(stack) && !stack.isEmpty()) p.drop(stack, false);
    }

    // -- players by name ------------------------------------------------------------------------------------------

    /** A player named in a command: online, or known to the user cache, or (offline mode) by the offline UUID. */
    static Optional<GameProfile> profile(MinecraftServer srv, String name) {
        ServerPlayer online = srv.getPlayerList().getPlayerByName(name);
        if (online != null) return Optional.of(online.getGameProfile());
        Optional<GameProfile> known = Compat.cachedProfile(srv, name);
        if (known.isPresent()) return known;
        if (!srv.usesAuthentication() && SquadArgs.BOT_NAME.matcher(name).matches()) return Optional.of(new GameProfile(UUIDUtil.createOfflinePlayerUUID(name), name));
        return Optional.empty();
    }

    static JsonObject player(GameProfile p) {
        JsonObject o = new JsonObject();
        o.addProperty("uuid", Compat.id(p).toString());
        o.addProperty("name", Compat.name(p));
        return o;
    }
}
