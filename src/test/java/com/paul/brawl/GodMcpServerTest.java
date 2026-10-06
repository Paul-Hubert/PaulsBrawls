package com.paul.brawl;

import static com.paul.brawl.McpTestClients.call;
import static com.paul.brawl.McpTestClients.text;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.spec.McpSchema;

/**
 * Contract tests for the {@code god} MCP server (docs/27 phase 4): real server, real SDK client, real
 * {@link GodService} and {@link GodSessionManager}; only Minecraft and the Node body are recording stand-ins.
 */
class GodMcpServerTest {

    private static final String TOKEN = "test-token-god";

    private final UUID alice = UUID.randomUUID();
    private final UUID bob = UUID.randomUUID();
    private final AtomicLong now = new AtomicLong(5_000_000);
    private final AtomicBoolean bridge = new AtomicBoolean(true);
    private RecordingGodWorld world;
    private RecordingBodyTools body;
    private AgentTickets tickets;
    private AgentMcpServers servers;
    private McpSyncClient client;
    private String ticket;

    @BeforeEach
    void setUp() throws Exception {
        GodSessionManager.forceEndSession();
        world = new RecordingGodWorld();
        world.online.addAll(List.of(alice, bob));
        body = new RecordingBodyTools();
        tickets = new AgentTickets(now::get);
        servers = AgentMcpServers.start(0, () -> TOKEN, new GodService(world, BridgeConfig.INSTANCE), body, bridge::get,
            new BuildService(new RecordingBuildWorld()), tickets, new SubBuilds(now::get, 120_000));
        client = McpTestClients.connect(servers.port(), AgentMcpServers.GOD_PATH, TOKEN);
        assertTrue(GodSessionManager.claim(alice));
        ticket = tickets.mint(AgentTickets.Kind.GOD, alice, GodSessionManager.generation(), 600_000).id();
    }

    @AfterEach
    void tearDown() {
        if (client != null) client.close();
        if (servers != null) servers.close();
        GodSessionManager.forceEndSession();
    }

    private Map<String, Object> args(Object... kv) {
        Map<String, Object> m = new HashMap<>();
        m.put("ticket", ticket);
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    @Test
    void listsTheGodToolsAndNothingElse() {
        List<McpSchema.Tool> tools = client.listTools().tools();
        assertEquals(List.of("appear", "body_call", "body_tools", "change_weather", "end_session", "get_player_context",
                "offer_trade", "punish", "query_terrain", "reward", "say", "spawn_creature", "vanish", "wait"),
            tools.stream().map(McpSchema.Tool::name).sorted().collect(Collectors.toList()));
        for (McpSchema.Tool t : tools) assertTrue(BuilderMcpServerTest.required(t).contains("ticket"), t.name());
        assertFalse(tools.stream().anyMatch(t -> t.name().startsWith("place")), "the God cannot place blocks");
        McpSchema.Tool weather = tools.stream().filter(t -> t.name().equals("change_weather")).findFirst().orElseThrow();
        assertTrue(String.valueOf(weather.inputSchema()).contains("thunder"), "the weather enum is advertised");
    }

    @Test
    void anEncounterReachesTheWorld() {
        assertFalse(call(client, "say", args("message", "Approche.")).isError());
        assertFalse(call(client, "appear", args("distance", 2.5)).isError());
        assertFalse(call(client, "reward", args("item", "minecraft:diamond", "amount", 3)).isError());
        assertTrue(text(call(client, "get_player_context", args())).contains("Alice"));
        assertEquals(List.of("tell Dieu : Approche.", "appear 2.5 0.0 true", "give minecraft:diamond x3", "gesture nod", "context"),
            world.calls);
        assertEquals("Séance close.", text(call(client, "end_session", args())));
        assertFalse(GodSessionManager.isBusy(), "end_session releases the avatar");
        assertTrue(world.calls.contains("vanish"), "and sends a manifested body home");
        assertTrue(call(client, "say", args("message", "encore")).isError(), "the ticket died with the session");
    }

    @Test
    void componentsReachTheWorldIntact() {
        String book = "minecraft:enchanted_book[minecraft:enchantments={levels:{\"minecraft:sharpness\":5}}]";
        assertFalse(call(client, "reward", args("item", book, "amount", 1)).isError());
        assertEquals("give " + book + " x1", world.calls.get(0));
    }

    @Test
    void clampsHold() {
        assertTrue(text(call(client, "punish", args("strikes", 99))).contains("limité à " + BridgeConfig.INSTANCE.punishmentMax));
        assertTrue(text(call(client, "reward", args("item", "minecraft:diamond", "amount", 100_000))).contains("limité"));
        call(client, "spawn_creature", args("entity", "minecraft:cow", "count", 500, "dx", 9999, "dy", 0, "dz", -9999));
        int m = BridgeConfig.INSTANCE.spawnOffsetMax;
        assertTrue(world.calls.contains("spawn minecraft:cow x" + BridgeConfig.INSTANCE.spawnCountMax + " at " + m + ",0," + (-m)), world.calls.toString());
        assertTrue(text(call(client, "offer_trade", args("give_item", "minecraft:diamond", "give_amount", 1,
            "take_item", "minecraft:dirt", "take_amount", 9999))).startsWith("Trade cancelled."));
        assertTrue(call(client, "change_weather", args("weather", "snow", "duration_seconds", 10)).isError(),
            "the schema enum refuses an unknown weather before the tool runs");
    }

    @Test
    void anotherPlayerCannotUseGodTools() {
        // Bob prays while Alice holds the avatar: /pray refuses to mint him a ticket, so the only way in is a
        // ticket the agent kept or forged — none of them work.
        Map<String, Object> a = args("message", "je suis Bob");
        a.put("ticket", tickets.mint(AgentTickets.Kind.GOD, bob, GodSessionManager.generation(), 600_000).id());
        McpSchema.CallToolResult r = call(client, "say", a);
        assertTrue(r.isError());
        assertTrue(text(r).contains("terminée"));
        a.put("ticket", "god-forged");
        assertTrue(call(client, "say", a).isError());
        a.put("ticket", tickets.mint(AgentTickets.Kind.BUILDER, alice, 0, 600_000).id());
        assertTrue(call(client, "say", a).isError(), "a builder ticket opens nothing on god");
        assertTrue(world.calls.isEmpty());
    }

    @Test
    void aStaleTicketFromAnEarlierSessionIsDead() {
        GodSessionManager.forceEndSession(); // idle watchdog / /pray stop / /godbody off
        assertTrue(GodSessionManager.claim(alice)); // Alice prays again: a new generation
        McpSchema.CallToolResult r = call(client, "punish", args("strikes", 1));
        assertTrue(r.isError(), "the old ticket cannot strike in the new session");
        assertTrue(world.calls.isEmpty());
    }

    @Test
    void bodyToolsNeedTheBridge() {
        bridge.set(false); // /godbody off
        assertTrue(call(client, "appear", args()).isError());
        assertTrue(call(client, "body_call", args("tool", "move-to-position", "arguments", Map.of("x", 1))).isError());
        assertTrue(world.calls.isEmpty() && body.calls.isEmpty());
        bridge.set(true);
        assertTrue(text(call(client, "body_tools", args())).contains("move-to-position"));
        assertEquals("moved", text(call(client, "body_call", args("tool", "move-to-position", "arguments", Map.of("x", 1)))));
        assertEquals(List.of("move-to-position {\"x\":1}"), body.calls);
        assertTrue(call(client, "body_call", args("tool", "rm-rf")).isError());
    }

    @Test
    void anOfflinePlayerIsRefused() {
        world.online.remove(alice);
        McpSchema.CallToolResult r = call(client, "reward", args("item", "minecraft:diamond", "amount", 1));
        assertTrue(r.isError());
        assertEquals(MinecraftBuildWorld.OFFLINE, text(r));
    }

    @Test
    void waitIsBoundedServerSide() {
        long t0 = System.nanoTime();
        McpSchema.CallToolResult r = call(client, "wait", args("seconds", -50));
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertFalse(r.isError());
        assertTrue(text(r).contains(BridgeConfig.INSTANCE.waitMinSeconds + " seconde"), text(r));
        assertTrue(ms >= 900 && ms < 10_000, "slept the clamped minimum, took " + ms + " ms");
    }

    @Test
    void anExpiredTicketIsRefused() {
        now.addAndGet(600_000);
        assertTrue(call(client, "say", args("message", "x")).isError());
    }
}
