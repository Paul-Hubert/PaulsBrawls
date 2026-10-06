package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.File;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * docs/27 phase 5, end to end: the REAL opencode binary ({@code opencode serve}) running the repo's
 * {@code god-agent/} agents, permissions and prompts, connected to the REAL god/builder MCP servers, driven by the
 * REAL {@link AgentTurns}. Two things are stand-ins: the LLM ({@link ScriptedLlm}, an OpenAI-compatible script) and
 * Minecraft (recording world ports).
 *
 * <p>Needs Node and opencode, so it only runs when {@code OPENCODE_BIN} points at the binary
 * ({@code npm i opencode-ai} → {@code node_modules/.bin/opencode}); otherwise every test is skipped.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@org.junit.jupiter.api.TestMethodOrder(org.junit.jupiter.api.MethodOrderer.OrderAnnotation.class)
class AgentE2ETest {

    private static final String TOKEN = "e2e-mcp-token";
    private static final String PASSWORD = "e2e-agent-password";
    private static final ObjectMapper JSON = new ObjectMapper();
    /** A 1×1 PNG, the shape of a /build screenshot. */
    private static final byte[] PNG = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC");

    private final UUID alice = UUID.randomUUID();
    private final UUID bob = UUID.randomUUID();
    private Path dir;
    private ScriptedLlm llm;
    private RecordingGodWorld world;
    private RecordingBuildWorld buildWorld;
    private AgentTickets tickets;
    private SubBuilds subBuilds;
    private AgentMcpServers servers;
    private Process opencode;
    private int agentPort;
    private GodAgentConfig cfg;
    private AgentTurns turns;

    @BeforeAll
    void startEverything() throws Exception {
        String bin = System.getenv("OPENCODE_BIN");
        assumeTrue(bin != null && new File(bin).canExecute(), "OPENCODE_BIN not set — skipping the opencode e2e test");

        llm = new ScriptedLlm();
        world = new RecordingGodWorld();
        world.online.addAll(List.of(alice, bob));
        buildWorld = new RecordingBuildWorld();
        buildWorld.online.addAll(List.of(alice, bob));
        buildWorld.origins.put(alice, new int[] { 100, 64, 200 });
        tickets = new AgentTickets();
        subBuilds = new SubBuilds(System::currentTimeMillis, 120_000);
        GodService god = new GodService(world, BridgeConfig.INSTANCE);
        servers = AgentMcpServers.start(0, () -> TOKEN, god, new RecordingBodyTools(), () -> true,
            new BuildService(buildWorld), tickets, subBuilds);

        dir = Files.createTempDirectory("god-agent-e2e");
        copyAgentConfig(Path.of("god-agent"), dir.resolve("god-agent"), servers.port(), llm.port());
        agentPort = freePort();
        ProcessBuilder pb = new ProcessBuilder(bin, "serve", "--port", Integer.toString(agentPort), "--hostname", "127.0.0.1")
            .directory(dir.resolve("god-agent").toFile())
            .redirectErrorStream(true)
            .redirectOutput(dir.resolve("opencode.log").toFile());
        Map<String, String> env = pb.environment();
        env.put("PAULSBRAWLS_MCP_TOKEN", TOKEN);
        env.put("OPENCODE_SERVER_PASSWORD", PASSWORD);
        env.put("OPENCODE_CONFIG", dir.resolve("god-agent/opencode.json").toString());
        env.put("XDG_DATA_HOME", dir.resolve("xdg-data").toString());
        env.put("XDG_CONFIG_HOME", dir.resolve("xdg-config").toString());
        env.put("XDG_CACHE_HOME", dir.resolve("xdg-cache").toString());
        env.put("XDG_STATE_HOME", dir.resolve("xdg-state").toString());
        opencode = pb.start();
        awaitMcpConnected();

        cfg = new GodAgentConfig(dir.resolve("god_agent.properties"));
        cfg.agentUrl = "http://127.0.0.1:" + agentPort;
        cfg.agentPassword = PASSWORD;
        cfg.turnTimeoutSeconds = 60;
        cfg.buildTurnTimeoutSeconds = 120;
        turns = new AgentTurns(new AgentClient(cfg.agentUrl, cfg.agentUsername, PASSWORD), god,
            new BuildService(buildWorld), tickets, subBuilds, cfg);
        GodSessionManager.addEndListener(turns::onSessionEnded);
    }

    @AfterAll
    void stopEverything() throws Exception {
        if (opencode != null) {
            opencode.destroy();
            opencode.waitFor(10, TimeUnit.SECONDS);
            opencode.destroyForcibly();
        }
        if (servers != null) servers.close();
        if (llm != null) llm.close();
        GodSessionManager.forceEndSession();
        if (dir != null) {
            try (Stream<Path> s = Files.walk(dir)) {
                s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            }
        }
    }

    @BeforeEach
    void clean() {
        GodSessionManager.forceEndSession();
        BuildGuard.resetForTests();
        world.calls.clear();
        buildWorld.placed.clear();
        llm.seen.clear();
        llm.delayMillis = 0;
    }

    @Test
    void aPrayerRunsThroughOpencodeIntoTheWorld() throws Exception {
        Thread t = turns.pray(alice, "Alice", "Ô Dieu, accorde-moi un signe.", null);
        assertNotNull(t);
        t.join(60_000);
        assertEquals(List.of("tell Dieu : Je t'ai entendu."), world.calls.stream().filter(c -> c.startsWith("tell")).toList(),
            "the agent spoke through say; its (empty) final text is not repeated");
        assertTrue(world.calls.contains("give minecraft:diamond x2"), world.calls.toString());
        assertTrue(world.calls.stream().anyMatch(c -> c.startsWith("appear")), world.calls.toString());
        assertTrue(world.calls.contains("vanish"), "the encounter ends with the body going home");
        assertFalse(GodSessionManager.isBusy(), "and the avatar is released");
        assertEquals(0, tickets.size(), "the ticket died with the turn");

        ScriptedLlm.Seen godCall = llm.seen.stream().filter(s -> s.tools().contains("god_say")).findFirst().orElseThrow();
        assertTrue(godCall.tools().stream().allMatch(n -> n.startsWith("god_")),
            "the god agent is offered ONLY god_* tools (no bash/edit/webfetch, no builder_*): " + godCall.tools());
        assertTrue(godCall.lastUser().contains("god-"), "the prayer carries the ticket");
    }

    @Test
    void aTurnThatNeverSaysAnythingIsSpokenForIt() throws Exception {
        turns.pray(alice, "Alice", "SILENT bonjour", null).join(60_000);
        assertEquals(List.of("tell Dieu : Je t'ai entendu, mortel."), world.calls);
        assertFalse(GodSessionManager.isBusy());
    }

    @Test
    void aSecondPlayerIsRefusedAndNeverReachesTheAgent() {
        assertTrue(GodSessionManager.claim(alice));
        assertNull(turns.pray(bob, "Bob", "moi aussi", null));
        assertEquals(List.of("tell " + AgentTurns.BUSY), world.calls);
        assertTrue(llm.seen.isEmpty(), "the agent was not called for Bob");
    }

    @Test
    void aBuildPlansSubBuildersThatPlaceThroughTheBuilderServer() throws Exception {
        Thread t = turns.build(alice, "Alice", "Build : une tour de guet", PNG);
        assertNotNull(t);
        t.join(120_000);
        assertEquals(5, buildWorld.placed.size(), "place_line (0,0,0)->(0,4,0) at anchor (4,0,4): " + buildWorld.placed);
        assertEquals("104,64,204 minecraft:stone", buildWorld.placed.get(0));
        assertEquals("104,68,204 minecraft:stone", buildWorld.placed.get(4));
        assertEquals(0, BuildGuard.active(), "the sub-builder released its slot");
        assertEquals(List.of("tell Dieu : Une tour de guet se dresse au nord."), world.calls);

        ScriptedLlm.Seen planner = llm.seen.stream().filter(s -> s.tools().contains("task")).findFirst().orElseThrow();
        assertTrue(planner.image(), "the /build screenshot reached the model as an image");
        assertTrue(planner.tools().stream().allMatch(n -> n.startsWith("builder_") || n.equals("task")), planner.tools().toString());
        ScriptedLlm.Seen sub = llm.seen.stream().filter(s -> s.tools().contains("builder_place_line") && !s.tools().contains("task"))
            .findFirst().orElseThrow();
        assertTrue(sub.tools().stream().allMatch(n -> n.startsWith("builder_")), "a sub-builder has only builder_* tools: " + sub.tools());
    }

    @Test
    void aPrayerAndABuildRunConcurrentlyInSeparateSessions() throws Exception {
        llm.delayMillis = 1500; // every model call takes 1.5 s
        long t0 = System.nanoTime();
        Thread prayer = turns.pray(alice, "Alice", "SILENT bonjour", null);  // 1 model call
        Thread build = turns.build(alice, "Alice", "Build : une tour", null); // 6 model calls
        prayer.join(120_000);
        build.join(120_000);
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertEquals(5, buildWorld.placed.size());
        assertTrue(world.calls.contains("tell Dieu : Je t'ai entendu, mortel."));
        assertTrue(ms < 7 * 1500 + 6000, "the prayer did not wait behind the build (" + ms + " ms)");
    }

    @Test
    void anUnreachableAgentIsAFrenchMessageAndAReleasedAvatar() throws Exception {
        GodAgentConfig down = new GodAgentConfig(dir.resolve("down.properties"));
        down.agentUrl = "http://127.0.0.1:" + freePort();
        AgentTurns dead = new AgentTurns(new AgentClient(down.agentUrl, "opencode", ""), new GodService(world, BridgeConfig.INSTANCE),
            new BuildService(buildWorld), tickets, subBuilds, down);
        dead.pray(alice, "Alice", "allô ?", null).join(30_000);
        assertEquals(List.of("tell " + AgentTurns.DOWN), world.calls);
        assertFalse(GodSessionManager.isBusy());
    }

    @Test
    void theWatchdogPathAbortsTheAgentAndKillsTheTicket() throws Exception {
        Thread t = turns.pray(alice, "Alice", "SLOW réfléchis longuement", null);
        awaitTrue(() -> world.calls.stream().anyMatch(c -> c.startsWith("appear")), 30_000);
        Thread.sleep(500); // the model is now stuck on the next call
        GodSessionManager.forceEndSession(); // what the idle watchdog / /pray stop / /godbody off do
        t.join(60_000);
        assertFalse(t.isAlive(), "the turn returned instead of waiting for the model");
        assertEquals(List.of("tell " + AgentTurns.ENDED), world.calls.stream().filter(c -> c.startsWith("tell")).toList());
        assertEquals(0, tickets.size());
    }

    /** Runs last: it kills opencode. docs/26 §6 "kill the agent process mid-session". */
    @Test
    @org.junit.jupiter.api.Order(Integer.MAX_VALUE)
    void theAgentProcessDyingMidTurnEndsTheEncounter() throws Exception {
        Thread t = turns.pray(alice, "Alice", "SLOW et meurs", null);
        awaitTrue(() -> world.calls.stream().anyMatch(c -> c.startsWith("appear")), 30_000);
        Thread.sleep(500);
        assertTrue(GodSessionManager.hasManifested(), "God is out in front of the player");
        opencode.destroyForcibly();
        t.join(60_000);
        assertFalse(t.isAlive());
        assertEquals(List.of("tell " + AgentTurns.DOWN), world.calls.stream().filter(c -> c.startsWith("tell")).toList(),
            "the player is told in French");
        assertTrue(world.calls.contains("vanish"), "the body is sent home and made mortal again");
        assertFalse(GodSessionManager.isBusy(), "and the avatar is free");
    }

    // -- helpers ---------------------------------------------------------------------------------------------------

    /** The repo's god-agent/ with only the model and the two URLs pointed at the test's stand-ins. */
    private static void copyAgentConfig(Path from, Path to, int mcpPort, int llmPort) throws IOException {
        try (Stream<Path> s = Files.walk(from)) {
            for (Path p : (Iterable<Path>) s::iterator) {
                Path target = to.resolve(from.relativize(p).toString());
                if (Files.isDirectory(p)) Files.createDirectories(target);
                else Files.copy(p, target);
            }
        }
        Path cfgFile = to.resolve("opencode.json");
        ObjectNode c = (ObjectNode) JSON.readTree(Files.readString(cfgFile));
        c.put("model", "mock/mock");
        c.set("provider", JSON.readTree("{\"mock\":{\"npm\":\"@ai-sdk/openai-compatible\",\"name\":\"Mock\","
            + "\"options\":{\"baseURL\":\"http://127.0.0.1:" + llmPort + "/v1\",\"apiKey\":\"x\"},"
            + "\"models\":{\"mock\":{\"name\":\"mock\",\"attachment\":true,\"modalities\":{\"input\":[\"text\",\"image\"],\"output\":[\"text\"]}}}}}"));
        ((ObjectNode) c.path("mcp").path("god")).put("url", "http://127.0.0.1:" + mcpPort + AgentMcpServers.GOD_PATH);
        ((ObjectNode) c.path("mcp").path("builder")).put("url", "http://127.0.0.1:" + mcpPort + AgentMcpServers.BUILDER_PATH);
        Files.writeString(cfgFile, JSON.writerWithDefaultPrettyPrinter().writeValueAsString(c), StandardCharsets.UTF_8);
    }

    private void awaitMcpConnected() throws Exception {
        HttpClient http = HttpClient.newHttpClient();
        String auth = "Basic " + Base64.getEncoder().encodeToString(("opencode:" + PASSWORD).getBytes(StandardCharsets.UTF_8));
        long deadline = System.currentTimeMillis() + 60_000;
        String last = "";
        while (System.currentTimeMillis() < deadline) {
            try {
                HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + agentPort + "/mcp"))
                    .header("Authorization", auth).timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString());
                last = r.body();
                if (r.statusCode() == 200) {
                    JsonNode n = JSON.readTree(r.body());
                    if ("connected".equals(n.path("god").path("status").asText())
                            && "connected".equals(n.path("builder").path("status").asText())) {
                        return;
                    }
                }
            } catch (IOException e) {
                last = e.toString();
            }
            Thread.sleep(500);
        }
        throw new AssertionError("opencode never connected to both MCP servers: " + last + "\n"
            + Files.readString(dir.resolve("opencode.log")));
    }

    private static void awaitTrue(java.util.function.BooleanSupplier cond, long ms) throws InterruptedException {
        long deadline = System.currentTimeMillis() + ms;
        while (!cond.getAsBoolean()) {
            if (System.currentTimeMillis() > deadline) throw new AssertionError("timed out");
            Thread.sleep(100);
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }
}
