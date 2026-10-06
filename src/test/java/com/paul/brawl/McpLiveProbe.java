package com.paul.brawl;

import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * MCP test bench — a read-only probe of a RUNNING server's MCP endpoints ({@code godAgent = external}), for the
 * in-game checklist's preflight: {@code gradle mcpProbe [-PmcpUrl=http://127.0.0.1:8771] [-PmcpToken=…]} (the token
 * defaults to {@code PAULSBRAWLS_MCP_TOKEN}). It never holds a valid ticket, so nothing it sends can reach the world:
 * <ul>
 *   <li>both endpoints initialize and list exactly the expected tools, each requiring a ticket;</li>
 *   <li>no token, a wrong token and a foreign Origin are refused; GET is 405;</li>
 *   <li>every tool refuses a forged ticket.</li>
 * </ul>
 * Prints one PASS/FAIL line per check; exit code 0 only if all pass. {@link McpLiveProbeTest} runs it against the
 * bench.
 */
public final class McpLiveProbe {

    static final Set<String> GOD_TOOLS = Set.of("appear", "body_call", "body_tools", "change_weather", "end_session",
        "get_player_context", "offer_trade", "punish", "query_terrain", "reward", "say", "spawn_creature", "vanish", "wait");
    static final Set<String> BUILDER_TOOLS = Set.of("begin_sub_build", "end_sub_build", "get_block_info", "get_build_origin",
        "place_block", "place_blocks", "place_line", "query_terrain");

    private static final ObjectMapper JSON = new ObjectMapper();

    private final String base;
    private final String token;
    private final PrintStream out;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(5)).build();
    private final List<String> failures = new ArrayList<>();
    private int checks;

    McpLiveProbe(String base, String token, PrintStream out) {
        this.base = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        this.token = token;
        this.out = out;
    }

    public static void main(String[] args) {
        String base = args.length > 0 ? args[0] : "http://127.0.0.1:8771";
        String token = args.length > 1 ? args[1] : System.getenv("PAULSBRAWLS_MCP_TOKEN");
        if (token == null || token.isBlank()) {
            System.err.println("No token: pass -PmcpToken=… or set PAULSBRAWLS_MCP_TOKEN (mcpToken in god_agent.properties).");
            System.exit(2);
        }
        List<String> failed = new McpLiveProbe(base, token, System.out).run();
        System.exit(failed.isEmpty() ? 0 : 1);
    }

    /** Run every check; returns the failed ones (empty = all passed). */
    List<String> run() {
        out.println("MCP probe of " + base + " (read-only: no valid ticket is ever sent)");
        endpoint("god", AgentMcpServers.GOD_PATH, GOD_TOOLS, "god-");
        endpoint("builder", AgentMcpServers.BUILDER_PATH, BUILDER_TOOLS, "bld-");
        out.println((failures.isEmpty() ? "ALL PASS" : failures.size() + " FAILED") + " (" + checks + " checks)");
        return failures;
    }

    private void endpoint(String name, String path, Set<String> expected, String prefix) {
        check(name + ": initialize", () -> {
            JsonNode r = rpc(path, token, "initialize", Map.of("protocolVersion", "2025-06-18", "capabilities", Map.of(),
                "clientInfo", Map.of("name", "mcp-probe", "version", "1")));
            String server = r.path("result").path("serverInfo").path("name").asText();
            return server.equals("paulsbrawls-" + name) ? null : "serverInfo.name = '" + server + "' in " + r;
        });
        List<JsonNode> tools = new ArrayList<>();
        check(name + ": tools/list is exactly the " + expected.size() + " expected tools", () -> {
            JsonNode r = rpc(path, token, "tools/list", Map.of());
            Set<String> got = new TreeSet<>();
            for (JsonNode t : r.path("result").path("tools")) {
                got.add(t.path("name").asText());
                tools.add(t);
            }
            return got.equals(new TreeSet<>(expected)) ? null : "got " + got;
        });
        check(name + ": every tool requires a ticket", () -> {
            if (tools.isEmpty()) return "no tool listed";
            for (JsonNode t : tools) {
                if (!t.path("inputSchema").path("required").toString().contains("\"ticket\"")) return t.path("name").asText();
            }
            return null;
        });
        check(name + ": no token -> 401", () -> status(post(path, null, null)) == 401 ? null : "not refused");
        check(name + ": wrong token -> 401", () -> status(post(path, "probe-wrong-" + System.nanoTime(), null)) == 401 ? null : "not refused");
        check(name + ": foreign Origin -> 403", () -> status(post(path, token, "http://evil.example")) == 403 ? null : "not refused");
        check(name + ": GET -> 405", () -> {
            HttpRequest req = HttpRequest.newBuilder(URI.create(base + path)).header("Authorization", "Bearer " + token).GET()
                .timeout(Duration.ofSeconds(10)).build();
            int s = http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode();
            return s == 405 ? null : "HTTP " + s;
        });
        for (JsonNode t : tools) {
            String tool = t.path("name").asText();
            check(name + ": " + tool + " refuses a forged ticket", () -> {
                JsonNode r = rpc(path, token, "tools/call", Map.of("name", tool,
                    "arguments", forgedArgs(t.path("inputSchema"), prefix)));
                boolean refused = r.has("error") || r.path("result").path("isError").asBoolean(false);
                return refused ? null : "ACCEPTED: " + r;
            });
        }
    }

    /** Schema-valid arguments whose ticket (and sub_build) are forged, so the call can only be refused. */
    private static Map<String, Object> forgedArgs(JsonNode schema, String prefix) {
        Map<String, Object> a = new java.util.LinkedHashMap<>();
        for (JsonNode req : schema.path("required")) {
            String p = req.asText();
            JsonNode s = schema.path("properties").path(p);
            if (p.equals("ticket")) a.put(p, prefix + "probe-forged");
            else if (p.equals("sub_build")) a.put(p, "sb-probe-forged");
            else if (s.has("enum")) a.put(p, s.path("enum").get(0).asText());
            else a.put(p, switch (s.path("type").asText()) {
                case "integer" -> 0;
                case "number" -> 0.0;
                case "boolean" -> false;
                case "array" -> List.of();
                case "object" -> Map.of();
                default -> "minecraft:stone";
            });
        }
        return a;
    }

    @FunctionalInterface
    private interface Check {
        /** null = pass, else what went wrong. */
        String run() throws Exception;
    }

    private void check(String name, Check c) {
        checks++;
        String problem;
        try {
            problem = c.run();
        } catch (Exception e) {
            problem = e.toString();
        }
        if (problem == null) {
            out.println("PASS " + name);
        } else {
            out.println("FAIL " + name + " -- " + problem);
            failures.add(name);
        }
    }

    private HttpResponse<String> post(String path, String bearer, String origin) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .timeout(Duration.ofSeconds(10))
            .POST(HttpRequest.BodyPublishers.ofString("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}"));
        if (bearer != null) b.header("Authorization", "Bearer " + bearer);
        if (origin != null) b.header("Origin", origin);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static int status(HttpResponse<?> r) {
        return r.statusCode();
    }

    private JsonNode rpc(String path, String bearer, String method, Object params) throws Exception {
        String body = JSON.writeValueAsString(Map.of("jsonrpc", "2.0", "id", 1, "method", method, "params", params));
        HttpRequest req = HttpRequest.newBuilder(URI.create(base + path))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("Authorization", "Bearer " + bearer)
            .timeout(Duration.ofSeconds(20))
            .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> r = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (r.statusCode() != 200) throw new IllegalStateException(method + " -> HTTP " + r.statusCode() + " " + r.body());
        return JSON.readTree(r.body());
    }
}
