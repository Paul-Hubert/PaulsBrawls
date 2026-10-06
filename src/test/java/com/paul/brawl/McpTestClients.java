package com.paul.brawl;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.HttpClientStreamableHttpTransport;
import io.modelcontextprotocol.spec.McpSchema;

/** The official MCP Java SDK client, pointed at the mod's real server — no fake on the protocol side. */
final class McpTestClients {

    private McpTestClients() {}

    static McpSyncClient connect(int port, String path, String token) {
        HttpRequest.Builder rb = HttpRequest.newBuilder();
        if (token != null) rb.header("Authorization", "Bearer " + token);
        HttpClientStreamableHttpTransport transport = HttpClientStreamableHttpTransport.builder("http://127.0.0.1:" + port)
            .endpoint(path)
            .requestBuilder(rb)
            .openConnectionOnStartup(false)
            .build();
        McpSyncClient client = McpClient.sync(transport)
            .requestTimeout(Duration.ofSeconds(20))
            .clientInfo(McpSchema.Implementation.builder("paulsbrawls-contract-test", "1.0.0").build())
            .build();
        client.initialize();
        return client;
    }

    static McpSchema.CallToolResult call(McpSyncClient c, String tool, Map<String, Object> args) {
        return c.callTool(McpSchema.CallToolRequest.builder().name(tool).arguments(args).build());
    }

    static String text(McpSchema.CallToolResult r) {
        StringBuilder sb = new StringBuilder();
        for (McpSchema.Content c : r.content()) {
            if (c instanceof McpSchema.TextContent t) sb.append(t.text());
        }
        return sb.toString();
    }

    /** A raw POST, for the HTTP-level refusals the SDK client hides behind exceptions. */
    static HttpResponse<String> rawPost(int port, String path, Map<String, String> headers, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .POST(HttpRequest.BodyPublishers.ofString(body));
        headers.forEach(b::header);
        return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    static HttpResponse<String> rawGet(int port, String path, String token) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).GET();
        if (token != null) b.header("Authorization", "Bearer " + token);
        return HttpClient.newHttpClient().send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    static final String INIT = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\","
        + "\"capabilities\":{},\"clientInfo\":{\"name\":\"raw\",\"version\":\"1\"}}}";
}
