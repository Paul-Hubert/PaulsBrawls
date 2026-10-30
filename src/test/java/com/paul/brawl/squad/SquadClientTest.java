package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.BufferedReader;
import java.io.StringReader;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;
import com.paul.brawl.JdkHttpServers;
import com.sun.net.httpserver.HttpServer;

class SquadClientTest {

    @Test
    void postSendsTheTokenAndReturnsTheJson() throws Exception {
        JdkHttpServers.tcpNoDelay();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> auth = new AtomicReference<>();
        AtomicReference<String> body = new AtomicReference<>();
        AtomicReference<String> version = new AtomicReference<>();
        server.createContext("/api/orders/start", ex -> {
            auth.set(ex.getRequestHeaders().getFirst("Authorization"));
            version.set(ex.getProtocol());
            body.set(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] out = "{\"ok\":true,\"text\":\"[Bots] « defend » lancé (#1)\"}".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, out.length);
            ex.getResponseBody().write(out);
            ex.close();
        });
        server.start();
        try {
            SquadClient c = new SquadClient(() -> "http://127.0.0.1:" + server.getAddress().getPort(), () -> "tok", Duration.ofSeconds(5));
            JsonObject b = new JsonObject();
            b.addProperty("command", "defend");
            JsonObject r = c.post("/api/orders/start", b).get();
            assertTrue(r.get("ok").getAsBoolean());
            assertEquals("[Bots] « defend » lancé (#1)", r.get("text").getAsString());
            assertEquals("Bearer tok", auth.get());
            assertEquals("{\"command\":\"defend\"}", body.get());
            assertEquals("HTTP/1.1", version.get());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void anUnreachableRuntimeIsAFrenchAnswerNotAnException() throws Exception {
        SquadClient c = new SquadClient(() -> "http://127.0.0.1:1", () -> "t", Duration.ofSeconds(2));
        JsonObject r = c.post("/api/health", new JsonObject()).get();
        assertFalse(r.get("ok").getAsBoolean());
        assertEquals(SquadClient.UNREACHABLE, r.get("text").getAsString());
    }

    @Test
    void sseFramingSkipsCommentsAndJoinsDataLines() throws Exception {
        String stream = "event: hello\ndata: {}\n\n: ping\n\nevent: notice\ndata: {\"to\":[\"u\"],\ndata: \"text\":\"hi\"}\n\nevent: state\ndata: {}\n\n";
        List<String> seen = new ArrayList<>();
        SquadClient.readSse(new BufferedReader(new StringReader(stream)), (ev, json) -> seen.add(ev + " " + json));
        assertEquals(List.of("hello {}", "notice {\"to\":[\"u\"],\"text\":\"hi\"}", "state {}"), seen);
    }
}
