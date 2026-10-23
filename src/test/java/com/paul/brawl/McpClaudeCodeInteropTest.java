package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * MCP test bench — interop with <b>Claude Code</b> as the MCP client. The first tests replay, byte for byte, the
 * request shapes Claude Code 2.1.309 sends to an HTTP MCP server (recorded against these servers): its
 * {@code server/discover} probe of the 2026-07-28 draft (answered {@code -32601}, so it falls back to
 * {@code initialize}), {@code initialize} with protocol 2025-11-25, {@code notifications/initialized} and every later
 * request with the {@code Mcp-Protocol-Version} header, the {@code GET} for an SSE stream ({@code 405}: none), a
 * {@code tools/call} whose params carry {@code _meta.claudecode/toolUseId} and a {@code progressToken}, the OAuth
 * discovery probes it makes when no {@code Authorization} header is configured, and a {@code DELETE} of a session.
 *
 * <p>The last test runs the REAL {@code claude} binary ({@code CLAUDE_BIN}, skipped otherwise): {@code claude mcp
 * add --transport http … --header "Authorization: Bearer …"} for both endpoints, then {@code claude mcp list}, in an
 * isolated HOME, and requires both to report connected.
 */
class McpClaudeCodeInteropTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String UA = "claude-code/2.1.309 (sdk-cli)";
    private McpBench bench;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();

    @BeforeEach
    void setUp() throws Exception {
        bench = new McpBench();
    }

    @AfterEach
    void tearDown() {
        bench.close();
    }

    /** One request as Claude Code sends it (its header set; Authorization unless {@code auth} is null). */
    private HttpResponse<String> cc(String method, String path, String auth, Map<String, String> extra, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + bench.port() + path))
            .header("User-Agent", UA)
            .header("Accept-Encoding", "identity");
        if (auth != null) b.header("Authorization", auth);
        if (body != null) {
            b.header("Accept", "application/json, text/event-stream").header("Content-Type", "application/json");
            b.method(method, HttpRequest.BodyPublishers.ofString(body));
        } else {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        }
        extra.forEach(b::header);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static final String BEARER = "Bearer " + McpBench.TOKEN;

    private static final String DISCOVER = "{\"jsonrpc\":\"2.0\",\"id\":\"server-discover-probe-1\",\"method\":\"server/discover\","
        + "\"params\":{\"_meta\":{\"io.modelcontextprotocol/protocolVersion\":\"2026-07-28\",\"io.modelcontextprotocol/clientInfo\":"
        + "{\"name\":\"claude-code\",\"title\":\"Claude Code\",\"version\":\"2.1.309\",\"description\":\"Anthropic's agentic coding tool\","
        + "\"websiteUrl\":\"https://claude.com/claude-code\"},\"io.modelcontextprotocol/clientCapabilities\":{\"roots\":{\"listChanged\":true},"
        + "\"elicitation\":{\"form\":{},\"url\":{}}}}}}";

    private static final String INITIALIZE = "{\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":"
        + "{\"roots\":{\"listChanged\":true},\"elicitation\":{\"form\":{},\"url\":{}}},\"clientInfo\":{\"name\":\"claude-code\","
        + "\"title\":\"Claude Code\",\"version\":\"2.1.309\",\"description\":\"Anthropic's agentic coding tool\","
        + "\"websiteUrl\":\"https://claude.com/claude-code\"}},\"jsonrpc\":\"2.0\",\"id\":0}";

    private static final Map<String, String> V = Map.of("MCP-Protocol-Version", "2025-11-25");

    @ParameterizedTest
    @ValueSource(strings = { "god", "builder" })
    void claudeCodesConnectSequenceIsServed(String server) throws Exception {
        String path = McpBench.path(server);

        // 1. The draft-spec discovery probe: method not found, as JSON in a 200, with the string id echoed.
        HttpResponse<String> r = cc("POST", path, BEARER,
            Map.of("Mcp-Method", "server/discover", "MCP-Protocol-Version", "2026-07-28"), DISCOVER);
        assertEquals(200, r.statusCode(), r.body());
        assertTrue(r.headers().firstValue("Content-Type").orElse("").startsWith("application/json"));
        JsonNode probe = JSON.readTree(r.body());
        assertEquals("server-discover-probe-1", probe.path("id").asText());
        assertEquals(-32601, probe.path("error").path("code").asInt(), "the client falls back to initialize on -32601: " + r.body());

        // 2. initialize, protocol 2025-11-25 (the client's newest stable version): accepted as is.
        r = cc("POST", path, BEARER, Map.of(), INITIALIZE);
        assertEquals(200, r.statusCode(), r.body());
        JsonNode init = JSON.readTree(r.body());
        assertEquals(0, init.path("id").asInt());
        assertEquals("2025-11-25", init.path("result").path("protocolVersion").asText());
        assertTrue(init.path("result").path("capabilities").has("tools"));
        assertTrue(r.headers().firstValue("Mcp-Session-Id").isEmpty(), "stateless: no session, so the client never DELETEs one");

        // 3. notifications/initialized: 202, no body.
        r = cc("POST", path, BEARER, V, "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}");
        assertEquals(202, r.statusCode());
        assertEquals("", r.body());

        // 4. GET for a server-initiated SSE stream: 405 (none), which the client accepts.
        r = cc("GET", path, BEARER, Map.of("Accept", "text/event-stream", "MCP-Protocol-Version", "2025-11-25"), null);
        assertEquals(405, r.statusCode());
        assertEquals("POST", r.headers().firstValue("Allow").orElse(""));

        // 5. tools/list.
        r = cc("POST", path, BEARER, V, "{\"method\":\"tools/list\",\"jsonrpc\":\"2.0\",\"id\":1}");
        assertEquals(200, r.statusCode());
        assertTrue(JSON.readTree(r.body()).path("result").path("tools").size() > 0);
    }

    @Test
    void aToolCallWithClaudeCodesMetaIsServed() throws Exception {
        String ticket = bench.builderTicket("alice");
        String body = "{\"method\":\"tools/call\",\"params\":{\"name\":\"begin_sub_build\",\"arguments\":{\"ticket\":\"" + ticket
            + "\",\"anchor_z\":4,\"label\":\"tour\",\"anchor_y\":0,\"anchor_x\":4},\"_meta\":{\"claudecode/toolUseId\":\"toolu_01\","
            + "\"progressToken\":2}},\"jsonrpc\":\"2.0\",\"id\":2}";
        HttpResponse<String> r = cc("POST", AgentMcpServers.BUILDER_PATH, BEARER, V, body);
        assertEquals(200, r.statusCode(), r.body());
        JsonNode res = JSON.readTree(r.body()).path("result");
        assertFalse(res.path("isError").asBoolean(), r.body());
        assertTrue(res.path("content").path(0).path("text").asText().contains("sub_build=sb-"), r.body());
        assertEquals(1, BuildGuard.active());
    }

    @Test
    void aWrongConfiguredTokenIsA401TheClientReportsAsSuch() throws Exception {
        HttpResponse<String> r = cc("POST", AgentMcpServers.GOD_PATH, "Bearer WRONG", Map.of(), INITIALIZE);
        assertEquals(401, r.statusCode());
        assertEquals("Bearer", r.headers().firstValue("WWW-Authenticate").orElse(""));
        assertFalse(r.body().isBlank(), "Claude Code prints this body as the error detail");
    }

    /** Without an Authorization header, Claude Code tries OAuth discovery and registration: plain 404s, never a 500. */
    @Test
    void oauthDiscoveryProbesAreNotFound() throws Exception {
        assertEquals(401, cc("POST", AgentMcpServers.GOD_PATH, null, Map.of(), INITIALIZE).statusCode());
        for (String p : List.of("/.well-known/oauth-protected-resource/mcp/god", "/.well-known/oauth-protected-resource",
                "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration")) {
            assertEquals(404, cc("GET", p, null, Map.of(), null).statusCode(), p);
        }
        assertEquals(404, cc("POST", "/register", null, Map.of(), "{\"client_name\":\"Claude Code\"}").statusCode());
    }

    @ParameterizedTest
    @ValueSource(strings = { "god", "builder" })
    void aSessionDeleteIsRefusedCleanly(String server) throws Exception {
        HttpResponse<String> r = cc("DELETE", McpBench.path(server), BEARER, Map.of("Mcp-Session-Id", "whatever",
            "MCP-Protocol-Version", "2025-11-25"), null);
        assertEquals(405, r.statusCode(), "no sessions to terminate in the stateless profile");
    }

    /** The real Claude Code CLI registers both endpoints with a bearer header and reports them connected. */
    @Test
    void theRealClaudeCodeCliConnectsToBothServers() throws Exception {
        String bin = System.getenv("CLAUDE_BIN");
        assumeTrue(bin != null && new File(bin).canExecute(), "CLAUDE_BIN not set — skipping the real Claude Code check");
        Path home = Files.createTempDirectory("cc-home");
        Path proj = Files.createTempDirectory("cc-proj");
        try {
            for (String server : List.of("god", "builder")) {
                run(bin, home, proj, "mcp", "add", "--transport", "http", server,
                    "http://127.0.0.1:" + bench.port() + McpBench.path(server), "--header", "Authorization: " + BEARER);
            }
            String out = run(bin, home, proj, "mcp", "list");
            for (String server : List.of("god", "builder")) {
                String line = out.lines().filter(l -> l.startsWith(server + ":")).findFirst().orElse("");
                assertTrue(line.contains("Connected") && !line.contains("Failed"), "claude mcp list: " + out);
            }
        } finally {
            deleteTree(home);
            deleteTree(proj);
        }
    }

    static void deleteTree(Path dir) throws java.io.IOException {
        try (java.util.stream.Stream<Path> s = Files.walk(dir)) {
            s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        }
    }

    /** Run the CLI with an isolated HOME and nothing of this process's Claude/Anthropic environment. */
    static String run(String bin, Path home, Path cwd, String... args) throws Exception {
        List<String> cmd = new ArrayList<>();
        cmd.add(bin);
        cmd.addAll(List.of(args));
        ProcessBuilder pb = new ProcessBuilder(cmd).directory(cwd.toFile()).redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        Map<String, String> keep = new LinkedHashMap<>();
        keep.put("PATH", new File(bin).getAbsoluteFile().getParent() + File.pathSeparator + "/usr/bin:/bin");
        env.clear();
        env.putAll(keep);
        env.put("HOME", home.toString());
        env.put("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
        Process p = pb.start();
        p.getOutputStream().close();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(p.waitFor(90, TimeUnit.SECONDS), "claude " + String.join(" ", args) + " hung: " + out);
        assertEquals(0, p.exitValue(), "claude " + String.join(" ", args) + ": " + out);
        return out;
    }
}
