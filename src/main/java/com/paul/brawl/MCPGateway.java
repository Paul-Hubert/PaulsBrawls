package com.paul.brawl;

import java.time.Duration;
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
import dev.langchain4j.mcp.client.transport.http.HttpMcpTransport;

/**
 * Lazy singleton that connects to the unified node process's MCP SSE endpoint
 * and exposes its Mineflayer-driven tools to {@link ChatBot}.
 *
 * <p>Lifecycle: cold until the first {@link #tools()} call. The transport is
 * an HTTP+SSE client ({@link HttpMcpTransport}) pointing at
 * {@link MCPConfig#sseUrl} — the same node process that serves the bridge HTTP
 * surface. We do <strong>not</strong> spawn a subprocess; that was the
 * previous design and caused a duplicate Mineflayer login (one bot for the
 * bridge, one for the MCP subprocess).</p>
 *
 * <p>Failure mode: if {@link MCPConfig#enabled} is false, or the node process
 * is unreachable, or {@code listTools()} throws, {@link #tools()} returns an
 * empty list and the gateway stays disabled. The error is logged loudly but
 * does <strong>not</strong> break the rest of {@code godBot} — only the
 * MCP-sourced tools go missing for the rest of the run.</p>
 *
 * <p>Dispatch contract: {@link #execute(ToolExecutionRequest)} either returns
 * the MCP server's stringified tool result, or — if the gateway is not
 * initialised / the call failed / the name is unknown — returns a
 * human-readable error string (it does <strong>not</strong> throw). This is so
 * {@link ChatBotFunctions} can forward the result to the model as a normal
 * tool-output message without special-casing failures.</p>
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
     * Returns the MCP-sourced tool specs. First call connects to the unified
     * node process; later calls return the cached list. Empty list on
     * disabled / failed startup.
     */
    public List<ToolSpecification> tools() {
        ensureStarted();
        return toolSpecs;
    }

    /**
     * True iff the gateway has the given tool name in its MCP catalogue. Used
     * by {@link ChatBotFunctions#executeFunction} to decide whether to forward
     * an unknown tool call to MCP rather than throwing.
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
     * Close the HTTP transport and reset state. Idempotent. Safe to call from
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
     * Connect to the unified node process's SSE endpoint on first call.
     * Synchronized so concurrent {@link #tools()} calls from multiple bots /
     * async handlers cannot race the bring-up.
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
            McpTransport transport = new HttpMcpTransport.Builder()
                .sseUrl(cfg.sseUrl)
                .timeout(Duration.ofSeconds(cfg.timeoutSeconds))
                .logRequests(false)
                .logResponses(false)
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
                "Verify the unified node process is running and reachable at {}.",
                e.getMessage(), MCPConfig.INSTANCE.sseUrl, e);
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
