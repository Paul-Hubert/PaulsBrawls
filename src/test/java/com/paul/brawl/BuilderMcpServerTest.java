package com.paul.brawl;

import static com.paul.brawl.McpTestClients.call;
import static com.paul.brawl.McpTestClients.text;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.spec.McpSchema;

/**
 * Contract tests for the {@code builder} MCP server (docs/27 phase 3): the real server on a real loopback port,
 * the official SDK client, and a recording world port standing in for Minecraft only.
 */
class BuilderMcpServerTest {

    private static final String TOKEN = "test-token-builder";

    private final UUID admin = UUID.randomUUID();
    private final UUID other = UUID.randomUUID();
    private final AtomicLong now = new AtomicLong(1_000_000);
    private RecordingBuildWorld world;
    private AgentTickets tickets;
    private SubBuilds subBuilds;
    private AgentMcpServers servers;
    private McpSyncClient client;
    private String ticket;

    @BeforeEach
    void setUp() throws Exception {
        BuildGuard.resetForTests();
        world = new RecordingBuildWorld();
        world.online.addAll(List.of(admin, other));
        world.origins.put(admin, new int[] { 100, 64, 200 });
        tickets = new AgentTickets(now::get);
        subBuilds = new SubBuilds(now::get, 120_000);
        servers = AgentMcpServers.start(0, () -> TOKEN, new GodService(new RecordingGodWorld(), BridgeConfig.INSTANCE),
            new RecordingBodyTools(), () -> true, new BuildService(world), tickets, subBuilds);
        client = McpTestClients.connect(servers.port(), AgentMcpServers.BUILDER_PATH, TOKEN);
        ticket = tickets.mint(AgentTickets.Kind.BUILDER, admin, 0, 600_000).id();
    }

    @AfterEach
    void tearDown() {
        if (client != null) client.close();
        if (servers != null) servers.close();
        BuildGuard.resetForTests();
    }

    private Map<String, Object> args(Object... kv) {
        Map<String, Object> m = new HashMap<>();
        m.put("ticket", ticket);
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    private String begin(int ax, int ay, int az) {
        McpSchema.CallToolResult r = call(client, "begin_sub_build", args("label", "tour", "anchor_x", ax, "anchor_y", ay, "anchor_z", az));
        assertFalse(r.isError(), text(r));
        String t = text(r);
        return t.substring(t.indexOf("sub_build=") + 10, t.indexOf(' ', t.indexOf("sub_build=")));
    }

    @SuppressWarnings("unchecked")
    static List<String> required(McpSchema.Tool t) {
        return (List<String>) t.inputSchema().get("required");
    }

    @Test
    void listsExactlyThePrimitivesWithTicketRequired() {
        List<McpSchema.Tool> tools = client.listTools().tools();
        assertEquals(List.of("begin_sub_build", "end_sub_build", "get_block_info", "get_build_origin",
                "place_block", "place_blocks", "place_line", "query_terrain"),
            tools.stream().map(McpSchema.Tool::name).sorted().collect(Collectors.toList()));
        for (McpSchema.Tool t : tools) {
            assertTrue(required(t).contains("ticket"), t.name() + " requires a ticket");
            assertEquals(Boolean.FALSE, t.inputSchema().get("additionalProperties"), t.name());
        }
        McpSchema.Tool line = tools.stream().filter(t -> t.name().equals("place_line")).findFirst().orElseThrow();
        assertTrue(required(line).containsAll(List.of("sub_build", "x1", "y1", "z1", "x2", "y2", "z2", "block")));
    }

    @Test
    void aSubBuildPlacesRelativeToItsAnchor() {
        String sb = begin(10, 0, -5);
        McpSchema.CallToolResult r = call(client, "place_block", args("sub_build", sb, "x", 1, "y", 2, "z", 3, "block", "minecraft:stone"));
        assertFalse(r.isError(), text(r));
        assertEquals(List.of("111,66,198 minecraft:stone"), world.placed);

        r = call(client, "place_line", args("sub_build", sb, "x1", 0, "y1", 0, "z1", 0, "x2", 2, "y2", 0, "z2", 0,
            "block", "minecraft:oak_stairs[facing=north]"));
        assertFalse(r.isError(), text(r));
        assertEquals(4, world.placed.size());
        assertEquals("112,64,195 minecraft:oak_stairs[facing=north]", world.placed.get(3));

        r = call(client, "place_blocks", args("sub_build", sb, "xs", List.of(0, 0), "ys", List.of(5, 6), "zs", List.of(0, 0),
            "block", "minecraft:oak_planks"));
        assertFalse(r.isError(), text(r));
        assertEquals("110,70,195 minecraft:oak_planks", world.placed.get(5));

        assertFalse(call(client, "end_sub_build", args("sub_build", sb)).isError());
        assertEquals(0, BuildGuard.active(), "end_sub_build releases the slot");
        assertTrue(call(client, "place_block", args("sub_build", sb, "x", 0, "y", 0, "z", 0, "block", "minecraft:stone")).isError(),
            "a closed sub-build accepts nothing");
    }

    @Test
    void readToolsAnswer() {
        assertEquals("Pivot : x=100 y=64 z=200", text(call(client, "get_build_origin", args())));
        assertTrue(text(call(client, "get_block_info", args())).contains("grass_block"));
        assertEquals("terrain-map", text(call(client, "query_terrain", args("radius", 16))));
    }

    @Test
    void ticketRefusals() {
        Map<String, Object> a = args();
        a.put("ticket", "bld-forged");
        assertTrue(call(client, "get_build_origin", a).isError(), "unknown ticket");

        String godTicket = tickets.mint(AgentTickets.Kind.GOD, admin, 0, 600_000).id();
        a.put("ticket", godTicket);
        assertTrue(call(client, "get_build_origin", a).isError(), "a god ticket opens nothing on the builder");

        now.addAndGet(600_001);
        McpSchema.CallToolResult expired = call(client, "get_build_origin", args());
        assertTrue(expired.isError(), "expired ticket");
        assertTrue(text(expired).contains("expiré"));
    }

    @Test
    void worldRefusals() {
        String sb = begin(0, 0, 0);
        McpSchema.CallToolResult r = call(client, "place_block", args("sub_build", sb, "x", 0, "y", 0, "z", 0, "block", "minecraft:unobtainium"));
        assertTrue(r.isError());
        assertTrue(text(r).startsWith("Bloc inconnu"));

        world.online.remove(admin);
        r = call(client, "place_block", args("sub_build", sb, "x", 0, "y", 0, "z", 0, "block", "minecraft:stone"));
        assertTrue(r.isError());
        assertEquals(MinecraftBuildWorld.OFFLINE, text(r));
        world.online.add(admin);

        world.origins.remove(admin);
        r = call(client, "begin_sub_build", args("anchor_x", 0, "anchor_y", 0, "anchor_z", 0));
        assertTrue(r.isError());
        assertTrue(text(r).contains("/construction"), "no origin");
        assertTrue(world.placed.isEmpty());
    }

    @Test
    void theBlockCapHolds() {
        String sb = begin(0, 0, 0);
        McpSchema.CallToolResult r = call(client, "place_line", args("sub_build", sb, "x1", 0, "y1", 0, "z1", 0,
            "x2", 1_000_000, "y2", 0, "z2", 0, "block", "minecraft:stone"));
        assertTrue(r.isError());
        assertTrue(text(r).startsWith("Appel refusé"), text(r));

        List<Integer> many = new ArrayList<>();
        for (int i = 0; i <= BuildGuard.MAX_BLOCKS_PER_CALL; i++) many.add(i);
        r = call(client, "place_blocks", args("sub_build", sb, "xs", many, "ys", many, "zs", many, "block", "minecraft:stone"));
        assertTrue(r.isError());
        assertTrue(text(r).startsWith("Appel refusé"), text(r));

        r = call(client, "place_blocks", args("sub_build", sb, "xs", List.of(1, 2), "ys", List.of(1), "zs", List.of(1, 2),
            "block", "minecraft:stone"));
        assertTrue(r.isError(), "mismatched arrays");
        assertTrue(world.placed.isEmpty());
    }

    @Test
    void atMostFourSubBuildsServerWide() {
        for (int i = 0; i < BuildGuard.MAX_CONCURRENT_SUB_BUILDS; i++) begin(i * 16, 0, 0);
        McpSchema.CallToolResult fifth = call(client, "begin_sub_build", args("anchor_x", 99, "anchor_y", 0, "anchor_z", 0));
        assertTrue(fifth.isError());
        assertTrue(text(fifth).contains("tournent déjà"));
        assertTrue(call(client, "begin_sub_build", args("anchor_x", 300, "anchor_y", 0, "anchor_z", 0)).isError(),
            "anchor beyond ±256");
    }

    @Test
    void cancelledAndIdleSubBuildsAreClosedAndReleased() {
        String sb = begin(0, 0, 0);
        BuildGuard.cancelAll(); // /godbody off
        McpSchema.CallToolResult r = call(client, "place_block", args("sub_build", sb, "x", 0, "y", 0, "z", 0, "block", "minecraft:stone"));
        assertTrue(r.isError(), "a cancelled build stays cancelled");
        assertEquals(0, BuildGuard.active(), "and its slot is free");

        String idle = begin(0, 0, 0);
        now.addAndGet(120_000);
        assertTrue(call(client, "place_block", args("sub_build", idle, "x", 0, "y", 0, "z", 0, "block", "minecraft:stone")).isError(),
            "a lease idle for 120 s is gone");
        assertEquals(0, BuildGuard.active());
        assertTrue(world.placed.isEmpty());
    }

    @Test
    void aSubBuildBelongsToOneBuild() {
        String sb = begin(0, 0, 0);
        world.origins.put(other, new int[] { 0, 0, 0 });
        Map<String, Object> a = args("sub_build", sb, "x", 0, "y", 0, "z", 0, "block", "minecraft:stone");
        a.put("ticket", tickets.mint(AgentTickets.Kind.BUILDER, other, 0, 600_000).id());
        assertTrue(call(client, "place_block", a).isError());
        assertTrue(world.placed.isEmpty());
    }

    @Test
    void httpLevelRefusals() throws Exception {
        int port = servers.port();
        String path = AgentMcpServers.BUILDER_PATH;
        assertEquals(401, McpTestClients.rawPost(port, path, Map.of(), McpTestClients.INIT).statusCode(), "no token");
        assertEquals(401, McpTestClients.rawPost(port, path, Map.of("Authorization", "Bearer nope"), McpTestClients.INIT).statusCode());
        assertEquals(403, McpTestClients.rawPost(port, path,
            Map.of("Authorization", "Bearer " + TOKEN, "Origin", "http://evil.example"), McpTestClients.INIT).statusCode(), "DNS rebinding guard");
        assertEquals(200, McpTestClients.rawPost(port, path,
            Map.of("Authorization", "Bearer " + TOKEN, "Origin", "http://localhost:3000"), McpTestClients.INIT).statusCode());
        assertEquals(405, McpTestClients.rawGet(port, path, TOKEN).statusCode(), "no SSE stream");
        assertEquals(400, McpTestClients.rawPost(port, path, Map.of("Authorization", "Bearer " + TOKEN), "{not json").statusCode());
        assertThrows(RuntimeException.class, () -> McpTestClients.connect(port, path, "wrong"), "the SDK client is refused too");
    }
}
