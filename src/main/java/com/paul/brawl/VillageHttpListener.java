package com.paul.brawl;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
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
 * <p>Validation and the swap both run on the MAIN server thread via
 * {@link MinecraftServer#submit}; the HTTP thread blocks on the future
 * (~1 tick). Items without a namespace resolve as {@code minecraft:},
 * falling back to {@code paulsbrawls:} (so plain "coin" works).
 *
 * <p>Same security posture as the Node bridge: bound to 127.0.0.1, no auth.
 */
public final class VillageHttpListener {

    private static final Logger LOGGER = LoggerFactory.getLogger("VillageHttpListener");
    private static final Gson GSON = new Gson();
    private static final int MAX_BODY_BYTES = 64 * 1024;
    private static final int MAX_OFFER_LINES = 6;
    private static final int MAX_STACK_COUNT = 512;

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
        if (request.botA.equals(request.botB)) return "botA and botB are the same";
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

    // -- main-thread trade logic ------------------------------------------------

    private static TradeResult executeTrade(MinecraftServer mc, TradeRequest request) {
        ServerPlayerEntity a = mc.getPlayerManager().getPlayer(request.botA);
        ServerPlayerEntity b = mc.getPlayerManager().getPlayer(request.botB);
        if (a == null) return TradeResult.fail(request.botA + " is not online");
        if (b == null) return TradeResult.fail(request.botB + " is not online");

        // Resolve + validate EVERYTHING before mutating anything.
        for (ItemSpec spec : request.aGives) {
            Item item = resolveItem(spec.item);
            if (item == null) return TradeResult.fail("unknown item: " + spec.item);
            if (countItems(a, item) < spec.count) {
                return TradeResult.fail(request.botA + " does not have " + spec.count + "x " + spec.item);
            }
        }
        for (ItemSpec spec : request.bGives) {
            Item item = resolveItem(spec.item);
            if (item == null) return TradeResult.fail("unknown item: " + spec.item);
            if (countItems(b, item) < spec.count) {
                return TradeResult.fail(request.botB + " does not have " + spec.count + "x " + spec.item);
            }
        }

        // Swap. We're on the main thread and validated above, so this cannot
        // half-fail; overflow that doesn't fit the receiver's inventory drops
        // at their feet (still theirs to pick up).
        for (ItemSpec spec : request.aGives) {
            Item item = resolveItem(spec.item);
            removeItems(a, item, spec.count);
            addItems(b, item, spec.count);
        }
        for (ItemSpec spec : request.bGives) {
            Item item = resolveItem(spec.item);
            removeItems(b, item, spec.count);
            addItems(a, item, spec.count);
        }
        a.currentScreenHandler.sendContentUpdates();
        b.currentScreenHandler.sendContentUpdates();
        return TradeResult.success();
    }

    private static Item resolveItem(String name) {
        String n = name.trim().toLowerCase();
        Identifier id = n.contains(":") ? Identifier.tryParse(n) : Identifier.of("minecraft", n);
        Item item = id != null ? Registries.ITEM.get(id) : Items.AIR;
        if (item == Items.AIR && !n.contains(":")) {
            // Mod items — notably the Gibber currency, paulsbrawls:coin.
            item = Registries.ITEM.get(Identifier.of("paulsbrawls", n));
        }
        return item == Items.AIR ? null : item;
    }

    private static int countItems(ServerPlayerEntity player, Item item) {
        int total = 0;
        var inventory = player.getInventory();
        for (int i = 0; i < inventory.size(); i++) {
            ItemStack stack = inventory.getStack(i);
            if (!stack.isEmpty() && stack.isOf(item)) total += stack.getCount();
        }
        return total;
    }

    private static void removeItems(ServerPlayerEntity player, Item item, int count) {
        int remaining = count;
        var inventory = player.getInventory();
        for (int i = 0; i < inventory.size() && remaining > 0; i++) {
            ItemStack stack = inventory.getStack(i);
            if (stack.isEmpty() || !stack.isOf(item)) continue;
            int take = Math.min(remaining, stack.getCount());
            stack.decrement(take);
            remaining -= take;
        }
    }

    private static void addItems(ServerPlayerEntity player, Item item, int count) {
        int remaining = count;
        int maxPerStack = Math.max(1, item.getDefaultStack().getMaxCount());
        while (remaining > 0) {
            int n = Math.min(remaining, maxPerStack);
            ItemStack stack = new ItemStack(item, n);
            if (!player.getInventory().insertStack(stack) && !stack.isEmpty()) {
                player.dropItem(stack, false);
            }
            remaining -= n;
        }
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
