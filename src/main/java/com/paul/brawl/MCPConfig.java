package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Singleton config for the MCP HTTP/SSE transport that {@link MCPGateway} uses
 * to consume Mineflayer-driven tools from the unified node process.
 *
 * <p>Persisted as {@code mcp_config.properties} in the server working directory,
 * editable while the server is offline. Missing keys fall back to the defaults
 * below — first launch writes a populated file so the user has something to
 * edit.</p>
 *
 * <p>Historic note: an earlier revision spawned a Node subprocess via
 * {@link dev.langchain4j.mcp.client.transport.stdio.StdioMcpTransport StdioMcpTransport}
 * and required {@code node_binary}, {@code mcp_server_script}, {@code mc_host},
 * {@code mc_port}, {@code mc_username} keys. These are now obsolete — the unified
 * node process logs in as {@code BridgeConfig.botUsername} and serves both the
 * bridge HTTP and the MCP SSE on one port. {@link #load()} drops stale keys with
 * a one-line warning and rewrites the file on the next save.</p>
 *
 * <p>Keys (current):</p>
 * <ul>
 *   <li>{@code enabled} — gate the integration. When {@code false}, godBot gets
 *       its usual Java tool set and {@link MCPGateway} stays cold.</li>
 *   <li>{@code sse_url} — full URL of the unified node process's SSE endpoint.
 *       The default matches {@code BridgeConfig.bridgeUrl}'s default plus
 *       {@code /mcp/sse}. The langchain4j {@code HttpMcpTransport} discovers
 *       the matching POST endpoint via the SSE handshake.</li>
 *   <li>{@code timeout_seconds} — per-call timeout for the langchain4j HTTP
 *       transport. Defaults to 60 s.</li>
 * </ul>
 */
public class MCPConfig {

    private static final Logger LOGGER = LoggerFactory.getLogger("MCPConfig");

    public static final Path CONFIG_PATH = Path.of("mcp_config.properties");

    /** Stale keys we silently drop on load. Kept here so the migration log line
     *  can name what was discarded.
     *  <p>MUST be declared before {@link #INSTANCE} — the singleton constructor
     *  calls {@link #load()} which reads this field, and Java initialises static
     *  fields in declaration order. Putting INSTANCE first hits an NPE here. */
    private static final List<String> OBSOLETE_KEYS = List.of(
        "node_binary", "mcp_server_script", "mc_host", "mc_port", "mc_username"
    );

    public static final MCPConfig INSTANCE = new MCPConfig();

    public boolean enabled = true;
    public String sseUrl = "http://127.0.0.1:8765/mcp/sse";
    public int timeoutSeconds = 60;

    private MCPConfig() {
        load();
    }

    public synchronized void save() {
        Properties props = new Properties();
        props.setProperty("enabled", Boolean.toString(enabled));
        props.setProperty("sse_url", sseUrl);
        props.setProperty("timeout_seconds", Integer.toString(timeoutSeconds));
        try (var out = Files.newOutputStream(CONFIG_PATH)) {
            props.store(out, "MCP HTTP/SSE transport configuration");
        } catch (IOException e) {
            LOGGER.warn("Failed to save MCP config: {}", e.getMessage());
        }
    }

    public synchronized void load() {
        if (!Files.exists(CONFIG_PATH)) {
            // First boot: persist the defaults so the user has a populated file
            // to edit. Don't fail if the working dir is read-only — silently
            // keep in-memory defaults.
            try {
                save();
            } catch (Exception ignored) {
                // already logged inside save()
            }
            return;
        }
        Properties props = new Properties();
        try (var in = Files.newInputStream(CONFIG_PATH)) {
            props.load(in);
        } catch (IOException e) {
            LOGGER.warn("Failed to load MCP config: {}", e.getMessage());
            return;
        }
        String en = props.getProperty("enabled");
        if (en != null) enabled = Boolean.parseBoolean(en);
        String url = props.getProperty("sse_url");
        if (url != null && !url.isBlank()) sseUrl = url;
        String t = props.getProperty("timeout_seconds");
        if (t != null) {
            try { timeoutSeconds = Integer.parseInt(t); } catch (NumberFormatException ignored) {}
        }

        // One-shot migration: detect stale subprocess-mode keys, drop them with
        // a single warning, and rewrite the file without them so subsequent
        // boots are quiet. The unified node process replaces the subprocess
        // path; sseUrl/timeoutSeconds are the new knobs.
        List<String> found = new ArrayList<>();
        for (String key : OBSOLETE_KEYS) {
            if (props.containsKey(key)) found.add(key);
        }
        if (!found.isEmpty()) {
            LOGGER.warn("Migrating mcp_config.properties: dropping obsolete subprocess-mode keys {}. " +
                "The MCP transport is now HTTP/SSE — set sse_url (default {}) to point at the unified " +
                "node process. Rewriting file without the old keys.", found, sseUrl);
            save();
        }
    }

    /** Compact one-liner for logs. */
    public String describe() {
        return String.format("enabled=%s, sseUrl=%s, timeoutSeconds=%d",
            enabled, sseUrl, timeoutSeconds);
    }
}
