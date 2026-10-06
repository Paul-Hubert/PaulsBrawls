package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;

/**
 * MCP test bench — scenario files. Every {@code src/test/resources/mcp-bench/*.json} is one scenario run against a
 * fresh {@link McpBench}: a list of steps that act like the game (a player prays, builds, goes offline, the watchdog
 * fires, an admin runs {@code /godbody off}, time passes) or like the agent (an MCP tool call), each with its
 * expectations. Adding a case is adding a file. The step language is documented in
 * {@code docs/system/aigod/mcp-test-bench.md}; unknown keys fail the scenario, so a typo cannot pass silently.
 */
class McpScenarioTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern VAR = Pattern.compile("\\$\\{([A-Za-z0-9_]+)}");

    @TestFactory
    Stream<DynamicTest> scenarios() throws Exception {
        URL dir = getClass().getClassLoader().getResource("mcp-bench");
        assertTrue(dir != null, "src/test/resources/mcp-bench is missing");
        List<Path> files;
        try (Stream<Path> s = Files.list(Path.of(dir.toURI()))) {
            files = s.filter(p -> p.toString().endsWith(".json")).sorted().toList();
        }
        assertFalse(files.isEmpty(), "no scenario files");
        return files.stream().map(f -> DynamicTest.dynamicTest(f.getFileName().toString(), f.toUri(), () -> run(f)));
    }

    private void run(Path file) throws Exception {
        JsonNode sc = JSON.readTree(file.toFile());
        keys(sc, "scenario", Set.of("name", "description", "steps"));
        try (McpBench bench = new McpBench()) {
            Map<String, String> vars = new HashMap<>();
            int i = 0;
            for (JsonNode step : sc.path("steps")) {
                i++;
                String where = file.getFileName() + " step " + i + " " + step;
                try {
                    step(bench, step, vars, where);
                } catch (AssertionError e) {
                    throw new AssertionError(where + "\n  " + e.getMessage(), e);
                }
            }
            bench.assertWorldInvariants();
        }
    }

    private void step(McpBench b, JsonNode s, Map<String, String> vars, String where) throws Exception {
        if (s.has("comment") && s.size() == 1) return;
        if (s.has("pray")) {
            keys(s, where, Set.of("pray", "as", "busy", "comment"));
            String who = s.path("pray").asText();
            if (s.path("busy").asBoolean(false)) {
                assertFalse(GodSessionManager.claim(b.player(who)), who + " should find the avatar busy");
                return;
            }
            vars.put(s.path("as").asText("ticket"), b.godTicket(who));
        } else if (s.has("build")) {
            keys(s, where, Set.of("build", "as", "pivot", "comment"));
            String who = s.path("build").asText();
            if (s.has("pivot")) b.buildWorld.origins.put(b.player(who), ints(s.path("pivot")));
            vars.put(s.path("as").asText("ticket"), b.builderTicket(who));
        } else if (s.has("mint")) {
            keys(s, where, Set.of("mint", "player", "as", "comment"));
            boolean god = s.path("mint").asText().equals("god");
            vars.put(s.path("as").asText(), b.tickets.mint(god ? AgentTickets.Kind.GOD : AgentTickets.Kind.BUILDER,
                b.player(s.path("player").asText()), GodSessionManager.generation(), 600_000).id());
        } else if (s.has("call")) {
            keys(s, where, Set.of("call", "args", "expect", "comment"));
            call(b, s, vars);
        } else if (s.has("advance")) {
            keys(s, where, Set.of("advance", "comment"));
            b.clock.addAndGet(duration(s.path("advance").asText()));
        } else if (s.has("offline")) {
            keys(s, where, Set.of("offline", "comment"));
            b.online(s.path("offline").asText(), false);
        } else if (s.has("online")) {
            keys(s, where, Set.of("online", "comment"));
            b.online(s.path("online").asText(), true);
        } else if (s.has("unpivot")) {
            keys(s, where, Set.of("unpivot", "comment"));
            b.buildWorld.origins.remove(b.player(s.path("unpivot").asText()));
        } else if (s.has("watchdog")) {
            keys(s, where, Set.of("watchdog", "comment"));
            GodSessionManager.forceEndSession();
        } else if (s.has("godbody")) {
            keys(s, where, Set.of("godbody", "comment"));
            boolean on = s.path("godbody").asText().equals("on");
            b.bridge.set(on);
            if (!on) { // what /godbody off does besides the bridge: end the session, cancel every sub-build
                GodSessionManager.forceEndSession();
                BuildGuard.cancelAll();
            }
        } else if (s.has("revoke")) {
            keys(s, where, Set.of("revoke", "comment"));
            b.tickets.revoke(subst(s.path("revoke").asText(), vars));
        } else if (s.has("state")) {
            keys(s, where, Set.of("state", "comment"));
            state(b, s.path("state"), where);
        } else if (s.has("repeat")) {
            keys(s, where, Set.of("repeat", "steps", "comment"));
            for (int k = 0; k < s.path("repeat").asInt(); k++) {
                vars.put("i", Integer.toString(k));
                for (JsonNode inner : s.path("steps")) step(b, inner, vars, where + " [i=" + k + "]");
            }
        } else {
            fail("unknown step kind: " + s);
        }
    }

    private void call(McpBench b, JsonNode s, Map<String, String> vars) throws Exception {
        String target = s.path("call").asText();
        int slash = target.indexOf('/');
        assertTrue(slash > 0, "call must be server/tool: " + target);
        String server = target.substring(0, slash), tool = target.substring(slash + 1);
        JsonNode args = substTree(s.path("args").isMissingNode() ? JSON.createObjectNode() : s.path("args"), vars);
        @SuppressWarnings("unchecked")
        Map<String, Object> argMap = JSON.convertValue(args, LinkedHashMap.class);
        List<String> before = b.snapshot();
        JsonNode env = b.rawCall(McpBench.path(server), tool, argMap);
        List<String> effects = b.effectsSince(before);
        boolean error = env.has("error") || env.path("result").path("isError").asBoolean(false);
        String text = env.has("error") ? env.path("error").path("message").asText()
            : env.path("result").path("content").path(0).path("text").asText();
        JsonNode ex = s.path("expect");
        if (ex.isMissingNode()) {
            assertFalse(error, "unexpected refusal: " + text);
            return;
        }
        keys(ex, "expect", Set.of("error", "text", "contains", "absent", "capture", "effects", "effectsContain", "noEffects"));
        assertEquals(ex.path("error").asBoolean(false), error, "error flag; text was: " + text);
        if (ex.has("text")) assertEquals(subst(ex.path("text").asText(), vars), text);
        for (JsonNode c : list(ex.path("contains"))) assertTrue(text.contains(subst(c.asText(), vars)), "'" + c.asText() + "' not in: " + text);
        for (JsonNode c : list(ex.path("absent"))) assertFalse(text.contains(subst(c.asText(), vars)), "'" + c.asText() + "' in: " + text);
        if (ex.has("effects")) {
            List<String> want = new ArrayList<>();
            for (JsonNode e : ex.path("effects")) want.add(subst(e.asText(), vars));
            assertEquals(want, effects, "world effects of this call");
        }
        for (JsonNode e : list(ex.path("effectsContain"))) {
            assertTrue(effects.contains(subst(e.asText(), vars)), "missing effect '" + e.asText() + "' in " + effects);
        }
        if (ex.path("noEffects").asBoolean(false)) assertEquals(List.of(), McpBench.mutating(effects), "this call changed the world");
        for (Iterator<Map.Entry<String, JsonNode>> it = ex.path("capture").fields(); it.hasNext();) {
            Map.Entry<String, JsonNode> c = it.next();
            vars.put(c.getKey(), McpBench.capture(text, c.getValue().asText()));
        }
    }

    private void state(McpBench b, JsonNode st, String where) {
        keys(st, where, Set.of("busy", "owner", "manifested", "slots", "leases", "liveTickets"));
        if (st.has("busy")) assertEquals(st.path("busy").asBoolean(), GodSessionManager.isBusy(), "avatar busy");
        if (st.has("owner")) assertEquals(b.player(st.path("owner").asText()), GodSessionManager.currentOwner(), "avatar owner");
        if (st.has("manifested")) assertEquals(st.path("manifested").asBoolean(), GodSessionManager.hasManifested(), "manifested");
        if (st.has("slots")) assertEquals(st.path("slots").asInt(), BuildGuard.active(), "BuildGuard slots in use");
        if (st.has("leases")) assertEquals(st.path("leases").asInt(), b.subBuilds.live(), "sub-build leases held (swept lazily)");
        if (st.has("liveTickets")) assertEquals(st.path("liveTickets").asInt(), b.tickets.size(), "minted, unrevoked tickets");
    }

    // -- helpers ---------------------------------------------------------------------------------------------------

    private static void keys(JsonNode n, String where, Set<String> allowed) {
        for (Iterator<String> it = n.fieldNames(); it.hasNext();) {
            String k = it.next();
            if (!allowed.contains(k)) fail("unknown key '" + k + "' in " + where + " (allowed: " + allowed + ")");
        }
    }

    private static List<JsonNode> list(JsonNode n) {
        List<JsonNode> out = new ArrayList<>();
        if (n.isMissingNode() || n.isNull()) return out;
        if (n.isArray()) n.forEach(out::add);
        else out.add(n);
        return out;
    }

    private static int[] ints(JsonNode a) {
        int[] o = new int[a.size()];
        for (int i = 0; i < o.length; i++) o[i] = a.get(i).asInt();
        return o;
    }

    /** "120s", "5m", "600001ms". */
    private static long duration(String d) {
        Matcher m = Pattern.compile("(\\d+)(ms|s|m)").matcher(d.trim());
        if (!m.matches()) fail("bad duration '" + d + "' (use 500ms, 120s, 5m)");
        long v = Long.parseLong(m.group(1));
        return switch (m.group(2)) {
            case "ms" -> v;
            case "s" -> v * 1000;
            default -> v * 60_000;
        };
    }

    private static String subst(String s, Map<String, String> vars) {
        Matcher m = VAR.matcher(s);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String v = vars.get(m.group(1));
            if (v == null) fail("undefined variable ${" + m.group(1) + "} (defined: " + vars.keySet() + ")");
            m.appendReplacement(sb, Matcher.quoteReplacement(v));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /** Substitute variables in every string; a string that is exactly "${n}" holding an integer becomes a number. */
    private static JsonNode substTree(JsonNode n, Map<String, String> vars) {
        if (n.isTextual()) {
            String v = subst(n.asText(), vars);
            if (VAR.matcher(n.asText()).matches() && v.matches("-?\\d{1,9}")) return JSON.getNodeFactory().numberNode(Integer.parseInt(v));
            return TextNode.valueOf(v);
        }
        if (n.isArray()) {
            var a = JSON.createArrayNode();
            n.forEach(e -> a.add(substTree(e, vars)));
            return a;
        }
        if (n.isObject()) {
            ObjectNode o = JSON.createObjectNode();
            n.fields().forEachRemaining(e -> o.set(e.getKey(), substTree(e.getValue(), vars)));
            return o;
        }
        return n;
    }
}
