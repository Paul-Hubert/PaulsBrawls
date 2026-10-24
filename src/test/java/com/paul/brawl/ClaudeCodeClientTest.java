package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * {@link ClaudeCodeClient}'s pure parts (command line, stdin message, result and stream parsing) and its failures
 * without a working binary. The process contract itself is pinned against the real {@code claude} by
 * {@link ClaudeCodeE2ETest}.
 */
class ClaudeCodeClientTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode json(String s) throws Exception {
        return JSON.readTree(s);
    }

    @Test
    void theCommandLineIsHeadlessIsolatedAndPerSession() {
        ClaudeCodeClient c = new ClaudeCodeClient("claude", Path.of("god-agent", "claude-code"), "sonnet", Map.of());
        String sid = c.createSession("Prière — Alice");
        List<String> cmd = c.command(sid, "god");
        assertEquals("claude", cmd.get(0));
        assertTrue(cmd.containsAll(List.of("-p", "--strict-mcp-config", "--verbose")), cmd.toString());
        assertEquals("stream-json", cmd.get(cmd.indexOf("--input-format") + 1));
        assertEquals("stream-json", cmd.get(cmd.indexOf("--output-format") + 1));
        assertEquals("god", cmd.get(cmd.indexOf("--agent") + 1));
        assertEquals("project", cmd.get(cmd.indexOf("--setting-sources") + 1), "no user or local settings, hooks or memory");
        assertEquals("dontAsk", cmd.get(cmd.indexOf("--permission-mode") + 1), "nothing the settings do not allow runs");
        assertTrue(cmd.get(cmd.indexOf("--mcp-config") + 1).endsWith(".mcp.json"));
        assertTrue(cmd.get(cmd.indexOf("--settings") + 1).endsWith("settings.json"));
        assertEquals(sid, cmd.get(cmd.indexOf("--session-id") + 1), "the first turn creates the session");
        assertFalse(cmd.contains("--resume"));
        assertEquals("sonnet", cmd.get(cmd.indexOf("--model") + 1));
        assertFalse(new ClaudeCodeClient("claude", Path.of("x"), " ", Map.of()).command(sid, "god").contains("--model"),
            "a blank model is Claude Code's default");
        assertFalse(cmd.contains("--effort"), "no effort set = Claude Code's default");
        List<String> high = new ClaudeCodeClient("claude", Path.of("x"), "opus", " high ", Map.of()).command(sid, "builder");
        assertEquals("high", high.get(high.indexOf("--effort") + 1));
        assertFalse(sid.equals(c.createSession("again")), "every session is new");
    }

    @Test
    void theInputIsOneUtf8UserMessageWithTheImageAsABase64Block() throws Exception {
        byte[] png = { (byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3 };
        JsonNode m = json(ClaudeCodeClient.inputLine("Prière de Zoé : « aide-moi »", png));
        assertEquals("user", m.path("type").asText());
        JsonNode content = m.path("message").path("content");
        assertEquals("Prière de Zoé : « aide-moi »", content.path(0).path("text").asText());
        assertEquals("image", content.path(1).path("type").asText());
        assertEquals("image/png", content.path(1).path("source").path("media_type").asText());
        assertEquals("base64", content.path(1).path("source").path("type").asText());
        assertEquals(1, json(ClaudeCodeClient.inputLine("sans image", null)).path("message").path("content").size());
    }

    @Test
    void aResultIsTheFinalTextOrAnError() throws Exception {
        AgentBackend.Reply ok = ClaudeCodeClient.parseResult(json(
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"  Approche, mortel.  \"}"));
        assertTrue(ok.ok());
        assertEquals("Approche, mortel.", ok.text());
        AgentBackend.Reply err = ClaudeCodeClient.parseResult(json(
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"API Error: 400 bad request\"}"));
        assertEquals(AgentBackend.Failure.ERROR, err.failure());
        assertTrue(err.detail().contains("API Error"));
        assertEquals(AgentBackend.Failure.ERROR, ClaudeCodeClient.parseResult(json(
            "{\"type\":\"result\",\"subtype\":\"error_max_turns\",\"is_error\":false}")).failure());
    }

    @Test
    void onlyARefusedKeyStopsTheRetries() throws Exception {
        assertTrue(ClaudeCodeClient.fatalApiError(json("{\"subtype\":\"api_retry\",\"error_status\":401,\"error\":\"authentication_failed\"}"))
            .contains("401"));
        assertTrue(ClaudeCodeClient.fatalApiError(json("{\"subtype\":\"api_retry\",\"error_status\":403}")) != null);
        assertNull(ClaudeCodeClient.fatalApiError(json("{\"subtype\":\"api_retry\",\"error_status\":529,\"error\":\"overloaded\"}")));
        assertNull(ClaudeCodeClient.fatalApiError(json("{\"subtype\":\"api_retry\",\"error_status\":429}")));
    }

    @Test
    void anMcpServerThatIsNotConnectedIsAProblem() throws Exception {
        assertNull(ClaudeCodeClient.mcpProblem(json("[{\"name\":\"god\",\"status\":\"connected\"},{\"name\":\"builder\",\"status\":\"pending\"}]")));
        assertTrue(ClaudeCodeClient.mcpProblem(json("[{\"name\":\"god\",\"status\":\"failed\"}]")).contains("'god' is failed"));
        assertTrue(ClaudeCodeClient.mcpProblem(json("[{\"name\":\"builder\",\"status\":\"needs-auth\"}]")) != null);
    }

    @Test
    void loopbackBypassesAnyProxy() {
        Map<String, String> env = new java.util.HashMap<>(Map.of("HTTPS_PROXY", "http://proxy:3128", "no_proxy", "corp.example, 10.*"));
        ClaudeCodeClient.bypassProxyForLoopback(env);
        assertEquals("corp.example,10.*,127.0.0.1,localhost,::1", env.get("NO_PROXY"));
        assertEquals(env.get("NO_PROXY"), env.get("no_proxy"));
        Map<String, String> empty = new java.util.HashMap<>();
        ClaudeCodeClient.bypassProxyForLoopback(empty);
        assertEquals("127.0.0.1,localhost,::1", empty.get("NO_PROXY"));
        ClaudeCodeClient.bypassProxyForLoopback(empty);
        assertEquals("127.0.0.1,localhost,::1", empty.get("NO_PROXY"), "idempotent");
    }

    @Test
    void subAgentsAreSynchronousAndTheTurnIsNotNested() {
        // Background sub-agents are cancelled 10 min after the builder's last reply (a live build was cut off).
        Map<String, String> env = new java.util.HashMap<>(Map.of("CLAUDECODE", "1"));
        ClaudeCodeClient.agentEnvironment(env);
        assertEquals("1", env.get("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"));
        assertFalse(env.containsKey("CLAUDECODE"));
        assertEquals("127.0.0.1,localhost,::1", env.get("NO_PROXY"));
    }

    @Test
    void aMissingBinaryOrDirectoryIsDown() throws Exception {
        Path dir = Files.createTempDirectory("cc-client");
        try {
            ClaudeCodeClient noBin = new ClaudeCodeClient(dir.resolve("no-claude-here").toString(), dir, "", Map.of());
            AgentBackend.Reply r = noBin.send(noBin.createSession("t"), "god", "allô", null, Duration.ofSeconds(5));
            assertEquals(AgentBackend.Failure.DOWN, r.failure());
            assertTrue(r.detail().contains("cannot start"), r.detail());
            ClaudeCodeClient noDir = new ClaudeCodeClient("claude", dir.resolve("missing"), "", Map.of());
            assertEquals(AgentBackend.Failure.DOWN, noDir.send("s", "god", "allô", null, Duration.ofSeconds(5)).failure());
            noBin.abort("unknown-session"); // a no-op, never a throw
        } finally {
            Files.deleteIfExists(dir);
        }
    }

    @Test
    void theConfigPicksTheBackend() throws Exception {
        Path f = Files.createTempFile("god_agent", ".properties");
        try {
            Files.writeString(f, "godAgent=external\nagentKind=claude-code\nclaudeBin=/opt/claude\nclaudeDir=agents/cc\nclaudeModel=opus\n");
            GodAgentConfig cfg = new GodAgentConfig(f);
            assertTrue(cfg.claudeCode());
            assertEquals("/opt/claude", cfg.claudeBin);
            assertEquals("agents/cc", cfg.claudeDir);
            assertEquals("opus", cfg.claudeModel);
            assertInstanceOf(ClaudeCodeClient.class, ExternalAgent.backend(cfg));
            cfg.save();
            GodAgentConfig again = new GodAgentConfig(f);
            assertEquals("claude-code", again.agentKind);
            assertEquals("agents/cc", again.claudeDir);

            Files.writeString(f, "godAgent=external\n");
            GodAgentConfig dflt = new GodAgentConfig(f);
            assertFalse(dflt.claudeCode(), "opencode stays the default");
            assertInstanceOf(AgentClient.class, ExternalAgent.backend(dflt));
        } finally {
            Files.deleteIfExists(f);
        }
    }

    /** god-agent/claude-code/.claude/agents/*.md = frontmatter + EXACTLY god-agent/prompts/*.md (one persona, two runtimes). */
    @Test
    void theClaudeCodeAgentsUseTheSamePromptsAsOpencode() throws Exception {
        Map<String, String> tools = Map.of("god", "mcp__god__*", "builder", "Agent(sub-builder), mcp__builder__*",
            "sub-builder", "mcp__builder__*");
        for (var e : tools.entrySet()) {
            // Line endings normalized: Git for Windows checks these out with CRLF (core.autocrlf), which is not drift.
            String agent = Files.readString(Path.of("god-agent", "claude-code", ".claude", "agents", e.getKey() + ".md"))
                .replace("\r\n", "\n");
            String prompt = Files.readString(Path.of("god-agent", "prompts", e.getKey() + ".md")).replace("\r\n", "\n");
            assertTrue(agent.startsWith("---\nname: " + e.getKey() + "\n"), e.getKey());
            int end = agent.indexOf("\n---\n", 4);
            String front = agent.substring(0, end);
            assertTrue(front.contains("\ntools: " + e.getValue()), e.getKey() + " tools: " + front);
            assertEquals(prompt, agent.substring(end + 5), e.getKey() + ".md drifted from prompts/" + e.getKey() + ".md");
        }
        JsonNode settings = JSON.readTree(Path.of("god-agent", "claude-code", "settings.json").toFile());
        assertEquals("dontAsk", settings.path("permissions").path("defaultMode").asText());
        assertEquals(List.of("mcp__god", "mcp__builder", "Agent(sub-builder)"),
            JSON.convertValue(settings.path("permissions").path("allow"), List.class));
        for (String denied : List.of("Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch")) {
            assertTrue(settings.path("permissions").path("deny").toString().contains("\"" + denied + "\""), denied);
        }
        JsonNode mcp = JSON.readTree(Path.of("god-agent", "claude-code", ".mcp.json").toFile()).path("mcpServers");
        for (String server : List.of("god", "builder")) {
            assertEquals("http", mcp.path(server).path("type").asText());
            assertTrue(mcp.path(server).path("url").asText().endsWith("/mcp/" + server));
            assertEquals("Bearer ${PAULSBRAWLS_MCP_TOKEN}", mcp.path(server).path("headers").path("Authorization").asText());
        }
    }
}
