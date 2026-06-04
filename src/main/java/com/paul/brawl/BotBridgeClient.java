package com.paul.brawl;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Async HTTP client for the Node-side bridge (see GOD_BOT_INTEGRATION_PLAN.md §4c).
 *
 * <p>Every call is best-effort: a bridge failure must never break the prayer
 * flow. Network errors are swallowed and logged; a downed bridge leaves God
 * working but bodiless.
 *
 * <p>Lives as a singleton because all sessions share one avatar and one bridge.
 */
public class BotBridgeClient {

    private static final Logger LOGGER = LoggerFactory.getLogger("BotBridgeClient");

    public static final BotBridgeClient INSTANCE = new BotBridgeClient();

    private final HttpClient http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2))
        .build();

    private BotBridgeClient() {}

    /** Whether bridge calls should be issued at all. */
    private boolean active() {
        return BridgeConfig.INSTANCE.enabled
            && BridgeConfig.INSTANCE.bridgeUrl != null
            && !BridgeConfig.INSTANCE.bridgeUrl.isBlank();
    }

    public CompletableFuture<Boolean> health() {
        if (!active()) return CompletableFuture.completedFuture(false);
        return get("/health").thenApply(r -> r != null && r.statusCode() >= 200 && r.statusCode() < 300);
    }

    public CompletableFuture<Boolean> appear(double x, double y, double z, String facing) {
        String body;
        if (facing != null && !facing.isBlank()) {
            body = String.format("{\"x\":%s,\"y\":%s,\"z\":%s,\"facing\":%s}",
                num(x), num(y), num(z), jsonString(facing));
        } else {
            body = String.format("{\"x\":%s,\"y\":%s,\"z\":%s}", num(x), num(y), num(z));
        }
        return post("/appear", body);
    }

    public CompletableFuture<Boolean> chat(String message) {
        if (message == null) message = "";
        String body = "{\"message\":" + jsonString(message) + "}";
        return post("/chat", body);
    }

    public CompletableFuture<Boolean> look(double x, double y, double z) {
        String body = String.format("{\"x\":%s,\"y\":%s,\"z\":%s}", num(x), num(y), num(z));
        return post("/look", body);
    }

    public CompletableFuture<Boolean> gesture(String type) {
        if (type == null) type = "";
        String body = "{\"type\":" + jsonString(type) + "}";
        return post("/gesture", body);
    }

    public CompletableFuture<Boolean> vanish() {
        BridgeConfig cfg = BridgeConfig.INSTANCE;
        String body = String.format("{\"x\":%s,\"y\":%s,\"z\":%s}",
            num(cfg.parkingX), num(cfg.parkingY), num(cfg.parkingZ));
        return post("/vanish", body);
    }

    private CompletableFuture<Boolean> post(String path, String jsonBody) {
        if (!active()) return CompletableFuture.completedFuture(false);
        HttpRequest req;
        try {
            req = HttpRequest.newBuilder(URI.create(BridgeConfig.INSTANCE.bridgeUrl + path))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(3))
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8))
                .build();
        } catch (Exception e) {
            LOGGER.warn("bridge {} build failed: {}", path, e.getMessage());
            return CompletableFuture.completedFuture(false);
        }
        return http.sendAsync(req, HttpResponse.BodyHandlers.ofString())
            .handle((resp, ex) -> {
                if (ex != null) {
                    LOGGER.warn("bridge {} failed: {}", path, ex.getMessage());
                    return false;
                }
                if (resp.statusCode() >= 300) {
                    LOGGER.warn("bridge {} returned {}: {}", path, resp.statusCode(), resp.body());
                    return false;
                }
                return true;
            });
    }

    private CompletableFuture<HttpResponse<String>> get(String path) {
        if (!active()) return CompletableFuture.completedFuture(null);
        HttpRequest req;
        try {
            req = HttpRequest.newBuilder(URI.create(BridgeConfig.INSTANCE.bridgeUrl + path))
                .timeout(Duration.ofSeconds(3))
                .GET()
                .build();
        } catch (Exception e) {
            LOGGER.warn("bridge {} build failed: {}", path, e.getMessage());
            return CompletableFuture.completedFuture(null);
        }
        return http.sendAsync(req, HttpResponse.BodyHandlers.ofString())
            .exceptionally(ex -> {
                LOGGER.warn("bridge GET {} failed: {}", path, ex.getMessage());
                return null;
            });
    }

    private static String num(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return "0";
        return String.valueOf(v);
    }

    /** Minimal JSON-string escape. Avoids pulling Jackson here for one field. */
    private static String jsonString(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"':  sb.append("\\\""); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
