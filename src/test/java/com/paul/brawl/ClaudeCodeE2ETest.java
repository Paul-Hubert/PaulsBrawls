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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Stream;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

/**
 * {@code agentKind = claude-code}, end to end: the REAL Claude Code binary ({@code claude -p}, one process per turn)
 * running the repo's {@code god-agent/claude-code/} agents, settings and MCP config, connected to the REAL god/builder
 * MCP servers, driven by the REAL {@link AgentTurns} through {@link ClaudeCodeClient}. Two things are stand-ins: the
 * LLM ({@link ScriptedAnthropic}, an Anthropic Messages API script reached through {@code ANTHROPIC_BASE_URL}) and
 * Minecraft (recording world ports). Each process gets an isolated HOME and nothing of this JVM's environment.
 *
 * <p>Runs only when {@code CLAUDE_BIN} points at the {@code claude} executable; otherwise every test is skipped.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ClaudeCodeE2ETest {

    private static final String TOKEN = "cc-e2e-mcp-token";
    private static final byte[] PNG = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC");
    /** Tools Claude Code adds to every request that are not callable (a cache placeholder for deferred tools). */
    private static final Set<String> PLACEHOLDERS = Set.of("DeferredToolPlaceholder");

    private final UUID alice = UUID.randomUUID();
    private final UUID bob = UUID.randomUUID();
    private String bin;
    private Path dir;
    private ScriptedAnthropic llm;
    private RecordingGodWorld world;
    private RecordingBuildWorld buildWorld;
    private AgentTickets tickets;
    private SubBuilds subBuilds;
    private AgentMcpServers servers;
    private GodService god;
    private GodAgentConfig cfg;
    private AgentTurns turns;

    @BeforeAll
    void startEverything() throws Exception {
        bin = System.getenv("CLAUDE_BIN");
        assumeTrue(bin != null && new File(bin).canExecute(), "CLAUDE_BIN not set — skipping the Claude Code e2e test");
        llm = new ScriptedAnthropic();
        world = new RecordingGodWorld();
        world.online.addAll(List.of(alice, bob));
        buildWorld = new RecordingBuildWorld();
        buildWorld.online.addAll(List.of(alice, bob));
        buildWorld.origins.put(alice, new int[] { 100, 64, 200 });
        tickets = new AgentTickets();
        subBuilds = new SubBuilds(System::currentTimeMillis, 120_000);
        god = new GodService(world, BridgeConfig.INSTANCE);
        servers = AgentMcpServers.start(0, () -> TOKEN, god, new RecordingBodyTools(), () -> true,
            new BuildService(buildWorld), tickets, subBuilds);

        dir = Files.createTempDirectory("claude-code-e2e");
        copyTree(Path.of("god-agent", "claude-code"), dir.resolve("claude-code")); // the repo's config, unchanged
        Files.createDirectories(dir.resolve("home"));
        cfg = new GodAgentConfig(dir.resolve("god_agent.properties"));
        cfg.agentKind = GodAgentConfig.CLAUDE_CODE;
        cfg.turnTimeoutSeconds = 60;
        cfg.buildTurnTimeoutSeconds = 120;
        turns = turns(client(env(servers.port())));
        GodSessionManager.addEndListener(t -> turns.onSessionEnded(t));
    }

    private Map<String, String> env(int mcpPort) {
        return Map.of(
            "PATH", new File(bin).getAbsoluteFile().getParent() + File.pathSeparator + "/usr/bin:/bin",
            "HOME", dir.resolve("home").toString(),
            "ANTHROPIC_BASE_URL", llm.baseUrl(),
            "ANTHROPIC_API_KEY", "sk-ant-e2e-dummy",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1",
            GodAgentConfig.TOKEN_ENV, TOKEN,
            ClaudeCodeClient.MCP_URL_ENV, "http://127.0.0.1:" + mcpPort);
    }

    private ClaudeCodeClient client(Map<String, String> env) {
        return new ClaudeCodeClient(bin, dir.resolve("claude-code"), "", env, true);
    }

    private AgentTurns turns(AgentBackend backend) {
        return new AgentTurns(backend, god, new BuildService(buildWorld), tickets, subBuilds, cfg);
    }

    @AfterAll
    void stopEverything() throws Exception {
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
        turns.resetGod(alice);
        turns.resetBuild(alice);
    }

    private List<String> tells() {
        return world.calls.stream().filter(c -> c.startsWith("tell")).toList();
    }

    private static List<String> callable(ScriptedAnthropic.Seen s) {
        return s.tools().stream().filter(n -> !PLACEHOLDERS.contains(n)).toList();
    }

    @Test
    void aPrayerRunsThroughClaudeCodeIntoTheWorld() throws Exception {
        Thread t = turns.pray(alice, "Alice", "Ô Dieu, accorde-moi un signe.", null);
        assertNotNull(t);
        t.join(60_000);
        assertEquals(List.of("tell Dieu : Je t'ai entendu."), tells(), "the agent spoke through say: " + world.calls);
        assertTrue(world.calls.contains("give minecraft:diamond x2"), world.calls.toString());
        assertTrue(world.calls.stream().anyMatch(c -> c.startsWith("appear")), world.calls.toString());
        assertTrue(world.calls.contains("vanish"), "the encounter ends with the body going home");
        assertFalse(GodSessionManager.isBusy(), "and the avatar is released");
        assertEquals(0, tickets.size(), "the ticket died with the turn");

        ScriptedAnthropic.Seen godCall = llm.seen.stream().filter(s -> s.tools().contains("mcp__god__say")).findFirst().orElseThrow();
        assertTrue(callable(godCall).stream().allMatch(n -> n.startsWith("mcp__god__")),
            "the god agent is offered ONLY mcp__god__* tools (no Bash/Read/Edit/WebFetch/Agent, no builder): " + godCall.tools());
        assertEquals(14, callable(godCall).size(), godCall.tools().toString());
        assertTrue(godCall.lastUser().contains("god-"), "the prayer carries the ticket");
        assertTrue(godCall.lastUser().contains("Prière de Alice") && godCall.lastUser().contains("Ô Dieu"),
            "French text reaches the model intact (stdin is UTF-8): " + godCall.lastUser());
        assertTrue(godCall.system().contains("Tu joues le rôle de Dieu"), "the god agent's prompt is the system prompt");
    }

    @Test
    void aTurnThatNeverSaysAnythingIsSpokenForIt() throws Exception {
        turns.pray(alice, "Alice", "SILENT bonjour", null).join(60_000);
        assertEquals(List.of("tell Dieu : Je t'ai entendu, mortel."), world.calls);
        assertFalse(GodSessionManager.isBusy());
    }

    @Test
    void aProofImageReachesTheModel() throws Exception {
        turns.pray(alice, "Alice", "SILENT voici ma preuve", PNG).join(60_000);
        ScriptedAnthropic.Seen godCall = llm.seen.stream().filter(s -> s.tools().contains("mcp__god__say")).findFirst().orElseThrow();
        assertTrue(godCall.image(), "the /prove screenshot reached the model as an image block");
    }

    @Test
    void thePlayersConversationIsResumedUntilReset() throws Exception {
        turns.pray(alice, "Alice", "SILENT première prière", null).join(60_000);
        turns.pray(alice, "Alice", "SILENT seconde prière", null).join(60_000);
        ScriptedAnthropic.Seen second = last("seconde prière");
        assertTrue(second.body().path("messages").toString().contains("première prière"),
            "the second turn resumes the first one's session (--resume)");
        turns.resetGod(alice); // /pray reset
        turns.pray(alice, "Alice", "SILENT troisième prière", null).join(60_000);
        ScriptedAnthropic.Seen third = last("troisième prière");
        assertFalse(third.body().path("messages").toString().contains("première prière"), "/pray reset starts a fresh session");
    }

    private ScriptedAnthropic.Seen last(String marker) {
        ScriptedAnthropic.Seen found = null;
        for (ScriptedAnthropic.Seen s : List.copyOf(llm.seen)) {
            if (s.tools().contains("mcp__god__say") && s.lastUser().contains(marker)) found = s;
        }
        assertNotNull(found, "no god request with '" + marker + "'");
        return found;
    }

    @Test
    void aSecondPlayerIsRefusedAndNeverReachesTheAgent() {
        assertTrue(GodSessionManager.claim(alice));
        assertNull(turns.pray(bob, "Bob", "moi aussi", null));
        assertEquals(List.of("tell " + AgentTurns.BUSY), world.calls);
        assertTrue(llm.seen.isEmpty(), "the agent was not called for Bob");
    }

    @Test
    void aBuildPlansSubAgentsThatPlaceThroughTheBuilderServer() throws Exception {
        Thread t = turns.build(alice, "Alice", "Build : une tour de guet", PNG);
        assertNotNull(t);
        t.join(120_000);
        assertEquals(5, buildWorld.placed.size(), "place_line (0,0,0)->(0,4,0) at anchor (4,0,4): " + buildWorld.placed);
        assertEquals("104,64,204 minecraft:stone", buildWorld.placed.get(0));
        assertEquals("104,68,204 minecraft:stone", buildWorld.placed.get(4));
        assertEquals(0, BuildGuard.active(), "the sub-builder released its slot");
        assertEquals(List.of("tell Dieu : Une tour de guet se dresse au nord."), world.calls,
            "the planner's LAST answer (after its background sub-agent finished) is told");

        ScriptedAnthropic.Seen planner = llm.seen.stream()
            .filter(s -> s.tools().contains("Agent") || s.tools().contains("Task")).findFirst().orElseThrow();
        assertTrue(planner.image(), "the /build screenshot reached the planner as an image");
        assertTrue(callable(planner).stream().allMatch(n -> n.startsWith("mcp__builder__") || n.equals("Agent") || n.equals("Task")),
            "the builder has only builder tools and the sub-agent tool: " + planner.tools());
        assertTrue(planner.system().contains("sub-builder") && !planner.system().contains("- general-purpose"),
            "the only sub-agent offered is sub-builder");
        ScriptedAnthropic.Seen sub = llm.seen.stream()
            .filter(s -> s.tools().contains("mcp__builder__place_line") && !s.tools().contains("Agent") && !s.tools().contains("Task"))
            .findFirst().orElseThrow();
        assertTrue(callable(sub).stream().allMatch(n -> n.startsWith("mcp__builder__")), "a sub-builder has only builder tools: " + sub.tools());
    }

    @Test
    void aPrayerAndABuildRunConcurrentlyInSeparateProcesses() throws Exception {
        llm.delayMillis = 1500; // every model call takes 1.5 s; the build needs about 7 of them
        long t0 = System.nanoTime();
        Thread prayer = turns.pray(alice, "Alice", "SILENT bonjour", null);
        Thread build = turns.build(alice, "Alice", "Build : une tour", null);
        prayer.join(60_000);
        long prayerMs = (System.nanoTime() - t0) / 1_000_000;
        build.join(120_000);
        assertTrue(world.calls.contains("tell Dieu : Je t'ai entendu, mortel."), world.calls.toString());
        assertEquals(5, buildWorld.placed.size());
        assertTrue(prayerMs < 4 * 1500 + 5000, "the prayer did not wait behind the build (" + prayerMs + " ms)");
    }

    @Test
    void anUnstartableClaudeIsAFrenchMessageAndAReleasedAvatar() throws Exception {
        AgentTurns dead = turns(new ClaudeCodeClient(dir.resolve("no-such-claude").toString(), dir.resolve("claude-code"), "",
            env(servers.port()), true));
        dead.pray(alice, "Alice", "allô ?", null).join(30_000);
        assertEquals(List.of("tell " + AgentTurns.DOWN), world.calls);
        assertFalse(GodSessionManager.isBusy());
    }

    @Test
    void unreachableMcpServersAreDownNotASilentToollessTurn() throws Exception {
        AgentTurns noMcp = turns(client(env(freePort())));
        noMcp.pray(alice, "Alice", "SILENT allô ?", null).join(60_000);
        assertEquals(List.of("tell " + AgentTurns.DOWN), world.calls, "a turn without its tools must not answer in God's name");
        assertFalse(GodSessionManager.isBusy());
    }

    @Test
    void anApiErrorIsTheOracleFailing() throws Exception {
        turns.pray(alice, "Alice", "BADKEY bonjour", null).join(60_000);
        assertEquals(List.of("tell " + AgentTurns.ERROR), world.calls);
        assertFalse(GodSessionManager.isBusy());
    }

    @Test
    void theWatchdogPathKillsTheProcessAndTheTicket() throws Exception {
        Thread t = turns.pray(alice, "Alice", "SLOW réfléchis longuement", null);
        awaitTrue(() -> world.calls.stream().anyMatch(c -> c.startsWith("appear")), 30_000);
        Thread.sleep(500); // the model is now stuck on the next call
        long before = claudeProcesses();
        assertTrue(before >= 1, "a claude process runs the turn");
        GodSessionManager.forceEndSession(); // what the idle watchdog / /pray stop / /godbody off do
        t.join(30_000);
        assertFalse(t.isAlive(), "the turn returned instead of waiting for the model");
        assertEquals(List.of("tell " + AgentTurns.ENDED), tells());
        assertEquals(0, tickets.size());
        awaitTrue(() -> claudeProcesses() == 0, 10_000);
    }

    @Test
    void aTurnLongerThanTheTimeoutIsKilled() throws Exception {
        GodAgentConfig quick = new GodAgentConfig(dir.resolve("quick.properties"));
        quick.turnTimeoutSeconds = 5;
        AgentTurns q = new AgentTurns(client(env(servers.port())), god, new BuildService(buildWorld), tickets, subBuilds, quick);
        q.pray(alice, "Alice", "SLOW trop long", null).join(60_000);
        assertEquals(List.of("tell " + AgentTurns.TIMEOUT), tells());
        assertTrue(world.calls.contains("vanish"));
        assertFalse(GodSessionManager.isBusy());
        awaitTrue(() -> claudeProcesses() == 0, 10_000);
    }

    @Test
    void theAgentProcessDyingMidTurnEndsTheEncounter() throws Exception {
        Thread t = turns.pray(alice, "Alice", "SLOW et meurs", null);
        awaitTrue(() -> world.calls.stream().anyMatch(c -> c.startsWith("appear")), 30_000);
        Thread.sleep(500);
        assertTrue(GodSessionManager.hasManifested(), "God is out in front of the player");
        ProcessHandle.current().descendants().filter(ClaudeCodeE2ETest::isClaude).forEach(ProcessHandle::destroyForcibly);
        t.join(30_000);
        assertFalse(t.isAlive());
        assertEquals(List.of("tell " + AgentTurns.DOWN), tells(), "the player is told in French");
        assertTrue(world.calls.contains("vanish"), "the body is sent home and made mortal again");
        assertFalse(GodSessionManager.isBusy(), "and the avatar is free");
    }

    // -- helpers ---------------------------------------------------------------------------------------------------

    private long claudeProcesses() {
        return ProcessHandle.current().descendants().filter(ClaudeCodeE2ETest::isClaude).count();
    }

    private static boolean isClaude(ProcessHandle h) {
        String bin = System.getenv("CLAUDE_BIN");
        return h.isAlive() && h.info().command().map(c -> c.endsWith("claude") || c.equals(bin)
            || c.contains("claude-code")).orElse(false);
    }

    private static void copyTree(Path from, Path to) throws IOException {
        try (Stream<Path> s = Files.walk(from)) {
            for (Path p : (Iterable<Path>) s::iterator) {
                Path target = to.resolve(from.relativize(p).toString());
                if (Files.isDirectory(p)) Files.createDirectories(target);
                else Files.copy(p, target);
            }
        }
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
