package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.paul.brawl.AgentBackend;
import com.paul.brawl.JdkHttpServers;
import com.sun.net.httpserver.HttpServer;

class SquadAuthoringTest {

    private static final UUID PAUL = UUID.fromString("00000000-0000-0000-0000-00000000aaaa");

    private HttpServer runtime;
    private final List<String> calls = new CopyOnWriteArrayList<>();
    private volatile String closeAnswer = "{\"ok\":true,\"text\":\"\",\"submitted\":{\"version\":2,\"summary\":\"Miner une zone\",\"usage\":\"/bots order mine <count> [block=stone]\"}}";
    private volatile String openAnswer = "{\"ok\":true,\"text\":\"\",\"ticket\":\"cmd-abc\",\"message\":\"[Nouvelle commande]\\nTicket : cmd-abc\"}";

    @BeforeEach
    void start() throws Exception {
        JdkHttpServers.tcpNoDelay();
        runtime = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        runtime.createContext("/", ex -> {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            calls.add(ex.getRequestURI().getPath() + " " + body);
            String out = ex.getRequestURI().getPath().endsWith("/open") ? openAnswer : closeAnswer;
            byte[] b = out.getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        runtime.start();
    }

    @AfterEach
    void stop() {
        runtime.stop(0);
    }

    /** An agent that answers after `latch` opens, recording what it was sent. */
    static final class FakeAgent implements AgentBackend {
        final List<String> sent = new CopyOnWriteArrayList<>();
        final CountDownLatch latch;
        final Reply reply;
        FakeAgent(CountDownLatch latch, Reply reply) {
            this.latch = latch;
            this.reply = reply;
        }
        @Override public String createSession(String title) { return "sid-" + title.hashCode(); }
        @Override public Reply send(String sessionId, String agent, String text, byte[] image, Duration timeout) {
            sent.add(agent + "|" + text);
            try {
                latch.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return reply;
        }
        @Override public void abort(String sessionId) {}
    }

    private SquadClient client() {
        return new SquadClient(() -> "http://127.0.0.1:" + runtime.getAddress().getPort(), () -> "t", Duration.ofSeconds(5));
    }

    @Test
    void aTurnOpensRunsTheAgentClosesAndAnnouncesTheCommand() throws Exception {
        List<SquadNotice> told = new CopyOnWriteArrayList<>();
        FakeAgent agent = new FakeAgent(new CountDownLatch(0), new AgentBackend.Reply("Tes mineurs ont besoin de pioches.", null, null));
        SquadAuthoring a = new SquadAuthoring(client(), agent, (p, n) -> told.add(n), "squad-author", Duration.ofSeconds(5), 2);
        Thread t = a.start("create", PAUL, "Paul", "mine", "miner une zone", new JsonObject());
        assertNotNull(t);
        t.join(10_000);

        JsonObject open = JsonParser.parseString(calls.get(0).substring(calls.get(0).indexOf(' ') + 1)).getAsJsonObject();
        assertEquals("create", open.get("mode").getAsString());
        assertEquals("mine", open.get("name").getAsString());
        assertEquals("Paul", open.getAsJsonObject("by").get("name").getAsString());
        assertEquals("/api/authoring/close {\"ticket\":\"cmd-abc\"}", calls.get(1));
        assertEquals(List.of("squad-author|[Nouvelle commande]\nTicket : cmd-abc"), agent.sent);

        assertEquals(3, told.size());
        assertTrue(told.get(0).text().startsWith("[Bots] Écriture de « mine »"));
        SquadNotice ready = told.get(1);
        assertEquals("[Bots] Commande « mine » prête (v2) : Miner une zone. Utilise ", ready.text());
        assertEquals("/bots order mine <count> [block=stone]", ready.clickLabel());
        assertEquals("/bots order mine ", ready.clickCommand());
        assertEquals("[Bots] Tes mineurs ont besoin de pioches.", told.get(2).text());
    }

    @Test
    void oneTurnPerPlayerAtATime() throws Exception {
        List<SquadNotice> told = new CopyOnWriteArrayList<>();
        CountDownLatch release = new CountDownLatch(1);
        SquadAuthoring a = new SquadAuthoring(client(), new FakeAgent(release, new AgentBackend.Reply("", null, null)), (p, n) -> told.add(n),
            "squad-author", Duration.ofSeconds(5), 2);
        Thread first = a.start("create", PAUL, "Paul", "one", "x", new JsonObject());
        assertNull(a.start("create", PAUL, "Paul", "two", "y", new JsonObject()));
        assertTrue(told.stream().anyMatch(n -> n.text().contains("« one » est déjà en cours d'écriture")));
        release.countDown();
        first.join(10_000);
        assertTrue(!a.writing(PAUL));
    }

    @Test
    void nothingSubmittedTellsWhy() throws Exception {
        closeAnswer = "{\"ok\":true,\"text\":\"\"}";
        List<SquadNotice> told = new CopyOnWriteArrayList<>();
        SquadAuthoring a = new SquadAuthoring(client(), new FakeAgent(new CountDownLatch(0),
            new AgentBackend.Reply("", AgentBackend.Failure.TIMEOUT, "slow")), (p, n) -> told.add(n), "squad-author", Duration.ofSeconds(5), 2);
        a.start("create", PAUL, "Paul", "mine", "x", new JsonObject()).join(10_000);
        assertEquals("[Bots] « mine » n'a pas pu être écrite : l'agent a dépassé le temps imparti.", told.get(told.size() - 1).text());
    }

    @Test
    void aRefusedOpenIsShownAndTheAgentIsNeverCalled() throws Exception {
        openAnswer = "{\"ok\":false,\"text\":\"[Bots] tu ne possèdes aucun bot\"}";
        List<SquadNotice> told = new CopyOnWriteArrayList<>();
        FakeAgent agent = new FakeAgent(new CountDownLatch(0), new AgentBackend.Reply("x", null, null));
        SquadAuthoring a = new SquadAuthoring(client(), agent, (p, n) -> told.add(n), "squad-author", Duration.ofSeconds(5), 2);
        a.start("create", PAUL, "Paul", "mine", "x", new JsonObject()).join(10_000);
        assertEquals(List.of("[Bots] tu ne possèdes aucun bot"), told.stream().map(SquadNotice::text).toList());
        assertTrue(agent.sent.isEmpty());
    }
}
