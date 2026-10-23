package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.jupiter.api.Test;

/**
 * The ~40 ms Nagle/delayed-ACK stall per MCP request is gone in production code. Each measurement runs in a FRESH
 * JVM ({@link McpLatencyMain}) with nothing set on the command line: the JDK reads {@code sun.net.httpserver.nodelay}
 * once per JVM, so only a fresh JVM shows what {@link AgentMcpServers#start} does on its own (the Gradle test JVM no
 * longer sets the property either).
 */
class McpTcpNoDelayTest {

    private static final Pattern OUT = Pattern.compile("median_ms=([0-9.]+) max_ms=([0-9.]+)");

    @Test
    void requestsDoNotWaitOnNagle() throws Exception {
        double tuned = medianMs(List.of());
        double nagle = medianMs(List.of("nagle"));
        System.out.printf("MCP request median: %.2f ms with JdkHttpServers.tcpNoDelay(), %.2f ms with Nagle on%n", tuned, nagle);
        assertTrue(tuned < 15, "a ping should take a few ms on loopback, took " + tuned + " ms (Nagle stall back?)");
        // Where the kernel delays ACKs (Linux does, ~40 ms), the explicit-Nagle run shows the stall this fixes.
        if (nagle > 30) assertTrue(tuned * 3 < nagle, "tuned " + tuned + " ms vs Nagle " + nagle + " ms");
    }

    private static double medianMs(List<String> args) throws Exception {
        List<String> cmd = new ArrayList<>();
        cmd.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
        cmd.add("-cp");
        cmd.add(System.getProperty("java.class.path"));
        cmd.add(McpLatencyMain.class.getName());
        cmd.addAll(args);
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(p.waitFor(60, TimeUnit.SECONDS), "child JVM hung: " + out);
        assertEquals(0, p.exitValue(), out);
        Matcher m = OUT.matcher(out);
        assertTrue(m.find(), "no measurement in: " + out);
        return Double.parseDouble(m.group(1));
    }
}
