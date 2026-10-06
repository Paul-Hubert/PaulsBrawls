package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;

import io.modelcontextprotocol.client.McpSyncClient;

/**
 * MCP test bench — concurrency. An external agent runs sub-agents in parallel and several players can pray and build
 * at once, so the server-wide limits must hold under real contention: every call here goes over HTTP to the real
 * servers from many threads released together.
 */
class McpConcurrencyTest {

    private McpBench bench;
    private ExecutorService pool;

    @BeforeEach
    void setUp() throws Exception {
        bench = new McpBench();
        pool = Executors.newFixedThreadPool(48);
    }

    @AfterEach
    void tearDown() throws Exception {
        pool.shutdownNow();
        pool.awaitTermination(10, TimeUnit.SECONDS);
        bench.close();
    }

    /** Run {@code n} tasks released at the same instant; returns their results in order. */
    private <T> List<T> together(int n, java.util.function.IntFunction<Callable<T>> task) throws Exception {
        CountDownLatch go = new CountDownLatch(1);
        List<Future<T>> fs = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            Callable<T> c = task.apply(i);
            fs.add(pool.submit(() -> {
                go.await();
                return c.call();
            }));
        }
        go.countDown();
        List<T> out = new ArrayList<>();
        for (Future<T> f : fs) out.add(f.get(60, TimeUnit.SECONDS));
        return out;
    }

    private static boolean isError(JsonNode env) {
        return env.has("error") || env.path("result").path("isError").asBoolean(false);
    }

    private static String text(JsonNode env) {
        return env.path("result").path("content").path(0).path("text").asText();
    }

    @Test
    void exactlyFourSubBuildsWinARaceOfThirtyTwo() throws Exception {
        List<String> tickets = new ArrayList<>();
        for (int i = 0; i < 32; i++) tickets.add(bench.builderTicket("p" + i));
        List<JsonNode> results = together(32, i -> () -> bench.rawCall(AgentMcpServers.BUILDER_PATH, "begin_sub_build",
            Map.of("ticket", tickets.get(i), "anchor_x", i, "anchor_y", 0, "anchor_z", 0)));
        List<String> won = new ArrayList<>();
        for (JsonNode r : results) {
            if (!isError(r)) won.add(McpBench.capture(text(r), "sub_build=(\\S+)"));
            else assertTrue(text(r).contains("tournent déjà"), "a loser is told why: " + r);
        }
        assertEquals(BuildGuard.MAX_CONCURRENT_SUB_BUILDS, won.size());
        assertEquals(BuildGuard.MAX_CONCURRENT_SUB_BUILDS, BuildGuard.active());
        assertEquals(BuildGuard.MAX_CONCURRENT_SUB_BUILDS, bench.subBuilds.live());

        // Each winner closes its own lease concurrently; every slot comes back exactly once.
        List<Integer> winners = new ArrayList<>();
        for (int i = 0; i < 32; i++) if (!isError(results.get(i))) winners.add(i);
        List<JsonNode> ends = together(winners.size(), k -> () -> bench.rawCall(AgentMcpServers.BUILDER_PATH, "end_sub_build",
            Map.of("ticket", tickets.get(winners.get(k)), "sub_build", McpBench.capture(text(results.get(winners.get(k))), "sub_build=(\\S+)"))));
        for (JsonNode e : ends) assertFalse(isError(e), e.toString());
        assertEquals(0, BuildGuard.active());
        assertEquals(0, bench.subBuilds.live());
    }

    @Test
    void parallelSubBuildsLoseNoBlock() throws Exception {
        int builders = BuildGuard.MAX_CONCURRENT_SUB_BUILDS, callsEach = 30, line = 5;
        List<String> tickets = new ArrayList<>(), leases = new ArrayList<>();
        for (int i = 0; i < builders; i++) {
            tickets.add(bench.builderTicket("b" + i));
            JsonNode r = bench.rawCall(AgentMcpServers.BUILDER_PATH, "begin_sub_build",
                Map.of("ticket", tickets.get(i), "anchor_x", 0, "anchor_y", 0, "anchor_z", i * 10));
            leases.add(McpBench.capture(text(r), "sub_build=(\\S+)"));
        }
        List<Integer> placed = together(builders * callsEach, k -> () -> {
            int b = k % builders, c = k / builders;
            JsonNode r = bench.rawCall(AgentMcpServers.BUILDER_PATH, "place_line", Map.of("ticket", tickets.get(b),
                "sub_build", leases.get(b), "x1", 0, "y1", c, "z1", 0, "x2", line - 1, "y2", c, "z2", 0, "block", "minecraft:stone"));
            assertFalse(isError(r), r.toString());
            return Integer.parseInt(McpBench.capture(text(r), "^(\\d+) bloc"));
        });
        int total = placed.stream().mapToInt(Integer::intValue).sum();
        assertEquals(builders * callsEach * line, total);
        assertEquals(total, bench.buildWorld.placed.size(), "every reported block reached the world");
        assertEquals(total, new HashSet<>(bench.buildWorld.placed).size(), "and each at its own position");
        assertEquals(builders, BuildGuard.active(), "placing never takes or frees a slot");
        bench.assertWorldInvariants();
    }

    @Test
    void manyAgentsConnectAndListAtOnce() throws Exception {
        List<Integer> counts = together(40, i -> () -> {
            McpSyncClient c = bench.client(i % 2 == 0 ? AgentMcpServers.GOD_PATH : AgentMcpServers.BUILDER_PATH);
            return c.listTools().tools().size();
        });
        for (int i = 0; i < counts.size(); i++) assertEquals(i % 2 == 0 ? 14 : 8, counts.get(i), "client " + i);
    }

    @Test
    void aSessionEndRacingToolCallsLeavesNothingBehind() throws Exception {
        String ticket = bench.godTicket("alice");
        AtomicBoolean ended = new AtomicBoolean();
        AtomicInteger afterEnd = new AtomicInteger();
        List<String> unexpected = Collections.synchronizedList(new ArrayList<>());
        List<Future<?>> spammers = new ArrayList<>();
        for (int t = 0; t < 8; t++) {
            int id = t;
            spammers.add(pool.submit(() -> {
                for (int i = 0; i < 40; i++) {
                    boolean endedBefore = ended.get();
                    JsonNode r = bench.rawCall(AgentMcpServers.GOD_PATH, id % 2 == 0 ? "say" : "reward", id % 2 == 0
                        ? Map.of("ticket", ticket, "message", "t" + id + "#" + i)
                        : Map.of("ticket", ticket, "item", "minecraft:diamond", "amount", 1));
                    if (!isError(r) && endedBefore) afterEnd.incrementAndGet();
                    if (isError(r) && !text(r).contains("terminée") && !text(r).contains("Ticket inconnu")) unexpected.add(r.toString());
                }
                return null;
            }));
        }
        Thread.sleep(40);
        GodSessionManager.forceEndSession(); // the idle watchdog, /pray stop or /godbody off
        ended.set(true);
        for (Future<?> f : spammers) f.get(60, TimeUnit.SECONDS);

        assertEquals(List.of(), unexpected, "only session refusals");
        assertEquals(0, afterEnd.get(), "no call that started after the end was accepted");
        assertFalse(GodSessionManager.isBusy());
        List<String> before = bench.snapshot();
        assertTrue(isError(bench.rawCall(AgentMcpServers.GOD_PATH, "say", Map.of("ticket", ticket, "message", "x"))));
        assertEquals(List.of(), bench.effectsSince(before));
        bench.assertWorldInvariants();
    }

    @Test
    void aPrayerAndBuildsRunSideBySide() throws Exception {
        String god = bench.godTicket("alice");
        List<String> bld = new ArrayList<>();
        for (int i = 0; i < 3; i++) bld.add(bench.builderTicket("builder" + i));
        List<Boolean> ok = together(4, i -> () -> {
            if (i == 3) {
                for (int k = 0; k < 10; k++) {
                    if (isError(bench.rawCall(AgentMcpServers.GOD_PATH, "say", Map.of("ticket", god, "message", "verset " + k)))) return false;
                }
                return true;
            }
            JsonNode r = bench.rawCall(AgentMcpServers.BUILDER_PATH, "begin_sub_build",
                Map.of("ticket", bld.get(i), "anchor_x", i * 20, "anchor_y", 0, "anchor_z", 0));
            String sb = McpBench.capture(text(r), "sub_build=(\\S+)");
            for (int k = 0; k < 10; k++) {
                if (isError(bench.rawCall(AgentMcpServers.BUILDER_PATH, "place_block", Map.of("ticket", bld.get(i), "sub_build", sb,
                    "x", k, "y", 0, "z", 0, "block", "minecraft:oak_planks")))) return false;
            }
            return !isError(bench.rawCall(AgentMcpServers.BUILDER_PATH, "end_sub_build", Map.of("ticket", bld.get(i), "sub_build", sb)));
        });
        assertEquals(List.of(true, true, true, true), ok);
        assertEquals(30, bench.buildWorld.placed.size());
        assertEquals(10, bench.godWorld.calls.stream().filter(c -> c.startsWith("tell Dieu : verset")).count());
        assertEquals(0, BuildGuard.active());
        assertEquals(bench.player("alice"), GodSessionManager.currentOwner(), "building never touches the avatar session");
    }

    @Test
    void ticketsStayOnePerPlayerUnderConcurrentMinting() throws Exception {
        UUID p = bench.player("alice");
        Set<String> minted = Collections.synchronizedSet(new HashSet<>());
        together(32, i -> () -> minted.add(bench.tickets.mint(AgentTickets.Kind.BUILDER, p, 0, 60_000).id()));
        assertEquals(32, minted.size(), "ids are unique");
        long live = minted.stream().filter(id -> bench.tickets.resolve(id, AgentTickets.Kind.BUILDER) != null).count();
        assertEquals(1, live, "exactly one live ticket per player and kind, however the mints interleave");
    }
}
