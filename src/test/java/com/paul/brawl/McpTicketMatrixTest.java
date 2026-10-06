package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Stream;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicContainer;
import org.junit.jupiter.api.DynamicNode;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.junit.jupiter.api.TestInstance;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * MCP test bench — the authority matrix: EVERY advertised tool × every way the caller's authority can be wrong
 * (docs/27 §5). The agent is never trusted, so each cell must be refused AND leave the world, the avatar session and
 * the sub-build slots untouched. Tools are read from {@code tools/list}: a new tool joins the matrix automatically.
 *
 * <p>A condition sets up the bench (alice prays or builds, then something goes wrong) and returns the arguments to
 * send. {@code end_session} is special: ending an already-ended session is harmless and may answer "déjà close",
 * so for it the check is only that nothing changed.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class McpTicketMatrixTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> BODY_TOOLS = Set.of("appear", "vanish", "body_tools", "body_call");
    private static final Set<String> LEASE_TOOLS = Set.of("place_block", "place_line", "place_blocks", "end_sub_build");
    private static final Set<String> ORIGIN_TOOLS = Set.of("get_build_origin", "get_block_info", "begin_sub_build");

    private McpBench bench;
    private Map<String, JsonNode> catalogue;

    @BeforeAll
    void start() throws Exception {
        bench = new McpBench();
        catalogue = bench.catalogue();
    }

    @AfterAll
    void stop() {
        if (bench != null) bench.close();
    }

    /** One way to be wrong: which tools it applies to, and the setup that returns the call's arguments. */
    private record Condition(String name, String server, Function<String, Boolean> appliesTo,
            SetUp setUp) {}

    @FunctionalInterface
    private interface SetUp {
        /** Prepare the bench for {@code tool} and return the ids to send (god / builder / sub_build). */
        Map<String, String> ids(McpBench b, String tool);
    }

    private static Map<String, String> ids(String god, String builder, String sub) {
        return Map.of("god", god, "builder", builder, "sub_build", sub);
    }

    /** alice prays and builds normally: live tickets and an open lease. */
    private static Map<String, String> live(McpBench b) {
        String god = b.godTicket("alice");
        String bld = b.builderTicket("alice");
        UUID alice = b.player("alice");
        String sub = b.subBuilds.begin(alice, b.buildWorld.origins.get(alice), "m", 0, 0, 0).lease().id();
        return ids(god, bld, sub);
    }

    private static Map<String, String> with(Map<String, String> base, String key, String value) {
        Map<String, String> m = new java.util.HashMap<>(base);
        m.put(key, value);
        return m;
    }

    private List<Condition> conditions() {
        List<Condition> c = new ArrayList<>();
        for (String server : List.of("god", "builder")) {
            Function<String, Boolean> all = t -> true;
            c.add(new Condition("forged ticket", server, all, (b, t) -> with(live(b), server, server.equals("god")
                ? "god-AAAAAAAAAAAAAAAAAAAAAA" : "bld-AAAAAAAAAAAAAAAAAAAAAA")));
            c.add(new Condition("empty ticket", server, all, (b, t) -> with(live(b), server, "")));
            c.add(new Condition("the other server's ticket", server, all, (b, t) -> {
                Map<String, String> l = live(b);
                return with(l, server, l.get(server.equals("god") ? "builder" : "god"));
            }));
            c.add(new Condition("expired ticket", server, all, (b, t) -> {
                Map<String, String> l = live(b);
                b.clock.addAndGet(600_001);
                return l;
            }));
            c.add(new Condition("revoked ticket (turn over)", server, all, (b, t) -> {
                Map<String, String> l = live(b);
                b.tickets.revoke(l.get(server));
                return l;
            }));
            c.add(new Condition("superseded by a newer ticket", server, all, (b, t) -> {
                Map<String, String> l = live(b);
                if (server.equals("god")) b.tickets.mint(AgentTickets.Kind.GOD, b.player("alice"), GodSessionManager.generation(), 600_000);
                else b.builderTicket("alice");
                return l;
            }));
            // end_session is not refused for an offline player: closing their own encounter is harmless.
            c.add(new Condition("player offline", server, t -> !t.equals("end_session"), (b, t) -> {
                Map<String, String> l = live(b);
                b.online("alice", false);
                return l;
            }));
        }
        Function<String, Boolean> god = t -> true;
        c.add(new Condition("session ended by the watchdog", "god", god, (b, t) -> {
            Map<String, String> l = live(b);
            GodSessionManager.forceEndSession();
            return l;
        }));
        c.add(new Condition("stale ticket: alice prays again (new generation)", "god", god, (b, t) -> {
            Map<String, String> l = live(b);
            GodSessionManager.forceEndSession();
            GodSessionManager.claim(b.player("alice"));
            return l;
        }));
        c.add(new Condition("bob's ticket while alice holds the avatar", "god", god, (b, t) -> {
            Map<String, String> l = live(b);
            String bobs = b.tickets.mint(AgentTickets.Kind.GOD, b.player("bob"), GodSessionManager.generation(), 600_000).id();
            return with(l, "god", bobs);
        }));
        c.add(new Condition("body disabled (/godbody off)", "god", BODY_TOOLS::contains, (b, t) -> {
            Map<String, String> l = live(b);
            b.bridge.set(false);
            return l;
        }));
        c.add(new Condition("bob's sub-build with alice's ticket", "builder", LEASE_TOOLS::contains, (b, t) -> {
            Map<String, String> l = live(b);
            UUID bob = b.player("bob");
            b.buildWorld.origins.put(bob, new int[] { 0, 0, 0 });
            return with(l, "sub_build", b.subBuilds.begin(bob, new int[] { 0, 0, 0 }, "bob", 0, 0, 0).lease().id());
        }));
        c.add(new Condition("sub-build already closed", "builder", LEASE_TOOLS::contains, (b, t) -> {
            Map<String, String> l = live(b);
            b.subBuilds.end(l.get("sub_build"), b.player("alice"));
            return l;
        }));
        c.add(new Condition("sub-build cancelled (/godbody off)", "builder", LEASE_TOOLS::contains, (b, t) -> {
            Map<String, String> l = live(b);
            BuildGuard.cancelAll();
            return l;
        }));
        c.add(new Condition("sub-build idle past its lease", "builder", LEASE_TOOLS::contains, (b, t) -> {
            Map<String, String> l = live(b);
            b.clock.addAndGet(120_000);
            return l;
        }));
        c.add(new Condition("forged sub-build id", "builder", LEASE_TOOLS::contains,
            (b, t) -> with(live(b), "sub_build", "sb-AAAAAAAAAAAA")));
        c.add(new Condition("no /construction pivot", "builder", ORIGIN_TOOLS::contains, (b, t) -> {
            Map<String, String> l = live(b);
            b.buildWorld.origins.remove(b.player("alice"));
            return l;
        }));
        return c;
    }

    @TestFactory
    Stream<DynamicNode> everyToolUnderEveryWrongAuthority() {
        return conditions().stream().map(cond -> DynamicContainer.dynamicContainer(cond.server() + ": " + cond.name(),
            catalogue.entrySet().stream()
                .filter(e -> e.getKey().startsWith(cond.server() + "/"))
                .map(e -> e.getKey().substring(cond.server().length() + 1))
                .filter(cond.appliesTo()::apply)
                .map(tool -> DynamicTest.dynamicTest(tool, () -> cell(cond, tool)))));
    }

    private void cell(Condition cond, String tool) throws Exception {
        bench.reset();
        bench.buildWorld.origins.clear();
        Map<String, String> ids = cond.setUp().ids(bench, tool);
        Map<String, Object> args = McpBench.validArgs(cond.server(), catalogue.get(cond.server() + "/" + tool), ids);
        UUID ownerBefore = GodSessionManager.currentOwner();
        long generationBefore = GodSessionManager.generation();
        int slotsBefore = BuildGuard.active();
        List<String> before = bench.snapshot();

        JsonNode env = bench.rawCall(McpBench.path(cond.server()), tool, args);

        String what = cond.name() + " / " + tool + " " + JSON.writeValueAsString(args) + " → " + env;
        boolean refused = env.has("error") || env.path("result").path("isError").asBoolean(false);
        if (!tool.equals("end_session")) assertTrue(refused, "accepted: " + what);
        assertEquals(List.of(), bench.effectsSince(before), "the world changed: " + what);
        assertEquals(ownerBefore, GodSessionManager.currentOwner(), "the avatar session changed hands: " + what);
        assertEquals(generationBefore, GodSessionManager.generation(), "the avatar session was ended: " + what);
        // A refused call may sweep a dead lease (idle or cancelled) and free its slot; it never takes one.
        assertTrue(BuildGuard.active() <= slotsBefore, "a sub-build slot was taken: " + what);
    }
}
