package com.paul.brawl.squad;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.function.BiConsumer;
import java.util.function.Supplier;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * The mod's side of the squad runtime's control API (docs/29 §10). Minecraft-free (SquadClientTest).
 * <ul>
 *   <li>{@link #post} never throws and never hangs: an unreachable runtime, a timeout or a broken answer completes
 *       with {@code {ok:false, text:"[Bots] Le runtime des bots est injoignable…"}}, so every caller just shows
 *       {@code text}.</li>
 *   <li>HTTP/1.1 is forced: the JDK client otherwise asks for an h2c upgrade (the AgentClient lesson).</li>
 *   <li>{@link #streamEvents} blocks on the SSE stream and hands each event to a callback; it returns when the
 *       stream ends, and the caller reconnects.</li>
 * </ul>
 */
public final class SquadClient {

    public static final String UNREACHABLE = "[Bots] Le runtime des bots est injoignable (est-il lancé ? cd squad ; npm start).";

    private static final Gson GSON = new Gson();

    private final Supplier<String> baseUrl;
    private final Supplier<String> token;
    private final HttpClient http;
    private final Duration timeout;

    public SquadClient(Supplier<String> baseUrl, Supplier<String> token, Duration timeout) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.timeout = timeout;
        this.http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(3)).build();
    }

    /** POST {@code body} to {@code path} (e.g. {@code /api/orders/start}); always completes with a JSON object. */
    public CompletableFuture<JsonObject> post(String path, JsonObject body) {
        HttpRequest req;
        try {
            req = HttpRequest.newBuilder(URI.create(baseUrl.get() + path))
                .timeout(timeout)
                .header("Authorization", "Bearer " + token.get())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(body), StandardCharsets.UTF_8))
                .build();
        } catch (IllegalArgumentException e) {
            return CompletableFuture.completedFuture(failure("[Bots] URL du runtime invalide : " + baseUrl.get()));
        }
        return http.sendAsync(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
            .handle((res, err) -> {
                if (err != null) return failure(UNREACHABLE);
                if (res.statusCode() == 401) return failure("[Bots] Le runtime refuse le token : PAULSBRAWLS_SQUAD_TOKEN doit être le même des deux côtés.");
                try {
                    JsonElement el = JsonParser.parseString(res.body());
                    if (el.isJsonObject()) return el.getAsJsonObject();
                } catch (RuntimeException ignored) {
                    // fall through
                }
                return failure("[Bots] Réponse illisible du runtime (HTTP " + res.statusCode() + ").");
            });
    }

    /**
     * Read the SSE stream until it ends: {@code onEvent(event, dataJson)} for each event. Returns normally when the
     * stream closes; throws when it cannot connect (the caller backs off and retries).
     */
    public void streamEvents(BiConsumer<String, JsonObject> onEvent) throws IOException, InterruptedException {
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl.get() + "/events"))
            .header("Authorization", "Bearer " + token.get())
            .header("Accept", "text/event-stream")
            .GET()
            .build();
        HttpResponse<InputStream> res = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
        if (res.statusCode() != 200) {
            res.body().close();
            throw new IOException("events: HTTP " + res.statusCode());
        }
        try (BufferedReader r = new BufferedReader(new InputStreamReader(res.body(), StandardCharsets.UTF_8))) {
            readSse(r, onEvent);
        }
    }

    /** The SSE framing (package-private for tests): {@code event:} and {@code data:} lines, a blank line ends one. */
    static void readSse(BufferedReader r, BiConsumer<String, JsonObject> onEvent) throws IOException {
        String event = "message";
        StringBuilder data = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) {
            if (line.isEmpty()) {
                if (data.length() > 0) {
                    JsonObject json;
                    try {
                        JsonElement el = JsonParser.parseString(data.toString());
                        json = el.isJsonObject() ? el.getAsJsonObject() : new JsonObject();
                    } catch (RuntimeException e) {
                        json = new JsonObject();
                    }
                    onEvent.accept(event, json);
                }
                event = "message";
                data.setLength(0);
            } else if (line.startsWith("event:")) {
                event = line.substring(6).trim();
            } else if (line.startsWith("data:")) {
                if (data.length() > 0) data.append('\n');
                data.append(line.substring(5).trim());
            }
            // ":" comments (keep-alive pings) and unknown fields are ignored
        }
    }

    public static JsonObject failure(String text) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", false);
        o.addProperty("text", text);
        return o;
    }
}
