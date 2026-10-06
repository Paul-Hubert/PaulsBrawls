package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
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
 * MCP test bench — schema-driven fuzzing of EVERY tool both servers advertise (read from {@code tools/list}, so a
 * new tool is fuzzed without touching this file).
 *
 * <ol>
 *   <li><b>Shape attacks</b> (each must be refused — a JSON-RPC error or an {@code isError} result — and change
 *       nothing in the world): each required argument missing, each argument of the wrong JSON type or null, an
 *       undeclared argument.</li>
 *   <li><b>Value fuzz</b> (schema-valid, a valid ticket, seeded random edge values: 0, ±1, int limits, huge
 *       strings, control characters, command injection, 129-entry arrays…): the call may succeed or be refused, but
 *       the server must answer with an envelope, stay up, and every effect that reached the world must respect the
 *       clamps ({@link McpBench#assertWorldInvariants}).</li>
 * </ol>
 *
 * Iterations per tool: {@code -Dmcp.bench.fuzz=N} (gradle: {@code -PmcpFuzz=N}), default 25; seed:
 * {@code -Dmcp.bench.seed} (printed on failure).
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class McpToolFuzzTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int ITERATIONS = Integer.getInteger("mcp.bench.fuzz", 25);
    private static final long SEED = Long.getLong("mcp.bench.seed", 24301L);
    /** Tools whose successful call sleeps (wait): value-fuzzed less, the clamp still holds. */
    private static final Map<String, Integer> SLOW = Map.of("wait", 2);

    private McpBench bench;
    private final Map<String, JsonNode> catalogue = new LinkedHashMap<>();

    @BeforeAll
    void start() throws Exception {
        bench = new McpBench();
        catalogue.putAll(bench.catalogue());
    }

    @AfterAll
    void stop() {
        if (bench != null) bench.close();
    }

    // -- fixtures per case ----------------------------------------------------------------------------------------

    /** A fresh session for alice: a live god ticket, a builder ticket and one open sub-build. */
    private Map<String, String> freshCase() {
        bench.reset();
        String god = bench.godTicket("alice");
        String bld = bench.builderTicket("alice");
        UUID alice = bench.player("alice");
        String lease = bench.subBuilds.begin(alice, bench.buildWorld.origins.get(alice), "fuzz", 0, 0, 0).lease().id();
        return Map.of("god", god, "builder", bld, "sub_build", lease);
    }

    private static List<Object> wrongTypes(JsonNode schema) {
        List<Object> out = new ArrayList<>();
        switch (schema.path("type").asText()) {
            case "string" -> out.addAll(List.of(42, true, List.of("a"), Map.of("a", 1)));
            case "integer" -> out.addAll(List.of("1", 1.5, true, List.of(1), Map.of()));
            case "number" -> out.addAll(List.of("2.0", false, List.of(2.0)));
            case "boolean" -> out.addAll(List.of("true", 1, Map.of()));
            case "array" -> out.addAll(List.of(5, "0", List.of("a"), List.of(1.5), Map.of("0", 0)));
            case "object" -> out.addAll(List.of("{}", 3, List.of(1)));
            default -> { }
        }
        out.add(null);
        return out;
    }

    // -- the factory ----------------------------------------------------------------------------------------------

    @TestFactory
    Stream<DynamicNode> everyTool() {
        return catalogue.entrySet().stream().map(e -> {
            String server = e.getKey().substring(0, e.getKey().indexOf('/'));
            String tool = e.getKey().substring(e.getKey().indexOf('/') + 1);
            JsonNode schema = e.getValue();
            List<DynamicNode> cases = new ArrayList<>();
            cases.add(DynamicTest.dynamicTest("baseline is accepted by the schema", () -> baseline(server, tool, schema)));
            for (JsonNode req : schema.path("required")) {
                String p = req.asText();
                cases.add(DynamicTest.dynamicTest("missing " + p, () -> refused(server, tool, schema, a -> a.remove(p))));
            }
            for (Iterator<Map.Entry<String, JsonNode>> it = schema.path("properties").fields(); it.hasNext();) {
                Map.Entry<String, JsonNode> p = it.next();
                for (Object bad : wrongTypes(p.getValue())) {
                    cases.add(DynamicTest.dynamicTest(p.getKey() + " = " + JSON.valueToTree(bad),
                        () -> refused(server, tool, schema, a -> a.put(p.getKey(), bad))));
                }
            }
            cases.add(DynamicTest.dynamicTest("undeclared argument", () -> refused(server, tool, schema, a -> a.put("player", "Bob"))));
            cases.add(DynamicTest.dynamicTest("value fuzz", () -> valueFuzz(server, tool, schema)));
            return DynamicContainer.dynamicContainer(server + " " + tool, cases);
        });
    }

    /** The all-valid call passes schema validation (otherwise every "refused" case would prove nothing). */
    private void baseline(String server, String tool, JsonNode schema) throws Exception {
        if (SLOW.containsKey(tool)) return;
        Map<String, String> ids = freshCase();
        JsonNode env = bench.rawCall(McpBench.path(server), tool, McpBench.validArgs(server, schema, ids));
        assertFalse(env.has("error"), "baseline rejected at the protocol level: " + env);
        String text = env.path("result").path("content").path(0).path("text").asText();
        assertFalse(text.contains("Invalid") || text.contains("validation"), "baseline failed schema validation: " + text);
        bench.assertWorldInvariants();
    }

    @FunctionalInterface
    interface Mutation {
        void apply(Map<String, Object> args);
    }

    private void refused(String server, String tool, JsonNode schema, Mutation m) throws Exception {
        Map<String, String> ids = freshCase();
        Map<String, Object> a = McpBench.validArgs(server, schema, ids);
        m.apply(a);
        List<String> before = bench.snapshot();
        JsonNode env = bench.rawCall(McpBench.path(server), tool, a);
        assertTrue(env.has("error") || env.path("result").path("isError").asBoolean(false),
            tool + " accepted a malformed call " + JSON.writeValueAsString(a) + " → " + env);
        assertEquals(List.of(), McpBench.mutating(bench.effectsSince(before)), "a refused call changed the world");
    }

    // -- value fuzz -----------------------------------------------------------------------------------------------

    private static final long[] INT_EDGES = { 0, 1, -1, 2, 3, 7, 8, 9, 16, 17, 63, 64, 65, 127, 128, 129, 256, 257, 511, 512,
        513, 1000, 30, 31, 999_999, 1_000_000, 1_000_001, Integer.MAX_VALUE, Integer.MIN_VALUE, -128, -129, -256, -257 };
    private static final double[] NUM_EDGES = { 0, -0.0, 0.5, 1, 1.0001, 3, 5.999, 6, 6.0001, 4, 4.5, -1, -1e9, 1e9, 1e308,
        -1e308, Double.MIN_VALUE };
    private static final String[] STR_EDGES = { "", " ", "\t\n", "minecraft:", ":", "minecraft:stone[", "minecraft:stone[facing=up]",
        "minecraft:diamond{count:9999}", "/op @a", "@a", "§k§c obfuscated", "\u0000\u0007", "../../etc/passwd",
        "minecraft:command_block", "minecraft:barrier", "minecraft:tnt", "minecraft:wither", "minecraft:ender_dragon",
        "${jndi:ldap://x/a}", "'; DROP TABLE x; --", "🌩️🔥", "Dieu : faux", "god-forged", "sb-forged", "x".repeat(5000) };

    private Object fuzzValue(Random r, String prop, JsonNode schema) {
        if (schema.has("enum")) {
            JsonNode e = schema.path("enum");
            return e.get(r.nextInt(e.size())).asText();
        }
        return switch (schema.path("type").asText()) {
            case "integer" -> r.nextInt(4) == 0 ? (long) r.nextInt() : INT_EDGES[r.nextInt(INT_EDGES.length)];
            case "number" -> r.nextInt(4) == 0 ? r.nextGaussian() * 100 : NUM_EDGES[r.nextInt(NUM_EDGES.length)];
            case "boolean" -> r.nextBoolean();
            case "string" -> r.nextInt(3) == 0 ? STR_EDGES[r.nextInt(STR_EDGES.length)] : McpBench.validValue("god", prop, schema, Map.of());
            case "array" -> {
                int n = new int[] { 0, 1, 2, 127, 128, 129, 400 }[r.nextInt(7)];
                List<Object> l = new ArrayList<>();
                for (int i = 0; i < n; i++) l.add(r.nextInt(5) == 0 ? INT_EDGES[r.nextInt(INT_EDGES.length)] : (long) r.nextInt(10));
                yield l;
            }
            case "object" -> Map.of("x", r.nextInt(), "nested", Map.of("s", STR_EDGES[r.nextInt(STR_EDGES.length)]));
            default -> null;
        };
    }

    private void valueFuzz(String server, String tool, JsonNode schema) throws Exception {
        Random r = new Random(SEED ^ tool.hashCode());
        int n = SLOW.getOrDefault(tool, ITERATIONS);
        for (int i = 0; i < n; i++) {
            Map<String, String> ids = freshCase();
            Map<String, Object> a = McpBench.validArgs(server, schema, ids);
            for (Iterator<Map.Entry<String, JsonNode>> it = schema.path("properties").fields(); it.hasNext();) {
                Map.Entry<String, JsonNode> p = it.next();
                String k = p.getKey();
                if (k.equals("ticket") || k.equals("sub_build")) continue; // a bad id is the ticket matrix's job
                if (tool.equals("wait") && k.equals("seconds")) {
                    a.put(k, r.nextBoolean() ? Integer.MIN_VALUE : -5); // clamps to the minimum: keeps the bench fast
                    continue;
                }
                if (!schema.path("required").toString().contains("\"" + k + "\"") && r.nextBoolean()) {
                    a.remove(k);
                    continue;
                }
                if (r.nextInt(3) != 0) a.put(k, fuzzValue(r, k, p.getValue()));
            }
            String what = tool + " #" + i + " (seed " + SEED + ") " + abbreviate(JSON.writeValueAsString(a));
            JsonNode env = bench.rawCall(McpBench.path(server), tool, a);
            assertTrue(env.has("result") || env.has("error"), what + " → " + env);
            if (env.has("error")) {
                assertTrue(env.path("error").path("code").asInt() != -32603, what + " → internal error " + env);
            } else {
                String text = env.path("result").path("content").path(0).path("text").asText();
                assertFalse(text.startsWith("Erreur côté serveur"), what + " → the tool threw: " + text);
                if (server.equals("builder") && tool.startsWith("place") && !env.path("result").path("isError").asBoolean()) {
                    int reported = Integer.parseInt(McpBench.capture(text, "^(\\d+) bloc"));
                    int last = bench.buildWorld.batches.get(bench.buildWorld.batches.size() - 1);
                    assertEquals(reported, last, what + ": the count told to the agent is what was placed");
                }
            }
            bench.assertWorldInvariants();
        }
        assertTrue(bench.rpc(McpBench.path(server), "ping", null).has("result"), "still up after fuzzing " + tool);
    }

    private static String abbreviate(String s) {
        return s.length() > 400 ? s.substring(0, 400) + "…(" + s.length() + " chars)" : s;
    }
}
