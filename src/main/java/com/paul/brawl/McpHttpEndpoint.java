package com.paul.brawl;

import java.io.IOException;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import io.modelcontextprotocol.common.McpTransportContext;
import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.server.McpStatelessServerHandler;
import io.modelcontextprotocol.spec.McpError;
import io.modelcontextprotocol.spec.McpSchema;
import io.modelcontextprotocol.spec.McpStatelessServerTransport;
import reactor.core.publisher.Mono;

/**
 * One MCP endpoint ({@code /mcp/god} or {@code /mcp/builder}) on the JDK {@code HttpServer}: the stateless
 * Streamable-HTTP profile (docs/27 §2). It mirrors the SDK's own {@code HttpServletStatelessServerTransport} without a
 * servlet container — a POST carries one JSON-RPC message, a request gets {@code 200 application/json}, a
 * notification {@code 202}, and GET/DELETE get {@code 405} (no server-initiated stream). All protocol semantics
 * (initialize, tools/list, tools/call, input validation) stay in the SDK's {@link McpStatelessServerHandler}.
 *
 * <p>In front of it: a bearer token (constant-time compare, {@code 401}) and an Origin check ({@code 403} for a
 * non-loopback origin — the DNS-rebinding guard of the MCP spec). The server is bound to 127.0.0.1 by
 * {@link AgentMcpServers}.
 */
final class McpHttpEndpoint implements McpStatelessServerTransport, HttpHandler {

    private static final Logger LOGGER = LoggerFactory.getLogger("McpHttpEndpoint");

    static final int MAX_BODY_BYTES = 1024 * 1024;

    private final String path;
    private final McpJsonMapper mapper;
    private final Supplier<String> token;
    private volatile McpStatelessServerHandler handler;
    private volatile boolean closing;

    McpHttpEndpoint(String path, McpJsonMapper mapper, Supplier<String> token) {
        this.path = path;
        this.mapper = mapper;
        this.token = token;
    }

    String path() {
        return path;
    }

    @Override
    public void setMcpHandler(McpStatelessServerHandler handler) {
        this.handler = handler;
    }

    @Override
    public Mono<Void> closeGracefully() {
        return Mono.fromRunnable(() -> closing = true);
    }

    @Override
    public void handle(HttpExchange ex) throws IOException {
        try (ex) {
            if (!ex.getRequestURI().getPath().equals(path)) {
                plain(ex, 404, "not found");
                return;
            }
            if (!originAllowed(ex.getRequestHeaders().getFirst("Origin"))) {
                plain(ex, 403, "forbidden origin");
                return;
            }
            if (!tokenMatches(ex.getRequestHeaders().getFirst("Authorization"), token.get())) {
                ex.getResponseHeaders().set("WWW-Authenticate", "Bearer");
                plain(ex, 401, "bad or missing bearer token");
                return;
            }
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.getResponseHeaders().set("Allow", "POST");
                plain(ex, 405, "POST only (stateless server, no SSE stream)");
                return;
            }
            if (closing || handler == null) {
                plain(ex, 503, "server is shutting down");
                return;
            }
            byte[] body = ex.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
            if (body.length > MAX_BODY_BYTES) {
                plain(ex, 413, "body too large");
                return;
            }
            McpTransportContext ctx = McpTransportContext.create(Map.of("endpoint", path));
            McpSchema.JSONRPCMessage msg;
            try {
                msg = McpSchema.deserializeJsonRpcMessage(mapper, new String(body, StandardCharsets.UTF_8));
            } catch (Exception e) {
                jsonError(ex, 400, null, McpSchema.ErrorCodes.PARSE_ERROR, "Invalid message format");
                return;
            }
            if (msg instanceof McpSchema.JSONRPCRequest req) {
                McpSchema.JSONRPCResponse resp;
                try {
                    resp = handler.handleRequest(ctx, req)
                        .contextWrite(c -> c.put(McpTransportContext.KEY, ctx))
                        .block();
                } catch (McpError e) {
                    resp = new McpSchema.JSONRPCResponse(McpSchema.JSONRPC_VERSION, req.id(), null, e.getJsonRpcError());
                } catch (RuntimeException e) {
                    LOGGER.warn("MCP request {} on {} failed: {}", req.method(), path, e.toString());
                    jsonError(ex, 500, req.id(), McpSchema.ErrorCodes.INTERNAL_ERROR, "internal error");
                    return;
                }
                json(ex, 200, mapper.writeValueAsString(resp));
            } else if (msg instanceof McpSchema.JSONRPCNotification note) {
                try {
                    handler.handleNotification(ctx, note)
                        .contextWrite(c -> c.put(McpTransportContext.KEY, ctx))
                        .block();
                } catch (RuntimeException e) {
                    LOGGER.debug("MCP notification {} failed: {}", note.method(), e.toString());
                }
                ex.sendResponseHeaders(202, -1);
            } else {
                jsonError(ex, 400, null, McpSchema.ErrorCodes.INVALID_REQUEST,
                    "The server accepts either requests or notifications");
            }
        } catch (IOException e) {
            LOGGER.debug("MCP exchange on {} aborted: {}", path, e.toString());
        } catch (RuntimeException e) {
            LOGGER.warn("MCP exchange on {} failed: {}", path, e.toString(), e);
        }
    }

    /** No Origin (a non-browser client) or a loopback one. */
    static boolean originAllowed(String origin) {
        if (origin == null || origin.isBlank()) return true;
        try {
            String host = URI.create(origin.trim()).getHost();
            return host != null && List.of("localhost", "127.0.0.1", "[::1]", "::1").contains(host.toLowerCase());
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** {@code Authorization: Bearer <expected>}, compared in constant time; a blank expected token refuses all. */
    static boolean tokenMatches(String authorization, String expected) {
        if (expected == null || expected.isBlank() || authorization == null) return false;
        String a = authorization.trim();
        if (a.length() < 7 || !a.regionMatches(true, 0, "Bearer ", 0, 7)) return false;
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
            a.substring(7).trim().getBytes(StandardCharsets.UTF_8));
    }

    private void jsonError(HttpExchange ex, int status, Object id, int code, String message) throws IOException {
        // Written by hand: the error path must not depend on the mapper accepting a null id.
        String idJson = id instanceof Number ? id.toString()
            : id == null ? "null" : "\"" + id.toString().replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        json(ex, status, "{\"jsonrpc\":\"2.0\",\"id\":" + idJson + ",\"error\":{\"code\":" + code
            + ",\"message\":\"" + message.replace("\"", "'") + "\"}}");
    }

    private static void json(HttpExchange ex, int status, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(b);
        }
    }

    private static void plain(HttpExchange ex, int status, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(b);
        }
    }
}
