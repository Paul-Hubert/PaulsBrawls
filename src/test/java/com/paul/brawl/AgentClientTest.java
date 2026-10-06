package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;

import org.junit.jupiter.api.Test;

/** The opencode reply shape (checked against opencode 1.18.34 in AgentE2ETest) and the down path. */
class AgentClientTest {

    @Test
    void finalTextIsTheTextPartsJoined() {
        AgentClient.Reply r = AgentClient.parseReply("{\"info\":{\"role\":\"assistant\",\"finish\":\"stop\"},\"parts\":["
            + "{\"type\":\"step-start\"},{\"type\":\"reasoning\",\"text\":\"hmm\"},{\"type\":\"text\",\"text\":\"Approche.\"},"
            + "{\"type\":\"tool\",\"tool\":\"god_say\"},{\"type\":\"text\",\"text\":\" Tremble. \"},{\"type\":\"step-finish\"}]}");
        assertTrue(r.ok());
        assertEquals("Approche.\n Tremble.", r.text());
    }

    @Test
    void anErrorInTheAssistantInfoIsAFailure() {
        AgentClient.Reply r = AgentClient.parseReply("{\"info\":{\"error\":{\"name\":\"ProviderAuthError\",\"data\":{\"message\":\"bad key\"}}},\"parts\":[]}");
        assertFalse(r.ok());
        assertEquals(AgentClient.Failure.ERROR, r.failure());
        assertTrue(r.detail().contains("ProviderAuthError"));
        assertEquals(AgentClient.Failure.ERROR, AgentClient.parseReply("not json").failure());
    }

    @Test
    void anUnreachableAgentIsDown() throws Exception {
        int port;
        try (var s = new java.net.ServerSocket(0)) {
            port = s.getLocalPort();
        }
        AgentClient c = new AgentClient("http://127.0.0.1:" + port, "opencode", "");
        AgentClient.Reply r = c.send("ses_x", "god", "allô", null, Duration.ofSeconds(5));
        assertEquals(AgentClient.Failure.DOWN, r.failure());
    }
}
