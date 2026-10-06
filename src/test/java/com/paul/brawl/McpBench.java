package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.spec.McpSchema;

/**
 * The MCP test bench fixture: the REAL {@code god} and {@code builder} servers on a loopback port, with Minecraft
 * replaced by recording ports and time by a manual clock. Every bench suite (protocol, fuzz, ticket matrix,
 * concurrency, scenario files, live probe) starts from one of these.
 *
 * <ul>
 *   <li>Players are named ({@link #player}) and online by default.</li>
 *   <li>{@link #godTicket} claims the avatar and mints a ticket the way {@code /pray} does; {@link #builderTicket}
 *       mints one the way {@code /build} does (the player gets a pivot if they had none).</li>
 *   <li>{@link #snapshot()} / {@link #effectsSince} give the world effects of a step; {@link #assertWorldInvariants}
 *       checks every recorded effect against the server-side clamps.</li>
 *   <li>{@link #rpc} speaks raw JSON-RPC for what the SDK client hides.</li>
 * </ul>
 *
 * Uses the static {@link GodSessionManager} and {@link BuildGuard}, so bench suites must not run in parallel with
 * each other (JUnit's default).
 */
final class McpBench implements AutoCloseable {

    static final String TOKEN = "bench-token";
    private static final ObjectMapper JSON = new ObjectMapper();

    final AtomicLong clock = new AtomicLong(10_000_000);
    final AtomicBoolean bridge = new AtomicBoolean(true);
    final RecordingGodWorld godWorld = new RecordingGodWorld();
    final RecordingBuildWorld buildWorld = new RecordingBuildWorld();
    final RecordingBodyTools body = new RecordingBodyTools();
    final AgentTickets tickets = new AgentTickets(clock::get);
    final SubBuilds subBuilds = new SubBuilds(clock::get, 120_000);
    final AgentMcpServers servers;
    private final Map<String, UUID> players = new LinkedHashMap<>();
    private final List<McpSyncClient> clients = new ArrayList<>();
    private final AtomicInteger rpcIds = new AtomicInteger(1000);
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();

    McpBench() throws Exception {
        GodSessionManager.forceEndSession();
        BuildGuard.resetForTests();
        servers = AgentMcpServers.start(0, () -> TOKEN, new GodService(godWorld, BridgeConfig.INSTANCE), body, bridge::get,
            new BuildService(buildWorld), tickets, subBuilds);
    }

    int port() {
        return servers.port();
    }

    // -- players and tickets ---------------------------------------------------------------------------------------

    /** The player called {@code name}, created online on first use. */
    UUID player(String name) {
        return players.computeIfAbsent(name, n -> {
            UUID id = UUID.nameUUIDFromBytes(("bench:" + n).getBytes());
            godWorld.online.add(id);
            buildWorld.online.add(id);
            return id;
        });
    }

    void online(String name, boolean on) {
        UUID id = player(name);
        if (on) {
            godWorld.online.add(id);
            buildWorld.online.add(id);
        } else {
            godWorld.online.remove(id);
            buildWorld.online.remove(id);
        }
    }

    /** {@code /pray}: claim the avatar for {@code name} (must be free or theirs) and mint a god ticket. */
    String godTicket(String name) {
        UUID id = player(name);
        if (!GodSessionManager.claim(id)) fail("the avatar is held by someone else; " + name + " cannot pray");
        return tickets.mint(AgentTickets.Kind.GOD, id, GodSessionManager.generation(), 600_000).id();
    }

    /** {@code /build}: give {@code name} a pivot if missing and mint a builder ticket. */
    String builderTicket(String name) {
        UUID id = player(name);
        buildWorld.origins.putIfAbsent(id, new int[] { 100, 64, 200 });
        return tickets.mint(AgentTickets.Kind.BUILDER, id, 0, 600_000).id();
    }

    /** Fresh state for one case: no session, no lease, no recorded effect. Tickets are dropped too. */
    void reset() {
        GodSessionManager.forceEndSession();
        subBuilds.endAll(null);
        BuildGuard.resetForTests();
        tickets.revoke(null, AgentTickets.Kind.GOD);
        tickets.revoke(null, AgentTickets.Kind.BUILDER);
        godWorld.calls.clear();
        buildWorld.placed.clear();
        buildWorld.batches.clear();
        body.calls.clear();
        bridge.set(true);
        for (UUID id : players.values()) {
            godWorld.online.add(id);
            buildWorld.online.add(id);
        }
    }

    // -- clients ---------------------------------------------------------------------------------------------------

    McpSyncClient god() {
        return client(AgentMcpServers.GOD_PATH);
    }

    McpSyncClient builder() {
        return client(AgentMcpServers.BUILDER_PATH);
    }

    /** A new, initialized SDK client; closed with the bench. */
    McpSyncClient client(String path) {
        McpSyncClient c = McpTestClients.connect(port(), path, TOKEN);
        synchronized (clients) {
            clients.add(c);
        }
        return c;
    }

    static String path(String server) {
        return switch (server) {
            case "god" -> AgentMcpServers.GOD_PATH;
            case "builder" -> AgentMcpServers.BUILDER_PATH;
            default -> throw new IllegalArgumentException("unknown server '" + server + "' (god or builder)");
        };
    }

    // -- raw JSON-RPC ----------------------------------------------------------------------------------------------

    /** One raw HTTP POST to {@code path}, with the bench token unless {@code headers} sets Authorization. */
    HttpResponse<String> post(String path, Map<String, String> headers, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port() + path))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .POST(HttpRequest.BodyPublishers.ofString(body));
        Map<String, String> h = new HashMap<>(headers);
        h.putIfAbsent("Authorization", "Bearer " + TOKEN);
        h.forEach((k, v) -> {
            if (v != null) b.header(k, v);
        });
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    HttpResponse<String> send(String method, String path, Map<String, String> headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port() + path))
            .method(method, HttpRequest.BodyPublishers.noBody());
        Map<String, String> h = new HashMap<>(headers);
        h.putIfAbsent("Authorization", "Bearer " + TOKEN);
        h.forEach(b::header);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    /** A JSON-RPC request; returns the parsed response envelope (asserting HTTP 200). */
    JsonNode rpc(String path, String method, Object params) throws Exception {
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("jsonrpc", "2.0");
        msg.put("id", rpcIds.incrementAndGet());
        msg.put("method", method);
        if (params != null) msg.put("params", params);
        HttpResponse<String> r = post(path, Map.of(), JSON.writeValueAsString(msg));
        assertTrue(r.statusCode() == 200, method + " → HTTP " + r.statusCode() + ": " + r.body());
        return JSON.readTree(r.body());
    }

    /** {@code tools/call} over raw JSON-RPC; returns the envelope (result or error). */
    JsonNode rawCall(String path, String tool, Map<String, Object> args) throws Exception {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("name", tool);
        params.put("arguments", args);
        return rpc(path, "tools/call", params);
    }

    /** Every advertised tool of both servers: "server/tool" → its input schema, from a raw {@code tools/list}. */
    Map<String, JsonNode> catalogue() throws Exception {
        Map<String, JsonNode> out = new LinkedHashMap<>();
        for (String server : List.of("god", "builder")) {
            for (JsonNode t : rpc(path(server), "tools/list", Map.of()).path("result").path("tools")) {
                out.put(server + "/" + t.path("name").asText(), t.path("inputSchema"));
            }
        }
        return out;
    }

    /** A schema-valid, world-valid value for {@code prop} (ids from {@code ids}: god, builder, sub_build): a known item, block, entity, enum value… */
    static Object validValue(String server, String prop, JsonNode schema, Map<String, String> ids) {
        if (prop.equals("ticket")) return ids.get(server);
        if (prop.equals("sub_build")) return ids.get("sub_build");
        if (schema.has("enum")) return schema.path("enum").get(0).asText();
        return switch (schema.path("type").asText()) {
            case "string" -> switch (prop) {
                case "block" -> "minecraft:stone";
                case "item", "give_item", "take_item" -> "minecraft:diamond";
                case "entity" -> "minecraft:cow";
                case "tool" -> "move-to-position";
                default -> "fuzz";
            };
            case "integer" -> 1;
            case "number" -> 2.0;
            case "boolean" -> true;
            case "array" -> List.of(0);
            case "object" -> Map.of("x", 1);
            default -> throw new IllegalStateException("no generator for " + prop + ": " + schema);
        };
    }

    static Map<String, Object> validArgs(String server, JsonNode schema, Map<String, String> ids) {
        Map<String, Object> a = new LinkedHashMap<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = schema.path("properties").fields(); it.hasNext();) {
            Map.Entry<String, JsonNode> p = it.next();
            a.put(p.getKey(), validValue(server, p.getKey(), p.getValue(), ids));
        }
        return a;
    }

    // -- effects ---------------------------------------------------------------------------------------------------

    /** Everything that reached a world port so far, in one list ("god: …", "body: …", "place: …"). */
    List<String> snapshot() {
        List<String> all = new ArrayList<>();
        synchronized (godWorld.calls) {
            for (String c : godWorld.calls) all.add("god: " + c);
        }
        synchronized (body.calls) {
            for (String c : body.calls) all.add("body: " + c);
        }
        synchronized (buildWorld.placed) {
            for (String c : buildWorld.placed) all.add("place: " + c);
        }
        return all;
    }

    /** The effects recorded after {@code before} (a {@link #snapshot()}), by multiset difference. */
    List<String> effectsSince(List<String> before) {
        List<String> now = snapshot();
        List<String> rest = new ArrayList<>(before);
        List<String> out = new ArrayList<>();
        for (String s : now) {
            if (!rest.remove(s)) out.add(s);
        }
        return out;
    }

    /** Effects that change the world (reads such as player context and terrain maps excluded). */
    static List<String> mutating(List<String> effects) {
        return effects.stream().filter(e -> !e.equals("god: context") && !e.startsWith("god: terrain ")).toList();
    }

    private static final Pattern GIVE = Pattern.compile("give .+ x(-?\\d+)");
    private static final Pattern STRIKE = Pattern.compile("strike x(-?\\d+)");
    private static final Pattern SPAWN = Pattern.compile("spawn \\S+ x(-?\\d+) at (-?\\d+),(-?\\d+),(-?\\d+)( grief)?");
    private static final Pattern WEATHER = Pattern.compile("weather (\\S+) (-?\\d+)");
    private static final Pattern APPEAR = Pattern.compile("appear (\\S+) (\\S+) (true|false)");
    private static final Pattern TRADE = Pattern.compile("trade (-?\\d+) .+ for (-?\\d+) .+");
    private static final Pattern TELL = Pattern.compile("(?s)tell (.*)");

    /**
     * Every recorded world effect respects the clamps the mod promises whatever the agent sends (docs/27 §5): reward
     * amount, strikes, spawn count/offsets/griefing, weather type/duration, appear distance/height, trade amounts,
     * the length of a God line, and the per-call block cap.
     */
    void assertWorldInvariants() {
        BridgeConfig c = BridgeConfig.INSTANCE;
        List<String> calls;
        synchronized (godWorld.calls) {
            calls = List.copyOf(godWorld.calls);
        }
        for (String call : calls) {
            Matcher m;
            if ((m = GIVE.matcher(call)).matches()) {
                range(call, Integer.parseInt(m.group(1)), 1, c.rewardMax);
            } else if ((m = STRIKE.matcher(call)).matches()) {
                range(call, Integer.parseInt(m.group(1)), 0, c.punishmentMax); // 0 = a no-op, by design (GodClamps)
            } else if ((m = SPAWN.matcher(call)).matches()) {
                range(call, Integer.parseInt(m.group(1)), 1, c.spawnCountMax);
                for (int g = 2; g <= 4; g++) range(call, Integer.parseInt(m.group(g)), -c.spawnOffsetMax, c.spawnOffsetMax);
                assertTrue(m.group(5) == null || c.creatureGriefingAllowed, "griefing spawn while disabled: " + call);
            } else if ((m = WEATHER.matcher(call)).matches()) {
                assertTrue(GodService.WEATHER_TYPES.contains(m.group(1)), "weather type: " + call);
                range(call, Integer.parseInt(m.group(2)), 0, GodService.MAX_WEATHER_SECONDS);
            } else if ((m = APPEAR.matcher(call)).matches()) {
                double d = Double.parseDouble(m.group(1)), h = Double.parseDouble(m.group(2));
                assertTrue(d >= c.appearMinDistance && d <= c.appearMaxDistance, "appear distance: " + call);
                assertTrue(h >= c.appearMinHeight && h <= c.appearMaxHeight, "appear height: " + call);
            } else if ((m = TRADE.matcher(call)).matches()) {
                range(call, Integer.parseInt(m.group(1)), 1, TradeOffers.MAX_TRADE_AMOUNT);
                range(call, Integer.parseInt(m.group(2)), 1, TradeOffers.MAX_TRADE_AMOUNT);
            } else if ((m = TELL.matcher(call)).matches()) {
                assertTrue(m.group(1).length() <= "Dieu : ".length() + GodService.MAX_SAY_CHARS, "God line too long");
            }
        }
        synchronized (buildWorld.batches) {
            for (int n : buildWorld.batches) range("place batch", n, 1, BuildGuard.MAX_BLOCKS_PER_CALL);
        }
        assertTrue(BuildGuard.active() >= 0 && BuildGuard.active() <= BuildGuard.MAX_CONCURRENT_SUB_BUILDS,
            "BuildGuard slots: " + BuildGuard.active());
        assertTrue(subBuilds.live() <= BuildGuard.MAX_CONCURRENT_SUB_BUILDS, "live leases: " + subBuilds.live());
    }

    private static void range(String what, long v, long lo, long hi) {
        assertTrue(v >= lo && v <= hi, what + ": " + v + " not in [" + lo + ", " + hi + "]");
    }

    // -- results ---------------------------------------------------------------------------------------------------

    static String text(McpSchema.CallToolResult r) {
        return McpTestClients.text(r);
    }

    /** The first group of {@code regex} in {@code text}, or a test failure naming both. */
    static String capture(String text, String regex) {
        Matcher m = Pattern.compile(regex).matcher(text);
        if (!m.find()) fail("no match for /" + regex + "/ in: " + text);
        return m.groupCount() >= 1 ? m.group(1) : m.group();
    }

    @Override
    public void close() {
        synchronized (clients) {
            for (McpSyncClient c : clients) {
                try {
                    c.close();
                } catch (RuntimeException ignored) {
                    // closing a client of a stopped server
                }
            }
        }
        servers.close();
        GodSessionManager.forceEndSession();
        BuildGuard.resetForTests();
    }
}
