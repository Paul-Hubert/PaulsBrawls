package com.paul.brawl;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;

import io.modelcontextprotocol.json.jackson2.JacksonMcpJsonMapper;
import io.modelcontextprotocol.json.schema.jackson2.DefaultJsonSchemaValidator;

/**
 * The loopback HTTP host of the mod's MCP servers (docs/27 §2): {@code http://127.0.0.1:<mcpPort>/mcp/god} and
 * {@code /mcp/builder}, one virtual thread per request, bearer token required. The JSON mapper and schema
 * validator are passed explicitly: the SDK's ServiceLoader defaults are not relied on under Fabric's class loader.
 */
public final class AgentMcpServers implements AutoCloseable {

    private static final Logger LOGGER = LoggerFactory.getLogger("AgentMcpServers");

    public static final String BUILDER_PATH = "/mcp/builder";
    public static final String GOD_PATH = "/mcp/god";

    private final HttpServer http;
    private final ExecutorService executor;
    private final BuilderMcpServer builder;
    private final GodMcpServer god;

    private AgentMcpServers(HttpServer http, ExecutorService executor, BuilderMcpServer builder, GodMcpServer god) {
        this.http = http;
        this.executor = executor;
        this.builder = builder;
        this.god = god;
    }

    /** Bind 127.0.0.1:{@code port} (0 = any free port, for tests) and start serving. */
    public static AgentMcpServers start(int port, Supplier<String> token, GodService godService, BodyTools body,
            BooleanSupplier bridgeEnabled, BuildService build, AgentTickets tickets, SubBuilds subBuilds) throws IOException {
        ObjectMapper om = new ObjectMapper();
        JacksonMcpJsonMapper mapper = new JacksonMcpJsonMapper(om);
        DefaultJsonSchemaValidator validator = new DefaultJsonSchemaValidator(om);

        HttpServer http = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 0);
        McpHttpEndpoint builderEndpoint = new McpHttpEndpoint(BUILDER_PATH, mapper, token);
        BuilderMcpServer builder = new BuilderMcpServer(builderEndpoint, mapper, validator, build, tickets, subBuilds);
        http.createContext(BUILDER_PATH, builderEndpoint);
        McpHttpEndpoint godEndpoint = new McpHttpEndpoint(GOD_PATH, mapper, token);
        GodMcpServer god = new GodMcpServer(godEndpoint, mapper, validator, godService, tickets, body, bridgeEnabled);
        http.createContext(GOD_PATH, godEndpoint);

        ExecutorService executor = Executors.newThreadPerTaskExecutor(
            Thread.ofVirtual().name("mcp-http-", 0).factory());
        http.setExecutor(executor);
        http.start();
        LOGGER.info("MCP servers on http://127.0.0.1:{} ({}, {})", http.getAddress().getPort(), GOD_PATH, BUILDER_PATH);
        return new AgentMcpServers(http, executor, builder, god);
    }

    public int port() {
        return http.getAddress().getPort();
    }

    @Override
    public void close() {
        builder.server().close();
        god.server().close();
        http.stop(0);
        executor.shutdownNow();
        LOGGER.info("MCP servers stopped.");
    }
}
