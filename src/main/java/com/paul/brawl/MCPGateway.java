package com.paul.brawl;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.mcp.client.DefaultMcpClient;
import dev.langchain4j.mcp.client.McpClient;
import dev.langchain4j.mcp.client.transport.McpTransport;
import dev.langchain4j.mcp.client.transport.stdio.StdioMcpTransport;

/**
 * Lazy singleton that owns the Node subprocess hosting {@code minecraft-mcp-server}
 * and exposes its 21 Mineflayer-driven tools to {@link ChatBot}.
 *
 * <p>Lifecycle: cold until the first {@link #tools()} call. The subprocess is
 * spawned via {@link StdioMcpTransport} so the {@link McpClient} talks to it over
 * the child's stdio, matching the MCP server's default transport. The Mineflayer
 * bot inside the server connects to the Minecraft server using the host/port/user
 * specified by {@link MCPConfig}.</p>
 *
 * <p>Failure mode: if {@link MCPConfig#enabled} is false, or the subprocess fails
 * to start, or {@code listTools()} throws, {@link #tools()} returns an empty list
 * and the gateway stays disabled. The error is logged loudly but does <strong>not
 * </strong> break the rest of {@code godBot} — only the MCP-sourced tools go
 * missing for the rest of the run.</p>
 *
 * <p>Dispatch contract: {@link #execute(ToolExecutionRequest)} either returns the
 * MCP server's stringified tool result, or — if the gateway is not initialised /
 * the call failed / the name is unknown — returns a human-readable error string
 * (it does <strong>not</strong> throw). This is so {@link ChatBotFunctions} can
 * forward the result to the model as a normal tool-output message without
 * special-casing failures.</p>
 */
public final class MCPGateway {

    private static final Logger LOGGER = LoggerFactory.getLogger("MCPGateway");

    public static final MCPGateway INSTANCE = new MCPGateway();

    /** Cached tool names from the last successful {@link #ensureStarted()} so
     *  {@link #handlesTool(String)} can answer without re-listing. */
    private volatile List<String> toolNames = Collections.emptyList();

    private volatile List<ToolSpecification> toolSpecs = Collections.emptyList();

    private volatile McpClient client;

    /** Tristate: null=untried, TRUE=running, FALSE=tried and failed (don't retry). */
    private volatile Boolean started;

    private MCPGateway() {}

    /**
     * Returns the MCP-sourced tool specs. First call spawns the subprocess; later
     * calls return the cached list. Empty list on disabled / failed startup.
     */
    public List<ToolSpecification> tools() {
        ensureStarted();
        return toolSpecs;
    }

    /**
     * True iff the gateway has the given tool name in its MCP catalogue. Used by
     * {@link ChatBotFunctions#executeFunction} to decide whether to forward an
     * unknown tool call to MCP rather than throwing.
     */
    public boolean handlesTool(String name) {
        if (name == null) return false;
        return toolNames.contains(name);
    }

    /**
     * Dispatch one tool call to the MCP server. Returns the server's textual
     * result on success, or an error string on any failure. Never throws — see
     * the class-level contract.
     */
    public String execute(ToolExecutionRequest req) {
        ensureStarted();
        if (client == null) {
            return "MCP gateway not running — tool '" + (req == null ? "?" : req.name())
                + "' could not be dispatched.";
        }
        if (req == null) {
            return "MCP execute called with a null request.";
        }
        try {
            String out = client.executeTool(req);
            return out == null ? "" : out;
        } catch (Exception e) {
            LOGGER.warn("MCP tool '{}' execution failed: {}", req.name(), e.getMessage(), e);
            return "MCP tool '" + req.name() + "' failed: " + e.getMessage();
        }
    }

    /**
     * Stop the subprocess and reset state. Idempotent. Safe to call from
     * {@code SERVER_STOPPING}.
     */
    public synchronized void shutdown() {
        if (client != null) {
            try {
                client.close();
                LOGGER.info("MCP client closed.");
            } catch (Exception e) {
                LOGGER.warn("MCP client close failed: {}", e.getMessage());
            }
            client = null;
        }
        toolNames = Collections.emptyList();
        toolSpecs = Collections.emptyList();
        started = null;
    }

    /**
     * Spawn the Node subprocess + create the client on first call. Synchronized
     * so concurrent {@link #tools()} calls from multiple bots / async handlers
     * cannot race the bring-up.
     */
    private synchronized void ensureStarted() {
        if (started != null) return; // already tried (success or fail)

        MCPConfig cfg = MCPConfig.INSTANCE;
        if (!cfg.enabled) {
            LOGGER.info("MCP gateway disabled via mcp_config.properties — godBot will not see Mineflayer tools.");
            started = Boolean.FALSE;
            return;
        }

        LOGGER.info("Starting MCP gateway: {}", cfg.describe());

        try {
            List<String> command = new ArrayList<>();
            command.add(cfg.nodeBinary);
            command.add(cfg.mcpServerScript);
            command.add("--host"); command.add(cfg.mcHost);
            command.add("--port"); command.add(Integer.toString(cfg.mcPort));
            command.add("--username"); command.add(cfg.mcUsername);

            McpTransport transport = new StdioMcpTransport.Builder()
                .command(command)
                .logEvents(false)
                .build();

            McpClient c = new DefaultMcpClient.Builder()
                .key("minecraft-mcp-server")
                .transport(transport)
                .build();

            List<ToolSpecification> specs = c.listTools();
            if (specs == null) specs = Collections.emptyList();

            List<String> names = new ArrayList<>(specs.size());
            for (ToolSpecification ts : specs) {
                names.add(ts.name());
            }

            this.client = c;
            this.toolSpecs = Collections.unmodifiableList(new ArrayList<>(specs));
            this.toolNames = Collections.unmodifiableList(names);
            this.started = Boolean.TRUE;

            LOGGER.info("MCP gateway up — {} tool(s) discovered: {}", specs.size(), names);
        } catch (Exception e) {
            LOGGER.error("MCP gateway start FAILED ({}): godBot will run without Mineflayer tools. " +
                "Verify {} is built and node is on PATH.", e.getMessage(), MCPConfig.INSTANCE.mcpServerScript, e);
            // Don't keep a half-built client around.
            if (client != null) {
                try { client.close(); } catch (Exception ignored) {}
                client = null;
            }
            toolNames = Collections.emptyList();
            toolSpecs = Collections.emptyList();
            started = Boolean.FALSE;
        }
    }

    /** For tests / future /mcp reload command — drop state so next tools() call retries. */
    @SuppressWarnings("unused")
    public synchronized void reset(Map<String, String> ignored) {
        shutdown();
    }
}
