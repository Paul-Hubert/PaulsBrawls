package com.paul.brawl;

import java.io.IOException;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.Command;
import com.mojang.brigadier.arguments.StringArgumentType;

import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import net.minecraft.util.math.Vec3d;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * /villagers start &lt;name&gt;   — load eden/scenarios/&lt;name&gt;.json, connect its bots and
 *                              scatter them around the caller's position.
 * /villagers stop             — gracefully disconnect scenario bots (state preserved on disk).
 * /villagers restart &lt;name&gt; — wipe per-bot state files then start fresh.
 *
 * Requires permission level 2. All HTTP to Eden is async; feedback returns on the main thread.
 * Populates {@link #activeScenarioBots} so the op-on-join handler can op every scenario bot.
 */
public class VillagersCommand {

    private static final Logger LOGGER = LoggerFactory.getLogger("VillagersCommand");
    private static final Gson GSON = new Gson();

    // Pin HTTP/1.1. The JDK HttpClient defaults to HTTP/2, which over cleartext (h2c) sends
    // "Connection: Upgrade" + "Upgrade: h2c" on its requests. Eden's admin server treats ANY
    // upgrade not bound for /journal/stream by destroying the socket (eden/src/admin/server.ts
    // 'upgrade' handler) — so every POST died with "received no bytes" / "connection reset"
    // BEFORE a byte was written. HTTP/1.1 sends no upgrade header, so Eden answers normally.
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(3))
        .build();

    /**
     * How many times to retry a transient POST before reporting failure. A transient
     * IOException ("received no bytes" — port bound but not serving yet) or ConnectException
     * (port not re-bound yet) just means Eden is mid-restart; it answers a moment later.
     * 3 retries × {@link #RETRY_DELAY_MS} ≈ 2.25s of added latency in the worst case — enough
     * to hide a hot restart, while still well under the 10s request timeout. A genuine COLD
     * boot (fresh {@code tsx} start) can exceed this; that correctly falls through to the calm
     * "Eden redémarre" message rather than a false alarm.
     */
    private static final int MAX_RETRIES = 3;
    private static final long RETRY_DELAY_MS = 750;

    /** Names of scenario bots currently known to Eden — updated from each start/restart response. */
    public static final Set<String> activeScenarioBots =
        Collections.newSetFromMap(new ConcurrentHashMap<>());

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) ->
            dispatcher.register(
                CommandManager.literal("villagers")
                    .requires(source -> source.hasPermissionLevel(2))
                    .then(CommandManager.literal("start")
                        .then(CommandManager.argument("name", StringArgumentType.word())
                            .executes(ctx -> {
                                String name = StringArgumentType.getString(ctx, "name");
                                ServerPlayerEntity player = ctx.getSource().getPlayer();
                                if (player == null) {
                                    ctx.getSource().sendFeedback(() -> Text.literal(
                                        "[villagers] /villagers start must be run by a player — it scatters bots around your position."), false);
                                    return 0;
                                }
                                Vec3d pos = player.getPos();
                                postScenario(ctx.getSource(), "start", name, (int) pos.x, (int) pos.z);
                                return Command.SINGLE_SUCCESS;
                            })))
                    .then(CommandManager.literal("stop")
                        .executes(ctx -> {
                            stopScenario(ctx.getSource());
                            return Command.SINGLE_SUCCESS;
                        }))
                    .then(CommandManager.literal("restart")
                        .then(CommandManager.argument("name", StringArgumentType.word())
                            .executes(ctx -> {
                                String name = StringArgumentType.getString(ctx, "name");
                                ServerPlayerEntity player = ctx.getSource().getPlayer();
                                if (player == null) {
                                    ctx.getSource().sendFeedback(() -> Text.literal(
                                        "[villagers] /villagers restart must be run by a player — it scatters bots around your position."), false);
                                    return 0;
                                }
                                Vec3d pos = player.getPos();
                                postScenario(ctx.getSource(), "restart", name, (int) pos.x, (int) pos.z);
                                return Command.SINGLE_SUCCESS;
                            })))
            ));
    }

    // ── Eden HTTP helpers ─────────────────────────────────────────────────────

    private static void postScenario(ServerCommandSource source, String action,
                                     String name, int cx, int cz) {
        JsonObject body = new JsonObject();
        body.addProperty("name", name);
        body.addProperty("x", cx);
        body.addProperty("z", cz);

        String url = VillageConfig.INSTANCE.edenAdminUrl + "/scenario/" + action;
        String bodyJson = GSON.toJson(body);
        LOGGER.info("VillagersCommand: POST {} {}", url, bodyJson);

        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(bodyJson))
            .build();

        sendWithRetry(req, MAX_RETRIES)
            .handle((resp, ex) -> {
                if (ex != null) {
                    reportUnreachable(source, ex);
                    return null;
                }
                LOGGER.info("VillagersCommand {}: HTTP {} {}", action, resp.statusCode(), resp.body());
                try {
                    JsonObject root = GSON.fromJson(resp.body(), JsonObject.class);
                    boolean ok = root.has("ok") && root.get("ok").getAsBoolean();
                    String message = root.has("message") ? root.get("message").getAsString() : resp.body();
                    if (ok && root.has("botNames") && root.get("botNames").isJsonArray()) {
                        JsonArray names = root.getAsJsonArray("botNames");
                        activeScenarioBots.clear();
                        for (var el : names) activeScenarioBots.add(el.getAsString());
                        LOGGER.info("VillagersCommand {}: {} (bots: {})", action, message, activeScenarioBots);
                    }
                    final String feedback = "[villagers] " + message;
                    source.getServer().execute(() ->
                        source.sendFeedback(() -> Text.literal(feedback), true));
                } catch (Exception e) {
                    LOGGER.warn("VillagersCommand: failed to parse Eden response: {}", e.getMessage());
                    source.getServer().execute(() ->
                        source.sendFeedback(() ->
                            Text.literal("[villagers] Eden error (HTTP " + resp.statusCode() + ")"), true));
                }
                return null;
            });
    }

    private static void stopScenario(ServerCommandSource source) {
        String url = VillageConfig.INSTANCE.edenAdminUrl + "/scenario/stop";
        LOGGER.info("VillagersCommand: POST {}", url);
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(10))
            .POST(HttpRequest.BodyPublishers.noBody())
            .build();

        sendWithRetry(req, MAX_RETRIES)
            .handle((resp, ex) -> {
                activeScenarioBots.clear();
                if (ex != null) {
                    reportUnreachable(source, ex);
                    return null;
                }
                LOGGER.info("VillagersCommand stop: HTTP {} {}", resp.statusCode(), resp.body());
                String message;
                try {
                    JsonObject root = GSON.fromJson(resp.body(), JsonObject.class);
                    message = root.has("message") ? root.get("message").getAsString() : "stopped";
                } catch (Exception e) {
                    message = "stopped (HTTP " + resp.statusCode() + ")";
                }
                final String feedback = "[villagers] " + message;
                source.getServer().execute(() ->
                    source.sendFeedback(() -> Text.literal(feedback), true));
                return null;
            });
    }

    // ── Transient-failure resilience ──────────────────────────────────────────

    /**
     * Send {@code req} and, on a transient failure, retry the SAME request up to
     * {@code retriesLeft} more times with a short {@link #RETRY_DELAY_MS} delay between
     * attempts. A transient failure is any {@link IOException} (including
     * {@link ConnectException}) — the signatures of an Eden process that is mid-restart:
     * the TCP connect succeeds but the peer closes before writing a response
     * ("received no bytes"), or the port is briefly unbound (connection refused). Eden
     * answers normally a moment later, so a bounded retry hides the blip from players.
     *
     * <p>Fully async — the delay runs on a {@link CompletableFuture#delayedExecutor} thread,
     * never the server thread. The returned future completes exceptionally with the LAST
     * failure only if every attempt fails.
     */
    private static CompletableFuture<HttpResponse<String>> sendWithRetry(HttpRequest req, int retriesLeft) {
        final int attempt = MAX_RETRIES - retriesLeft + 1; // 1-based attempt number for logging
        return HTTP.sendAsync(req, HttpResponse.BodyHandlers.ofString())
            .handle((resp, ex) -> {
                if (ex == null) {
                    if (attempt > 1) {
                        LOGGER.info("VillagersCommand: {} recovered on attempt {}/{} — transient Eden blip hidden from players",
                            req.uri(), attempt, MAX_RETRIES + 1);
                    }
                    return CompletableFuture.completedFuture(resp);
                }
                if (retriesLeft > 0 && isTransient(ex)) {
                    LOGGER.info("VillagersCommand: transient failure on attempt {}/{} ({}); retrying {} in {}ms",
                        attempt, MAX_RETRIES + 1, describeChain(ex), req.uri(), RETRY_DELAY_MS);
                    Executor delayed = CompletableFuture.delayedExecutor(RETRY_DELAY_MS, TimeUnit.MILLISECONDS);
                    return CompletableFuture.supplyAsync(() -> sendWithRetry(req, retriesLeft - 1), delayed)
                        .thenCompose(f -> f);
                }
                return CompletableFuture.<HttpResponse<String>>failedFuture(ex);
            })
            .thenCompose(f -> f);
    }

    /** A transient failure worth retrying: any IOException (ConnectException is a subclass). */
    private static boolean isTransient(Throwable ex) {
        return rootCause(ex) instanceof IOException;
    }

    /**
     * Report a sustained Eden failure to the player on the MAIN thread, with a message
     * tailored to the exception type so it's accurate rather than alarming. Only called
     * once every retry has been exhausted.
     */
    private static void reportUnreachable(ServerCommandSource source, Throwable ex) {
        Throwable cause = rootCause(ex);
        String url = VillageConfig.INSTANCE.edenAdminUrl;
        final String chat;
        if (cause instanceof ConnectException) {
            chat = "[villagers] Eden n'est pas démarré (ou démarre encore) sur " + url + ".";
        } else {
            chat = "[villagers] Eden redémarre — réessaie dans un instant.";
        }
        LOGGER.warn("VillagersCommand: Eden unreachable at {} after {} attempt(s): {}",
            url, MAX_RETRIES + 1, describeChain(ex));
        source.getServer().execute(() ->
            source.sendFeedback(() -> Text.literal(chat), true));
    }

    /** Unwrap CompletionException/ExecutionException so callers see the real I/O cause. */
    private static Throwable rootCause(Throwable ex) {
        Throwable t = ex;
        while ((t instanceof CompletionException || t instanceof ExecutionException) && t.getCause() != null) {
            t = t.getCause();
        }
        return t;
    }

    /** Full cause-chain as "Class: msg → caused by: Class: msg → …" for diagnostics. */
    private static String describeChain(Throwable ex) {
        StringBuilder sb = new StringBuilder();
        Throwable t = ex;
        int guard = 0;
        while (t != null && guard++ < 12) {
            if (sb.length() > 0) sb.append(" → caused by: ");
            sb.append(t.getClass().getName()).append(": ").append(t.getMessage());
            if (t.getCause() == t) break;
            t = t.getCause();
        }
        return sb.toString();
    }
}
