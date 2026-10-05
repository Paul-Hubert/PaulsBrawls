package com.paul.brawl;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.Identifier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Localhost-only HTTP listener for the AI village's trade settlement
 * (VILLAGE_PLAN.md §D5): the Node village process negotiates barters between
 * bots, then POSTs here for a server-authoritative ATOMIC inventory swap —
 * no item tossing, no partial exchanges.
 *
 * <p>POST /trade/execute
 * <pre>{ "botA": "...", "botB": "...",
 *   "aGives": [{ "item": "carrot", "count": 32 }],
 *   "bGives": [{ "item": "oak_planks", "count": 8 }] }</pre>
 *
 * <p>Validation and the swap both run in ONE task on the MAIN server thread
 * via {@link MinecraftServer#submit}; the HTTP thread blocks on the future
 * (~1 tick). Items without a namespace resolve as {@code minecraft:},
 * falling back to {@code paulsbrawls:} (so plain "coin" works).
 *
 * <p>Lines naming the same item are summed per side before validation, so a
 * party can never be asked for more than it holds ({@link TradeMath}). Only
 * the 36 main/hotbar slots count — worn armour and the offhand are never
 * traded. The real stacks are moved (split), so damage, enchantments and
 * custom names survive the trade.
 *
 * <p>Bound to 127.0.0.1. The parties must share a dimension and stand within
 * {@link VillageConfig#maxTradeDistance}; if {@link VillageConfig#settlementToken}
 * is set, requests must carry it in {@value #TOKEN_HEADER}.
 */
public final class VillageHttpListener {

    private static final Logger LOGGER = LoggerFactory.getLogger("VillageHttpListener");
    private static final Gson GSON = new Gson();
    private static final int MAX_BODY_BYTES = 64 * 1024;
    private static final int MAX_OFFER_LINES = 6;
    private static final int MAX_STACK_COUNT = 512;
    static final String TOKEN_HEADER = "X-Village-Token";

    private static HttpServer server;

    private VillageHttpListener() {}

    // -- request/response shapes (Gson) --------------------------------------

    private static final class ItemSpec {
        String item;
        int count;
    }

    private static final class TradeRequest {
        String botA;
        String botB;
        List<ItemSpec> aGives;
        List<ItemSpec> bGives;
    }

    private static final class TradeResult {
        final boolean ok;
        final String error;
        TradeResult(boolean ok, String error) { this.ok = ok; this.error = error; }
        static TradeResult success() { return new TradeResult(true, null); }
        static TradeResult fail(String error) { return new TradeResult(false, error); }
    }

    // -- lifecycle -------------------------------------------------------------

    public static synchronized void start(MinecraftServer mc) {
        if (server != null) return;
        if (!VillageConfig.INSTANCE.enabled) {
            LOGGER.info("Village settlement listener disabled by config.");
            return;
        }
        int port = VillageConfig.INSTANCE.listenerPort;
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        } catch (IOException e) {
            LOGGER.warn("Village settlement listener failed to bind 127.0.0.1:{}: {}", port, e.getMessage());
            server = null;
            return;
        }
        server.createContext("/trade/execute", exchange -> handleTrade(mc, exchange));
        server.setExecutor(Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "village-settlement-http");
            t.setDaemon(true);
            return t;
        }));
        server.start();
        LOGGER.info("Village settlement listener on http://127.0.0.1:{}/trade/execute", port);
        if (VillageConfig.INSTANCE.settlementToken.isBlank()) {
            LOGGER.info("No settlementToken configured — any local process can settle village trades.");
        }
    }

    public static synchronized void stop() {
        if (server == null) return;
        server.stop(0);
        server = null;
        LOGGER.info("Village settlement listener stopped.");
    }

    public static synchronized boolean isRunning() {
        return server != null;
    }

    // -- handler -----------------------------------------------------------------

    private static void handleTrade(MinecraftServer mc, HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                respond(exchange, 405, TradeResult.fail("POST only"));
                return;
            }
            if (!tokenMatches(exchange.getRequestHeaders().getFirst(TOKEN_HEADER))) {
                respond(exchange, 401, TradeResult.fail("bad or missing " + TOKEN_HEADER));
                return;
            }
            byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
            if (body.length > MAX_BODY_BYTES) {
                respond(exchange, 400, TradeResult.fail("body too large"));
                return;
            }
            TradeRequest request;
            try {
                request = GSON.fromJson(new String(body, StandardCharsets.UTF_8), TradeRequest.class);
            } catch (JsonSyntaxException e) {
                respond(exchange, 400, TradeResult.fail("bad json: " + e.getMessage()));
                return;
            }
            String problem = validateShape(request);
            if (problem != null) {
                respond(exchange, 400, TradeResult.fail(problem));
                return;
            }

            TradeResult result;
            try {
                // Main-thread hop: validate + swap atomically w.r.t. game ticks.
                result = mc.submit(() -> executeTrade(mc, request)).join();
            } catch (Exception e) {
                LOGGER.warn("Trade execution failed: {}", e.getMessage());
                result = TradeResult.fail("server error: " + e.getMessage());
            }
            if (result.ok) {
                LOGGER.info("Village trade settled: {} <-> {}", request.botA, request.botB);
            }
            respond(exchange, result.ok ? 200 : 400, result);
        }
    }

    private static String validateShape(TradeRequest request) {
        if (request == null) return "empty request";
        if (request.botA == null || request.botA.isBlank()) return "missing botA";
        if (request.botB == null || request.botB.isBlank()) return "missing botB";
        if (request.botA.equalsIgnoreCase(request.botB)) return "botA and botB are the same";
        if (request.aGives == null || request.bGives == null) return "missing aGives/bGives";
        if (request.aGives.isEmpty() && request.bGives.isEmpty()) return "nothing to trade";
        if (request.aGives.size() > MAX_OFFER_LINES || request.bGives.size() > MAX_OFFER_LINES) {
            return "too many item lines (max " + MAX_OFFER_LINES + ")";
        }
        for (ItemSpec spec : request.aGives) {
            String e = validateSpec(spec);
            if (e != null) return e;
        }
        for (ItemSpec spec : request.bGives) {
            String e = validateSpec(spec);
            if (e != null) return e;
        }
        return null;
    }

    private static String validateSpec(ItemSpec spec) {
        if (spec == null || spec.item == null || spec.item.isBlank()) return "missing item name";
        if (spec.count < 1 || spec.count > MAX_STACK_COUNT) return "bad count for " + spec.item;
        return null;
    }

    private static boolean tokenMatches(String presented) {
        String expected = VillageConfig.INSTANCE.settlementToken;
        if (expected == null || expected.isBlank()) return true;
        if (presented == null) return false;
        return MessageDigest.isEqual(
            expected.getBytes(StandardCharsets.UTF_8),
            presented.trim().getBytes(StandardCharsets.UTF_8));
    }

    // -- main-thread trade logic ------------------------------------------------

    private static TradeResult executeTrade(MinecraftServer mc, TradeRequest request) {
        ServerPlayerEntity a = mc.getPlayerManager().getPlayer(request.botA);
        ServerPlayerEntity b = mc.getPlayerManager().getPlayer(request.botB);
        if (a == null) return TradeResult.fail(request.botA + " is not online");
        if (b == null) return TradeResult.fail(request.botB + " is not online");
        if (a == b) return TradeResult.fail("botA and botB are the same");

        if (a.getServerWorld() != b.getServerWorld()) {
            return TradeResult.fail(request.botA + " and " + request.botB + " are not in the same dimension");
        }
        double maxDistance = VillageConfig.INSTANCE.maxTradeDistance;
        if (maxDistance > 0 && a.squaredDistanceTo(b) > maxDistance * maxDistance) {
            return TradeResult.fail(String.format(java.util.Locale.ROOT, "%s and %s are too far apart (%.1f > %.1f blocks)",
                request.botA, request.botB, Math.sqrt(a.squaredDistanceTo(b)), maxDistance));
        }

        // Resolve + sum EVERYTHING per item before mutating anything: two lines
        // of {coin,10} must be checked as 20 coins, not twice as 10.
        Map<Item, Integer> aTotals = new LinkedHashMap<>();
        Map<Item, Integer> bTotals = new LinkedHashMap<>();
        String problem = aggregate(request.aGives, aTotals);
        if (problem == null) problem = aggregate(request.bGives, bTotals);
        if (problem != null) return TradeResult.fail(problem);

        Item aShort = TradeMath.firstShortfall(aTotals, item -> countItems(a, item));
        if (aShort != null) {
            return TradeResult.fail(request.botA + " does not have " + aTotals.get(aShort) + "x " + Registries.ITEM.getId(aShort));
        }
        Item bShort = TradeMath.firstShortfall(bTotals, item -> countItems(b, item));
        if (bShort != null) {
            return TradeResult.fail(request.botB + " does not have " + bTotals.get(bShort) + "x " + Registries.ITEM.getId(bShort));
        }

        // Swap. Same main-thread task as the validation above, so nothing can
        // change the inventories in between and this cannot half-fail. Both
        // sides are extracted BEFORE either receives, so a party never hands
        // over stacks it was just given. Overflow that doesn't fit the
        // receiver's inventory drops at their feet (still theirs to pick up).
        List<ItemStack> toB = extract(a, aTotals);
        List<ItemStack> toA = extract(b, bTotals);
        for (ItemStack stack : toB) b.getInventory().offerOrDrop(stack);
        for (ItemStack stack : toA) a.getInventory().offerOrDrop(stack);
        a.currentScreenHandler.sendContentUpdates();
        b.currentScreenHandler.sendContentUpdates();
        return TradeResult.success();
    }

    /** Resolves each line and sums it into {@code totals}; returns an error or {@code null}. */
    private static String aggregate(List<ItemSpec> specs, Map<Item, Integer> totals) {
        for (ItemSpec spec : specs) {
            Item item = resolveItem(spec.item);
            if (item == null) return "unknown item: " + spec.item;
            TradeMath.addLine(totals, item, spec.count);
        }
        return null;
    }

    private static Item resolveItem(String name) {
        String n = name.trim().toLowerCase();
        boolean namespaced = n.contains(":");
        Identifier id = Identifier.tryParse(namespaced ? n : "minecraft:" + n);
        Item item = id != null ? Registries.ITEM.get(id) : Items.AIR;
        if (item == Items.AIR && !namespaced) {
            // Mod items — notably the Gibber currency, paulsbrawls:coin.
            Identifier modId = Identifier.tryParse("paulsbrawls:" + n);
            if (modId != null) item = Registries.ITEM.get(modId);
        }
        return item == Items.AIR ? null : item;
    }

    /** Main + hotbar only (36 slots) — armour and offhand are never traded. */
    private static int countItems(ServerPlayerEntity player, Item item) {
        int total = 0;
        for (ItemStack stack : player.getInventory().main) {
            if (!stack.isEmpty() && stack.isOf(item)) total += stack.getCount();
        }
        return total;
    }

    /**
     * Splits exactly the validated totals out of the player's main inventory,
     * keeping each stack's components (damage, enchantments, custom name).
     */
    private static List<ItemStack> extract(ServerPlayerEntity player, Map<Item, Integer> totals) {
        List<ItemStack> extracted = new ArrayList<>();
        var main = player.getInventory().main;
        for (var entry : totals.entrySet()) {
            int[] available = new int[main.size()];
            for (int i = 0; i < available.length; i++) {
                ItemStack stack = main.get(i);
                available[i] = !stack.isEmpty() && stack.isOf(entry.getKey()) ? stack.getCount() : 0;
            }
            int[] takes = TradeMath.planTakes(available, entry.getValue());
            if (takes == null) {
                // Unreachable: validated against the same slots in this same task.
                throw new IllegalStateException("inventory of " + player.getName().getString() + " changed mid-settlement");
            }
            for (int i = 0; i < takes.length; i++) {
                if (takes[i] > 0) extracted.add(main.get(i).split(takes[i]));
            }
        }
        player.getInventory().markDirty();
        return extracted;
    }

    private static void respond(HttpExchange exchange, int status, TradeResult result) throws IOException {
        byte[] payload = GSON.toJson(result).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, payload.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(payload);
        }
    }
}
