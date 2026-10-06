package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.ConnectException;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * MCP test bench — the wire protocol of both endpoints (stateless Streamable HTTP, JSON-RPC 2.0, MCP 2025-06-18),
 * spoken raw so nothing is hidden by a client library: initialize, ping, notifications, error codes, ids, HTTP
 * methods, paths, auth, Origin, body limits, and robustness after garbage.
 */
class McpProtocolConformanceTest {

    private McpBench bench;

    @BeforeEach
    void setUp() throws Exception {
        bench = new McpBench();
    }

    @AfterEach
    void tearDown() {
        bench.close();
    }

    private static Map<String, Object> initParams(String version) {
        return Map.of("protocolVersion", version, "capabilities", Map.of(),
            "clientInfo", Map.of("name", "bench", "version", "1"));
    }

    // -- JSON-RPC / MCP ---------------------------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(strings = { "god", "builder" })
    void initializeDescribesTheServer(String server) throws Exception {
        JsonNode r = bench.rpc(McpBench.path(server), "initialize", initParams("2025-06-18")).path("result");
        assertEquals("2025-06-18", r.path("protocolVersion").asText());
        assertEquals("paulsbrawls-" + server, r.path("serverInfo").path("name").asText());
        assertFalse(r.path("instructions").asText().isBlank(), "instructions tell the agent about tickets");
        assertTrue(r.path("capabilities").has("tools"), "tools capability advertised");
    }

    @ParameterizedTest
    @ValueSource(strings = { "god", "builder" })
    void anUnknownProtocolVersionIsAnsweredWithASupportedOne(String server) throws Exception {
        JsonNode r = bench.rpc(McpBench.path(server), "initialize", initParams("2099-01-01")).path("result");
        String v = r.path("protocolVersion").asText();
        assertFalse(v.isBlank());
        assertTrue(v.compareTo("2099-01-01") < 0, "the server offers its own version, not the client's: " + v);
    }

    @ParameterizedTest
    @ValueSource(strings = { "god", "builder" })
    void pingAnswersEmpty(String server) throws Exception {
        JsonNode r = bench.rpc(McpBench.path(server), "ping", null);
        assertTrue(r.has("result") && !r.has("error"), r.toString());
    }

    @ParameterizedTest
    @ValueSource(strings = { "god", "builder" })
    void anUnknownMethodIsMethodNotFound(String server) throws Exception {
        JsonNode r = bench.rpc(McpBench.path(server), "resources/list", null);
        assertEquals(-32601, r.path("error").path("code").asInt(), r.toString());
    }

    @ParameterizedTest
    @ValueSource(strings = { "god", "builder" })
    void anUnknownToolIsAnErrorNotACrash(String server) throws Exception {
        JsonNode r = bench.rawCall(McpBench.path(server), "rm_rf", Map.of("ticket", "x"));
        boolean rpcError = r.has("error");
        boolean toolError = r.path("result").path("isError").asBoolean(false);
        assertTrue(rpcError || toolError, r.toString());
        assertTrue(bench.snapshot().isEmpty());
    }

    @ParameterizedTest
    @ValueSource(strings = { "god", "builder" })
    void toolsListIsWellFormed(String server) throws Exception {
        JsonNode tools = bench.rpc(McpBench.path(server), "tools/list", Map.of()).path("result").path("tools");
        assertTrue(tools.size() >= 8, tools.toString());
        for (JsonNode t : tools) {
            String name = t.path("name").asText();
            assertTrue(name.matches("[a-z_]{2,64}"), "tool name usable by every agent: " + name);
            assertFalse(t.path("description").asText().isBlank(), name + " has a description");
            JsonNode s = t.path("inputSchema");
            assertEquals("object", s.path("type").asText(), name);
            assertFalse(s.path("additionalProperties").asBoolean(true), name + " closes its schema");
            for (JsonNode req : s.path("required")) {
                assertTrue(s.path("properties").has(req.asText()), name + " requires an undeclared " + req);
            }
            for (var p : (Iterable<Map.Entry<String, JsonNode>>) s.path("properties")::fields) {
                assertTrue(p.getValue().has("type"), name + "." + p.getKey() + " has a type");
                assertTrue(p.getValue().has("description"), name + "." + p.getKey() + " has a description");
            }
        }
    }

    @Test
    void aNotificationIsAcceptedWith202AndNoBody() throws Exception {
        HttpResponse<String> r = bench.post(AgentMcpServers.GOD_PATH, Map.of(),
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}");
        assertEquals(202, r.statusCode());
        assertTrue(r.body().isEmpty());
    }

    @Test
    void stringAndNumberIdsAreEchoed() throws Exception {
        HttpResponse<String> r = bench.post(AgentMcpServers.GOD_PATH, Map.of(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"abc-\\\"q\\\"\",\"method\":\"ping\"}");
        assertEquals(200, r.statusCode());
        assertTrue(r.body().contains("\"id\":\"abc-\\\"q\\\"\""), r.body());
        r = bench.post(AgentMcpServers.GOD_PATH, Map.of(), "{\"jsonrpc\":\"2.0\",\"id\":9007199254740991,\"method\":\"ping\"}");
        assertTrue(r.body().contains("\"id\":9007199254740991"), r.body());
    }

    @Test
    void responsesAreJson() throws Exception {
        HttpResponse<String> r = bench.post(AgentMcpServers.BUILDER_PATH, Map.of(), McpTestClients.INIT);
        assertTrue(r.headers().firstValue("Content-Type").orElse("").startsWith("application/json"));
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "{not json", "", "[]", "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}]", "42", "null",
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}", "{\"jsonrpc\":\"2.0\"}", "{\"id\":1}",
    })
    void malformedMessagesAre400NotACrash(String body) throws Exception {
        HttpResponse<String> r = bench.post(AgentMcpServers.GOD_PATH, Map.of(), body);
        assertEquals(400, r.statusCode(), body + " → " + r.body());
        assertTrue(r.body().contains("\"jsonrpc\":\"2.0\"") && r.body().contains("\"error\""), r.body());
    }

    /** Regression: "params": 0 used to escape the SDK as an IllegalArgumentException and come back as HTTP 500. */
    @ParameterizedTest
    @ValueSource(strings = { "0", "[1]", "\"x\"", "{\"name\":null}", "{\"name\":\"say\",\"arguments\":[1,2]}",
        "{\"name\":\"say\",\"arguments\":\"ticket\"}", "{\"name\":[\"say\"]}", "{}" })
    void badToolCallParamsAreAnErrorEnvelope(String params) throws Exception {
        HttpResponse<String> r = bench.post(AgentMcpServers.GOD_PATH, Map.of(),
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":" + params + "}");
        assertEquals(200, r.statusCode(), params + " → " + r.body());
        JsonNode env = new com.fasterxml.jackson.databind.ObjectMapper().readTree(r.body());
        assertEquals(7, env.path("id").asInt(), r.body());
        assertTrue(env.has("error") || env.path("result").path("isError").asBoolean(false), params + " → " + r.body());
        assertTrue(bench.snapshot().isEmpty());
    }

    @Test
    void theServerSurvivesAStormOfGarbage() throws Exception {
        for (int i = 0; i < 200; i++) {
            String junk = switch (i % 4) {
                case 0 -> "{\"jsonrpc\":\"2.0\",\"id\":" + i + ",\"method\":\"tools/call\",\"params\":" + i + "}";
                case 1 -> "{\"jsonrpc\":\"2.0\",\"id\":" + i + ",\"method\":\"tools/call\",\"params\":{\"name\":null}}";
                case 2 -> "\u0000\u0001ÿ".repeat(i);
                default -> "{\"jsonrpc\":\"2.0\",\"id\":" + i + ",\"method\":\"tools/call\",\"params\":{\"name\":\"say\",\"arguments\":[1,2]}}";
            };
            int s = bench.post(AgentMcpServers.GOD_PATH, Map.of(), junk).statusCode();
            assertTrue(s == 200 || s == 400, "garbage #" + i + " → HTTP " + s);
        }
        assertTrue(bench.rpc(AgentMcpServers.GOD_PATH, "ping", null).has("result"), "still answering");
        assertTrue(bench.snapshot().isEmpty(), "garbage never reaches the world");
    }

    // -- HTTP ------------------------------------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(strings = { "GET", "DELETE", "PUT", "PATCH" })
    void onlyPostIsServed(String method) throws Exception {
        HttpResponse<String> r = bench.send(method, AgentMcpServers.GOD_PATH, Map.of());
        assertEquals(405, r.statusCode());
        assertEquals("POST", r.headers().firstValue("Allow").orElse(""));
    }

    @ParameterizedTest
    @ValueSource(strings = { "/mcp/godx", "/mcp/god/", "/mcp/god/extra", "/mcp/builder2", "/mcp", "/", "/mcp/GOD" })
    void otherPathsAre404(String path) throws Exception {
        assertEquals(404, bench.post(path, Map.of(), McpTestClients.INIT).statusCode(), path);
    }

    @Test
    void theBodyCapIsOneMebibyte() throws Exception {
        String head = McpTestClients.INIT.substring(0, McpTestClients.INIT.length() - 1);
        String atCap = head + " ".repeat(McpHttpEndpoint.MAX_BODY_BYTES - McpTestClients.INIT.length()) + "}";
        assertEquals(McpHttpEndpoint.MAX_BODY_BYTES, atCap.length());
        assertEquals(200, bench.post(AgentMcpServers.GOD_PATH, Map.of(), atCap).statusCode(), "exactly at the cap");
        assertEquals(413, bench.post(AgentMcpServers.GOD_PATH, Map.of(), atCap + " ").statusCode(), "one byte over");
    }

    // -- auth and origin ---------------------------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(strings = { "", "Bearer", "Bearer ", "Basic YmVuY2g6dG9rZW4=", "bench-token", "Bearer bench-toke",
        "Bearer bench-tokenX", "Bearer  bench-token x", "Token bench-token", "Bearerbench-token" })
    void badCredentialsAre401(String authorization) throws Exception {
        HttpResponse<String> r = bench.post(AgentMcpServers.GOD_PATH, Map.of("Authorization", authorization), McpTestClients.INIT);
        assertEquals(401, r.statusCode(), "'" + authorization + "'");
        assertEquals("Bearer", r.headers().firstValue("WWW-Authenticate").orElse(""));
    }

    @ParameterizedTest
    @ValueSource(strings = { "Bearer bench-token", "bearer bench-token", "BEARER bench-token", "Bearer   bench-token  " })
    void theSchemeIsCaseInsensitiveAndSpacesAreTrimmed(String authorization) throws Exception {
        assertEquals(200, bench.post(AgentMcpServers.GOD_PATH, Map.of("Authorization", authorization), McpTestClients.INIT).statusCode());
    }

    @Test
    void authIsCheckedBeforeTheMethodSoNothingLeaksWithoutAToken() throws Exception {
        assertEquals(401, bench.send("GET", AgentMcpServers.GOD_PATH, Map.of("Authorization", "")).statusCode());
    }

    @ParameterizedTest
    @ValueSource(strings = { "http://evil.example", "null", "http://localhost.evil.example", "http://127.0.0.1.nip.io",
        "http://192.168.1.10:8771", "file://", "::::", "http://[::2]:80" })
    void foreignOriginsAre403(String origin) throws Exception {
        assertEquals(403, bench.post(AgentMcpServers.BUILDER_PATH, Map.of("Origin", origin), McpTestClients.INIT).statusCode(), origin);
    }

    @ParameterizedTest
    @ValueSource(strings = { "http://localhost", "http://localhost:3000", "https://LOCALHOST", "http://127.0.0.1:9",
        "http://[::1]:5173" })
    void loopbackOriginsAreAllowed(String origin) throws Exception {
        assertEquals(200, bench.post(AgentMcpServers.BUILDER_PATH, Map.of("Origin", origin), McpTestClients.INIT).statusCode(), origin);
    }

    @Test
    void aBlankConfiguredTokenRefusesEveryone() throws Exception {
        try (AgentMcpServers s = AgentMcpServers.start(0, () -> "  ", new GodService(new RecordingGodWorld(), BridgeConfig.INSTANCE),
                new RecordingBodyTools(), () -> true, new BuildService(new RecordingBuildWorld()), new AgentTickets(), new SubBuilds(System::currentTimeMillis, 1000))) {
            for (String auth : List.of("Bearer ", "Bearer   ", "Bearer x")) {
                assertEquals(401, McpTestClients.rawPost(s.port(), AgentMcpServers.GOD_PATH, Map.of("Authorization", auth),
                    McpTestClients.INIT).statusCode(), auth);
            }
        }
    }

    @Test
    void theTokenIsReadPerRequestSoRotationTakesEffect() throws Exception {
        AtomicReference<String> token = new AtomicReference<>("one");
        try (AgentMcpServers s = AgentMcpServers.start(0, token::get, new GodService(new RecordingGodWorld(), BridgeConfig.INSTANCE),
                new RecordingBodyTools(), () -> true, new BuildService(new RecordingBuildWorld()), new AgentTickets(), new SubBuilds(System::currentTimeMillis, 1000))) {
            Map<String, String> one = Map.of("Authorization", "Bearer one");
            assertEquals(200, McpTestClients.rawPost(s.port(), AgentMcpServers.GOD_PATH, one, McpTestClients.INIT).statusCode());
            token.set("two");
            assertEquals(401, McpTestClients.rawPost(s.port(), AgentMcpServers.GOD_PATH, one, McpTestClients.INIT).statusCode());
            assertEquals(200, McpTestClients.rawPost(s.port(), AgentMcpServers.GOD_PATH, Map.of("Authorization", "Bearer two"),
                McpTestClients.INIT).statusCode());
        }
    }

    @Test
    void aClosedServerRefusesConnections() throws Exception {
        int port = bench.port();
        bench.servers.close();
        Exception e = assertThrows(Exception.class, () -> McpTestClients.rawPost(port, AgentMcpServers.GOD_PATH,
            Map.of("Authorization", "Bearer " + McpBench.TOKEN), McpTestClients.INIT));
        assertTrue(e instanceof ConnectException || e.getCause() instanceof ConnectException
            || e instanceof java.io.IOException, e.toString());
    }

    @Test
    void textSurvivesTheRoundTripIntact() throws Exception {
        String ticket = bench.godTicket("alice");
        String line = "Écoute, mortel 🌩️ — « ça » \"quoted\" \\ back\nslash\ttab";
        JsonNode r = bench.rawCall(AgentMcpServers.GOD_PATH, "say", Map.of("ticket", ticket, "message", line));
        assertFalse(r.path("result").path("isError").asBoolean(true), r.toString());
        assertEquals("tell Dieu : " + line.strip(), bench.godWorld.calls.get(0));
    }
}
