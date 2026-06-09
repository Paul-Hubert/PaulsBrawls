package com.paul.brawl;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

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

    /**
     * Backoff between automatic reconnect attempts after a failed connect, in
     * milliseconds. A successful tool dispatch resets the backoff; a failed
     * dispatch tears down the client and zeros {@link #nextConnectAttemptMs}
     * so the next {@link #tools()} or {@link #execute(ToolExecutionRequest)}
     * call retries immediately. The backoff is only for the "node not up yet
     * after Java server boot" case — not the "node crashed mid-session" case.
     */
    private static final long RECONNECT_BACKOFF_MS = 30_000L;

    /** Cached tool names from the last successful list so
     *  {@link #handlesTool(String)} can answer without re-listing. Kept across
     *  disconnects so the model still sees the catalogue it was given. */
    private volatile List<String> toolNames = Collections.emptyList();

    private volatile List<ToolSpecification> toolSpecs = Collections.emptyList();

    private volatile McpClient client;

    /** True iff the last connect succeeded and we have not since observed a
     *  dispatch failure that closed the client. */
    private volatile boolean connected = false;

    /** Wall-clock millis (System.currentTimeMillis) before which we will NOT
     *  attempt another connect. Reset to 0 on tool-dispatch failure so the
     *  next call retries immediately; set to {@code now + RECONNECT_BACKOFF_MS}
     *  on connect failure so we don't hammer a down node. */
    private volatile long nextConnectAttemptMs = 0L;

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
     *
     * <p>On dispatch failure (transport error, server crashed), tears down the
     * client and clears the backoff so the next call retries the connect
     * immediately. The cached spec/name list is preserved so the model still
     * sees the tools it had — it'll just get an error string for the calls
     * that land while the gateway is down.
     */
    public String execute(ToolExecutionRequest req) {
        ensureStarted();
        if (!connected || client == null) {
            return "MCP gateway not connected — tool '" + (req == null ? "?" : req.name())
                + "' could not be dispatched. Will auto-retry; admin can force with `/mcp reload`.";
        }
        if (req == null) {
            return "MCP execute called with a null request.";
        }
        try {
            String out = client.executeTool(req);
            return out == null ? "" : out;
        } catch (Exception e) {
            LOGGER.warn("MCP tool '{}' execution failed: {}", req.name(), e.getMessage(), e);
            markDisconnected();
            return "MCP tool '" + req.name() + "' failed: " + e.getMessage()
                + " (gateway marked down; next call will retry).";
        }
    }

    /**
     * Close the HTTP transport and clear connection state. Cached spec/name
     * lists are preserved so {@link #tools()} and {@link #handlesTool} stay
     * consistent for any in-flight assistant turn. Idempotent. Safe to call
     * from {@code SERVER_STOPPING}.
     */
    public synchronized void shutdown() {
        closeClientQuietly();
        connected = false;
        nextConnectAttemptMs = 0L;
    }

    /**
     * Force a full reconnect: tear down, drop the cached spec list, retry now.
     * Wired to {@code /mcp reload} for admins.
     */
    public synchronized void reload() {
        LOGGER.info("MCP gateway: /mcp reload — tearing down and reconnecting.");
        closeClientQuietly();
        connected = false;
        nextConnectAttemptMs = 0L;
        toolNames = Collections.emptyList();
        toolSpecs = Collections.emptyList();
        ensureStarted();
    }

    /** One-line status for /mcp status and similar diagnostics. */
    public String status() {
        MCPConfig cfg = MCPConfig.INSTANCE;
        if (!cfg.enabled) return "MCP: disabled in mcp_config.properties";
        if (connected) return String.format("MCP: connected to %s, %d tool(s)", cfg.sseUrl, toolNames.size());
        long now = System.currentTimeMillis();
        long secsToRetry = Math.max(0, (nextConnectAttemptMs - now + 999) / 1000);
        return String.format("MCP: disconnected from %s (retry in %ds), %d cached tool(s)",
            cfg.sseUrl, secsToRetry, toolNames.size());
    }

    /** Internal: tear down client without resetting backoff. Used on dispatch
     *  failure (we keep nextConnectAttemptMs at 0 so the next call retries). */
    private synchronized void markDisconnected() {
        closeClientQuietly();
        connected = false;
        nextConnectAttemptMs = 0L;
    }

    private void closeClientQuietly() {
        if (client != null) {
            try {
                client.close();
            } catch (Exception e) {
                LOGGER.warn("MCP client close failed: {}", e.getMessage());
            }
            client = null;
        }
    }

    /**
     * Connect to the unified node process's SSE endpoint, retrying with backoff
     * after failures. Synchronized so concurrent {@link #tools()} calls from
     * multiple bots / async handlers cannot race the bring-up.
     *
     * <p>Three exit branches:
     * <ol>
     *   <li>{@code connected} → return immediately (steady state).</li>
     *   <li>{@code !cfg.enabled} → return; the gate is configurable, no retry needed.</li>
     *   <li>{@code now < nextConnectAttemptMs} → still in backoff after a recent
     *       failure; the gateway stays cold and tools() returns the (likely empty)
     *       cached list. The model still sees a sensible error string on dispatch.</li>
     * </ol>
     * Otherwise we attempt a connect, set the next backoff window, and on
     * success flip {@code connected} and cache the spec/name lists.
     */
    private synchronized void ensureStarted() {
        if (connected) return;

        MCPConfig cfg = MCPConfig.INSTANCE;
        if (!cfg.enabled) {
            return;
        }

        long now = System.currentTimeMillis();
        if (now < nextConnectAttemptMs) {
            return;
        }
        nextConnectAttemptMs = now + RECONNECT_BACKOFF_MS;

        LOGGER.info("MCP gateway: connecting — {}", cfg.describe());

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
            this.connected = true;

            LOGGER.info("MCP gateway up — {} tool(s) discovered: {}", specs.size(), names);
        } catch (Exception e) {
            LOGGER.warn("MCP gateway connect failed ({}); will retry in {}s. URL: {}. " +
                "Cached spec list size: {}.",
                e.getMessage(), RECONNECT_BACKOFF_MS / 1000, cfg.sseUrl, toolSpecs.size());
            closeClientQuietly();
            connected = false;
            // toolSpecs/toolNames: keep the previous cache (empty on first
            // attempt; non-empty if a previous run had succeeded). The model
            // still sees what was last visible and dispatch returns a readable
            // error until the gateway comes back.
        }
    }
}
