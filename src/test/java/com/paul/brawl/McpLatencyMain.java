package com.paul.brawl;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Arrays;

/**
 * Run in a FRESH JVM by {@link McpTcpNoDelayTest}: start the real MCP servers the way production does
 * ({@link AgentMcpServers#start}, through {@link McpBench}) and time sequential keep-alive requests. Prints one line,
 * {@code median_ms=<x> max_ms=<y>}. With the argument {@code nagle}, {@code sun.net.httpserver.nodelay=false} is set
 * explicitly first, which is what the JVM did before {@link JdkHttpServers#tcpNoDelay()} existed.
 */
public final class McpLatencyMain {

    private McpLatencyMain() {}

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("nagle")) System.setProperty(JdkHttpServers.NODELAY, "false");
        int n = 40;
        try (McpBench bench = new McpBench()) {
            HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
            HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + bench.port() + AgentMcpServers.GOD_PATH))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .header("Authorization", "Bearer " + McpBench.TOKEN)
                .POST(HttpRequest.BodyPublishers.ofString("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}"))
                .build();
            for (int i = 0; i < 5; i++) http.send(req, HttpResponse.BodyHandlers.ofString()); // warm-up
            double[] ms = new double[n];
            for (int i = 0; i < n; i++) {
                long t0 = System.nanoTime();
                HttpResponse<String> r = http.send(req, HttpResponse.BodyHandlers.ofString());
                ms[i] = (System.nanoTime() - t0) / 1e6;
                if (r.statusCode() != 200) throw new IllegalStateException("HTTP " + r.statusCode() + ": " + r.body());
            }
            Arrays.sort(ms);
            System.out.printf(java.util.Locale.ROOT, "median_ms=%.2f max_ms=%.2f%n", ms[n / 2], ms[n - 1]);
        }
        System.exit(0);
    }
}
