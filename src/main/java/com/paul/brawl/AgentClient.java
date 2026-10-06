package com.paul.brawl;

import java.io.IOException;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The mod's client for the external agent's HTTP server — {@code opencode serve} (docs/27 §6). Three calls:
 * create a session, send one message and wait for the whole agent turn ({@code POST /session/:id/message} is
 * synchronous: it returns once the tool loop has finished), and abort a running turn. Blocking; callers run it on a
 * virtual thread, never the server thread. Minecraft-free.
 */
public final class AgentClient {

    /** What went wrong, so the caller can pick the French message (docs/27 §6 failure table). */
    public enum Failure { DOWN, TIMEOUT, ERROR }

    /** One agent turn: the final assistant text, or a failure with its detail (for the log). */
    public record Reply(String text, Failure failure, String detail) {
        static Reply ok(String text) { return new Reply(text, null, null); }
        static Reply fail(Failure f, String detail) { return new Reply("", f, detail); }
        public boolean ok() { return failure == null; }
    }

    /** Thrown by {@link #createSession} when the agent cannot be reached or refuses. */
    public static final class AgentException extends Exception {
        final Failure failure;
        AgentException(Failure failure, String message) {
            super(message);
            this.failure = failure;
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    private final String baseUrl;
    private final String authorization;
    private final HttpClient http;

    /** {@code password} blank → no Authorization header (opencode without OPENCODE_SERVER_PASSWORD). */
    public AgentClient(String baseUrl, String username, String password) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.authorization = password == null || password.isBlank() ? null
            : "Basic " + Base64.getEncoder().encodeToString((username + ":" + password).getBytes(StandardCharsets.UTF_8));
        // HTTP/1.1: the JDK client otherwise asks a plain-http server for an h2c upgrade, which opencode's (Bun)
        // server leaves unanswered — every request hangs until its timeout.
        this.http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).build();
    }

    /** {@code POST /session}; returns the new session id. */
    public String createSession(String title) throws AgentException {
        Map<String, Object> body = Map.of("title", title);
        HttpResponse<String> r = send(post("/session", body, Duration.ofSeconds(30)));
        try {
            String id = JSON.readTree(r.body()).path("id").asText("");
            if (id.isEmpty()) throw new AgentException(Failure.ERROR, "no session id in " + abbreviate(r.body()));
            return id;
        } catch (IOException e) {
            throw new AgentException(Failure.ERROR, "bad session JSON: " + e.getMessage());
        }
    }

    /**
     * {@code POST /session/:id/message} with {@code agent}, one text part and an optional PNG/JPEG part (sent as a
     * {@code data:} URL file part), waiting at most {@code timeout} for the whole turn.
     */
    public Reply send(String sessionId, String agent, String text, byte[] image, Duration timeout) {
        List<Map<String, Object>> parts = new ArrayList<>();
        parts.add(Map.of("type", "text", "text", text));
        if (image != null && image.length > 0) {
            String mime = ImageMime.sniff(image);
            parts.add(Map.of("type", "file", "mime", mime, "filename", "capture." + (mime.endsWith("jpeg") ? "jpg" : "png"),
                "url", "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(image)));
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("agent", agent);
        body.put("parts", parts);
        HttpResponse<String> r;
        try {
            r = send(post("/session/" + sessionId + "/message", body, timeout));
        } catch (AgentException e) {
            return Reply.fail(e.failure, e.getMessage());
        }
        return parseReply(r.body());
    }

    /** {@code POST /session/:id/abort}; best-effort. */
    public void abort(String sessionId) {
        try {
            send(post("/session/" + sessionId + "/abort", Map.of(), Duration.ofSeconds(10)));
        } catch (AgentException ignored) {
            // nothing more to do: the turn is being abandoned anyway
        }
    }

    /** The final assistant text of a {@code {info, parts}} reply, or the error it carries. Package-private for tests. */
    static Reply parseReply(String json) {
        JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (IOException e) {
            return Reply.fail(Failure.ERROR, "bad reply JSON: " + e.getMessage());
        }
        JsonNode error = root.path("info").path("error");
        if (!error.isMissingNode() && !error.isNull()) {
            return Reply.fail(Failure.ERROR, abbreviate(error.toString()));
        }
        StringBuilder sb = new StringBuilder();
        for (JsonNode p : root.path("parts")) {
            if ("text".equals(p.path("type").asText()) && !p.path("synthetic").asBoolean(false)) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(p.path("text").asText(""));
            }
        }
        return Reply.ok(sb.toString().strip());
    }

    private HttpRequest post(String path, Object body, Duration timeout) throws AgentException {
        String json;
        try {
            json = JSON.writeValueAsString(body);
        } catch (IOException e) {
            throw new AgentException(Failure.ERROR, e.getMessage());
        }
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + path))
            .timeout(timeout)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(json));
        if (authorization != null) b.header("Authorization", authorization);
        return b.build();
    }

    private HttpResponse<String> send(HttpRequest req) throws AgentException {
        HttpResponse<String> r;
        try {
            r = http.send(req, HttpResponse.BodyHandlers.ofString());
        } catch (HttpTimeoutException e) {
            throw new AgentException(Failure.TIMEOUT, "no answer within " + req.timeout().orElse(null));
        } catch (ConnectException e) {
            throw new AgentException(Failure.DOWN, "agent unreachable at " + baseUrl + ": " + e);
        } catch (IOException e) {
            // A reset or closed connection mid-turn: the agent process died.
            throw new AgentException(Failure.DOWN, "agent connection lost: " + e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AgentException(Failure.TIMEOUT, "interrupted");
        }
        if (r.statusCode() / 100 != 2) {
            throw new AgentException(Failure.ERROR, "HTTP " + r.statusCode() + ": " + abbreviate(r.body()));
        }
        return r;
    }

    private static String abbreviate(String s) {
        if (s == null) return "";
        return s.length() > 300 ? s.substring(0, 300) + "…" : s;
    }
}
