package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * {@link AgentTurns}' turn bookkeeping: a second {@code /build} or prayer while a turn is running must be refused
 * WITHOUT touching the running turn's ticket. The thing under test is AgentTurns with the real {@link AgentClient};
 * opencode is replaced by {@link HeldAgent}, which answers a turn only when the test releases it (the opencode
 * contract itself is pinned by {@link AgentE2ETest}).
 */
class AgentTurnsTest {

    private static final Pattern TICKET = Pattern.compile("(god|bld)-[A-Za-z0-9_-]+");

    /** opencode's three routes; every turn blocks until {@link #release} and its prompt is recorded. */
    static final class HeldAgent implements AutoCloseable {
        final List<String> prompts = Collections.synchronizedList(new ArrayList<>());
        final CountDownLatch release = new CountDownLatch(1);
        final AtomicInteger aborts = new AtomicInteger();
        private final AtomicInteger sessions = new AtomicInteger();
        private final HttpServer http;

        HeldAgent() throws IOException {
            http = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
            http.createContext("/session", this::handle);
            http.setExecutor(Executors.newThreadPerTaskExecutor(Thread.ofVirtual().factory()));
            http.start();
        }

        String url() {
            return "http://127.0.0.1:" + http.getAddress().getPort();
        }

        private void handle(HttpExchange ex) throws IOException {
            String path = ex.getRequestURI().getPath();
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (path.equals("/session")) {
                reply(ex, "{\"id\":\"ses_" + sessions.incrementAndGet() + "\"}");
            } else if (path.endsWith("/abort")) {
                aborts.incrementAndGet();
                reply(ex, "true");
            } else {
                prompts.add(body);
                try {
                    release.await(30, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                reply(ex, "{\"info\":{\"role\":\"assistant\"},\"parts\":[{\"type\":\"text\",\"text\":\"Fini.\"}]}");
            }
        }

        private static void reply(HttpExchange ex, String json) throws IOException {
            byte[] b = json.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(200, b.length);
            try (OutputStream out = ex.getResponseBody()) {
                out.write(b);
            }
        }

        @Override
        public void close() {
            release.countDown();
            http.stop(0);
        }
    }

    private final UUID alice = UUID.randomUUID();
    private HeldAgent agent;
    private RecordingGodWorld world;
    private RecordingBuildWorld buildWorld;
    private AgentTickets tickets;
    private AgentTurns turns;

    @BeforeEach
    void setUp() throws Exception {
        GodSessionManager.forceEndSession();
        BuildGuard.resetForTests();
        agent = new HeldAgent();
        world = new RecordingGodWorld();
        world.online.add(alice);
        buildWorld = new RecordingBuildWorld();
        buildWorld.online.add(alice);
        buildWorld.origins.put(alice, new int[] { 0, 64, 0 });
        tickets = new AgentTickets();
        Path cfgFile = Files.createTempFile("god_agent", ".properties");
        Files.writeString(cfgFile, "godAgent=external\n");
        GodAgentConfig cfg = new GodAgentConfig(cfgFile);
        turns = new AgentTurns(new AgentClient(agent.url(), "opencode", ""), new GodService(world, BridgeConfig.INSTANCE),
            new BuildService(buildWorld), tickets, new SubBuilds(System::currentTimeMillis, 120_000), cfg);
    }

    @AfterEach
    void tearDown() {
        agent.close();
        GodSessionManager.forceEndSession();
    }

    /** Wait until the agent has received {@code n} turns; returns the ticket of turn {@code n}. */
    private String ticketOfTurn(int n) throws InterruptedException {
        for (int i = 0; i < 200 && agent.prompts.size() < n; i++) Thread.sleep(25);
        assertTrue(agent.prompts.size() >= n, "the agent got " + agent.prompts.size() + " turn(s), expected " + n);
        Matcher m = TICKET.matcher(agent.prompts.get(n - 1));
        assertTrue(m.find(), agent.prompts.get(n - 1));
        return m.group();
    }

    @Test
    void aSecondBuildDoesNotKillTheRunningOne() throws Exception {
        Thread first = turns.build(alice, "Alice", "une tour", null);
        assertNotNull(first);
        String running = ticketOfTurn(1);
        assertNotNull(tickets.resolve(running, AgentTickets.Kind.BUILDER));

        assertNull(turns.build(alice, "Alice", "un mur", null), "the second /build is refused");
        assertNotNull(tickets.resolve(running, AgentTickets.Kind.BUILDER),
            "the running build's ticket survives a refused second /build");
        assertEquals(1, tickets.size(), "and the refused one left no ticket behind");

        agent.release.countDown();
        first.join(10_000);
        assertNull(tickets.resolve(running, AgentTickets.Kind.BUILDER), "the turn's end revokes its ticket");
    }

    @Test
    void aSecondPrayerDoesNotKillTheRunningOne() throws Exception {
        Thread first = turns.pray(alice, "Alice", "aide-moi", null);
        assertNotNull(first);
        String running = ticketOfTurn(1);
        assertNull(turns.pray(alice, "Alice", "encore", null));
        assertTrue(world.calls.contains("tell " + AgentTurns.STILL_THINKING), world.calls.toString());
        assertNotNull(tickets.resolve(running, AgentTickets.Kind.GOD));
        agent.release.countDown();
        first.join(10_000);
        assertTrue(world.calls.contains("tell Dieu : Fini."), "the unspoken final text is said: " + world.calls);
        assertTrue(!GodSessionManager.isBusy(), "the encounter ends with the turn");
    }

    @Test
    void simultaneousPrayersOfOnePlayerStartExactlyOneTurn() throws Exception {
        int n = 16;
        CountDownLatch go = new CountDownLatch(1);
        List<Thread> started = Collections.synchronizedList(new ArrayList<>());
        List<Thread> callers = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            callers.add(Thread.ofVirtual().start(() -> {
                try {
                    go.await();
                } catch (InterruptedException e) {
                    return;
                }
                Thread t = turns.pray(alice, "Alice", "vite", null);
                if (t != null) started.add(t);
            }));
        }
        go.countDown();
        for (Thread c : callers) c.join(10_000);
        assertEquals(1, started.size(), "one prayer turn");
        String running = ticketOfTurn(1);
        Thread.sleep(200);
        assertEquals(1, agent.prompts.size(), "one prompt reached the agent");
        assertNotNull(tickets.resolve(running, AgentTickets.Kind.GOD), "and its ticket is live");
        assertEquals(1, tickets.size());
        agent.release.countDown();
        started.get(0).join(10_000);
    }
}
