package com.paul.brawl.squad;

import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
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

import net.minecraft.entity.EquipmentSlot;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.WhitelistEntry;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.text.ClickEvent;
import net.minecraft.text.HoverEvent;
import net.minecraft.text.MutableText;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import net.minecraft.util.Identifier;
import net.minecraft.util.Uuids;
import net.minecraft.util.WorldSavePath;

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

    /** Lines for players who were offline (an order ending while they were away). */
    private static final Map<UUID, List<SquadNotice>> pending = new ConcurrentHashMap<>();
    /** Bots spawned by an admin, teleported to them on their first join (lower-case name → where). */
    private static final Map<String, Spot> arrivals = new ConcurrentHashMap<>();

    private record Spot(ServerWorld world, double x, double y, double z, float yaw, float pitch) {}

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
                MinecraftServer srv = server;
                if (srv != null) srv.execute(() -> syncWhitelist(srv));
            }
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
            ServerPlayerEntity p = srv.getPlayerManager().getPlayer(player);
            if (p == null) {
                List<SquadNotice> q = pending.computeIfAbsent(player, k -> new CopyOnWriteArrayList<>());
                if (q.size() < 50) q.add(line);
                return;
            }
            for (Text t : render(line)) p.sendMessage(t, false);
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
    public static List<Text> render(SquadNotice n) {
        String[] lines = n.text().split("\n", -1);
        List<Text> out = new ArrayList<>();
        for (int i = 0; i < lines.length; i++) {
            MutableText t = Text.literal(lines[i]);
            if (i == 0 && lines[i].startsWith("[Bots]")) t = Text.literal("[Bots]").formatted(Formatting.AQUA).append(Text.literal(lines[i].substring(6)));
            if (i == lines.length - 1 && n.hasClick()) {
                String hover = n.hover() != null ? n.hover() : (n.run() ? "Clique pour lancer" : "Clique pour préparer la commande");
                t.append(Text.literal(n.clickLabel()).styled(s -> s
                    .withColor(Formatting.GOLD)
                    .withUnderline(true)
                    .withClickEvent(new ClickEvent(n.run() ? ClickEvent.Action.RUN_COMMAND : ClickEvent.Action.SUGGEST_COMMAND, n.clickCommand()))
                    .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Text.literal(hover)))));
            }
            out.add(t);
        }
        return out;
    }

    // -- bots as players: whitelist, join gate, arrival -----------------------------------------------------------

    /** A bot's profile in offline mode (the only mode bots can join, docs/29 §4). */
    static GameProfile botProfile(String name) {
        return new GameProfile(Uuids.getOfflinePlayerUuid(name), name);
    }

    /**
     * Whether someone already played under this name (offline mode: their save is keyed by the offline UUID, and a
     * bot of that name would load it). The user cache cannot tell: in offline mode it makes up a profile for any
     * name it is asked about.
     */
    static boolean hasPlayed(MinecraftServer srv, String name) {
        Path data = srv.getSavePath(WorldSavePath.PLAYERDATA).resolve(Uuids.getOfflinePlayerUuid(name) + ".dat");
        return java.nio.file.Files.exists(data);
    }

    /** Remember where to put a bot an admin just spawned (their position). */
    static void expectArrival(String bot, ServerPlayerEntity admin) {
        arrivals.put(bot.toLowerCase(Locale.ROOT), new Spot(admin.getServerWorld(), admin.getX(), admin.getY(), admin.getZ(), admin.getYaw(), 0));
    }

    static void whitelist(MinecraftServer srv, String bot, boolean add) {
        var list = srv.getPlayerManager().getWhitelist();
        GameProfile profile = botProfile(bot);
        if (add) {
            if (!list.isAllowed(profile)) list.add(new WhitelistEntry(profile));
        } else {
            list.remove(profile);
        }
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
    public static void onJoin(ServerPlayerEntity player, Consumer<Text> disconnect) {
        String name = player.getName().getString();
        boolean isBot = botNames().stream().anyMatch(n -> n.equalsIgnoreCase(name));
        if (isBot && SquadConfig.INSTANCE.joinGate && !allowedAddress(player.networkHandler.getConnectionAddress())) {
            LOGGER.warn("Kicked {}: a squad bot name joining from {}.", name, player.networkHandler.getConnectionAddress());
            disconnect.accept(Text.literal("Ce nom est réservé à un bot."));
            return;
        }
        Spot spot = arrivals.remove(name.toLowerCase(Locale.ROOT));
        if (spot != null) player.teleport(spot.world(), spot.x(), spot.y(), spot.z(), spot.yaw(), spot.pitch());
        List<SquadNotice> missed = pending.remove(player.getUuid());
        if (missed != null) for (SquadNotice n : missed) for (Text t : render(n)) player.sendMessage(t, false);
    }

    static boolean allowedAddress(SocketAddress addr) {
        if (!(addr instanceof InetSocketAddress inet)) return true; // local (in-memory) connections
        String host = inet.getAddress() != null ? inet.getAddress().getHostAddress() : inet.getHostString();
        Set<String> allowed = Set.copyOf(Arrays.stream(SquadConfig.INSTANCE.allowedBotAddresses.split(",")).map(String::trim).toList());
        return allowed.contains(host) || (inet.getAddress() != null && inet.getAddress().isLoopbackAddress());
    }

    // -- kits ---------------------------------------------------------------------------------------------------------

    /**
     * Give a kit to an online bot (main thread): armor into the armor slots, the weapon into the main hand, the shield
     * into the off-hand, the rest into the inventory. What a slot held before goes into the inventory (dropped at
     * the bot's feet when full), never lost. Returns the French answer.
     */
    static String equip(MinecraftServer srv, String botName, SquadKits.Kit kit) {
        ServerPlayerEntity p = srv.getPlayerManager().getPlayer(botName);
        if (p == null) return "[Bots] " + botName + " n'est pas connecté : impossible de l'équiper.";
        List<String> given = new ArrayList<>();
        for (SquadKits.Item it : kit.items()) {
            Identifier id = Identifier.of("minecraft", it.id());
            if (!Registries.ITEM.containsId(id)) {
                LOGGER.warn("Kit {}: unknown item {}", kit.name(), id);
                continue;
            }
            ItemStack stack = new ItemStack(Registries.ITEM.get(id), it.count());
            switch (it.slot()) {
                case INVENTORY -> give(p, stack);
                case MAINHAND -> {
                    PlayerInventory inv = p.getInventory();
                    ItemStack old = inv.getStack(inv.selectedSlot);
                    inv.setStack(inv.selectedSlot, stack);
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
                    ItemStack old = p.getEquippedStack(slot).copy();
                    p.equipStack(slot, stack);
                    if (!old.isEmpty()) give(p, old);
                }
            }
            given.add(it.count() > 1 ? it.count() + " " + it.id() : it.id());
        }
        LOGGER.info("Equipped squad bot {} as {}: {}", p.getName().getString(), kit.name(), given);
        return "[Bots] " + p.getName().getString() + " équipé en " + kit.label() + " : " + String.join(", ", given) + ".";
    }

    private static void give(ServerPlayerEntity p, ItemStack stack) {
        if (!p.getInventory().insertStack(stack) && !stack.isEmpty()) p.dropItem(stack, false);
    }

    // -- players by name ------------------------------------------------------------------------------------------

    /** A player named in a command: online, or known to the user cache, or (offline mode) by the offline UUID. */
    static Optional<GameProfile> profile(MinecraftServer srv, String name) {
        ServerPlayerEntity online = srv.getPlayerManager().getPlayer(name);
        if (online != null) return Optional.of(online.getGameProfile());
        var cache = srv.getUserCache();
        if (cache != null) {
            Optional<GameProfile> known = cache.findByName(name);
            if (known.isPresent()) return known;
        }
        if (!srv.isOnlineMode() && SquadArgs.BOT_NAME.matcher(name).matches()) return Optional.of(new GameProfile(Uuids.getOfflinePlayerUuid(name), name));
        return Optional.empty();
    }

    static JsonObject player(GameProfile p) {
        JsonObject o = new JsonObject();
        o.addProperty("uuid", p.getId().toString());
        o.addProperty("name", p.getName());
        return o;
    }
}
