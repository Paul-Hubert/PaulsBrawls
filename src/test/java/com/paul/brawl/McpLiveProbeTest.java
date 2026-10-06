package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import org.junit.jupiter.api.Test;

/** The live probe ({@code gradle mcpProbe}) is itself tested: all green on the bench, and it notices a wrong token. */
class McpLiveProbeTest {

    @Test
    void passesAgainstTheRealServersAndTouchesNothing() throws Exception {
        try (McpBench bench = new McpBench()) {
            bench.godTicket("alice"); // a live session the probe must not be able to use
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            List<String> failed = new McpLiveProbe("http://127.0.0.1:" + bench.port(), McpBench.TOKEN,
                new PrintStream(buf, true, StandardCharsets.UTF_8)).run();
            String out = buf.toString(StandardCharsets.UTF_8);
            assertEquals(List.of(), failed, out);
            assertTrue(out.contains("ALL PASS"), out);
            assertEquals(2 * 7 + McpLiveProbe.GOD_TOOLS.size() + McpLiveProbe.BUILDER_TOOLS.size(),
                out.lines().filter(l -> l.startsWith("PASS ")).count(), out);
            assertTrue(bench.snapshot().isEmpty(), "the probe reached the world: " + bench.snapshot());
            assertEquals(bench.player("alice"), GodSessionManager.currentOwner());
        }
    }

    @Test
    void aWrongTokenFails() throws Exception {
        try (McpBench bench = new McpBench()) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            List<String> failed = new McpLiveProbe("http://127.0.0.1:" + bench.port(), "not-the-token",
                new PrintStream(buf, true, StandardCharsets.UTF_8)).run();
            assertFalse(failed.isEmpty());
            assertTrue(buf.toString(StandardCharsets.UTF_8).contains("FAIL god: initialize"));
        }
    }

    @Test
    void anUnreachableServerFailsCleanly() throws Exception {
        int port;
        try (java.net.ServerSocket s = new java.net.ServerSocket(0)) {
            port = s.getLocalPort();
        }
        List<String> failed = new McpLiveProbe("http://127.0.0.1:" + port, "x",
            new PrintStream(new ByteArrayOutputStream(), true, StandardCharsets.UTF_8)).run();
        assertFalse(failed.isEmpty());
    }
}
