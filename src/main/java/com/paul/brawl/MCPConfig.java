package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Singleton config for the minecraft-mcp-server subprocess that {@link MCPGateway}
 * spawns to expose Mineflayer-driven world-manipulation tools to {@code godBot}.
 *
 * <p>Persisted as a sibling to {@link LLMConfig}'s file ({@code mcp_config.properties}
 * in the server working directory). Editable while the server is offline. Missing
 * keys fall back to the defaults below — first launch writes a populated file so
 * the user has something to edit.</p>
 *
 * <p>Keys:</p>
 * <ul>
 *   <li>{@code enabled} — gate the whole integration. When {@code false}, godBot
 *       gets its usual tool set and {@link MCPGateway} stays cold.</li>
 *   <li>{@code node_binary} — executable used to run the MCP server script.
 *       Defaults to {@code node} (resolved against {@code PATH}).</li>
 *   <li>{@code mcp_server_script} — absolute or working-directory-relative path
 *       to the compiled MCP server entry point ({@code dist/main.js}). The
 *       project's sibling repo lives at {@code ./minecraft-mcp-server}, so that
 *       relative path is the default.</li>
 *   <li>{@code mc_host} / {@code mc_port} / {@code mc_username} — connection
 *       params the MCP server passes to Mineflayer. Defaults match the dev
 *       {@code runServer} setup.</li>
 * </ul>
 */
public class MCPConfig {

    private static final Logger LOGGER = LoggerFactory.getLogger("MCPConfig");

    public static final Path CONFIG_PATH = Path.of("mcp_config.properties");

    public static final MCPConfig INSTANCE = new MCPConfig();

    public boolean enabled = true;
    public String nodeBinary = "node";
    public String mcpServerScript = "./minecraft-mcp-server/dist/main.js";
    public String mcHost = "localhost";
    public int mcPort = 25565;
    public String mcUsername = "GodBot";

    private MCPConfig() {
        load();
    }

    public synchronized void save() {
        Properties props = new Properties();
        props.setProperty("enabled", Boolean.toString(enabled));
        props.setProperty("node_binary", nodeBinary);
        props.setProperty("mcp_server_script", mcpServerScript);
        props.setProperty("mc_host", mcHost);
        props.setProperty("mc_port", Integer.toString(mcPort));
        props.setProperty("mc_username", mcUsername);
        try (var out = Files.newOutputStream(CONFIG_PATH)) {
            props.store(out, "minecraft-mcp-server bridge configuration");
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
        String nb = props.getProperty("node_binary");
        if (nb != null && !nb.isBlank()) nodeBinary = nb;
        String script = props.getProperty("mcp_server_script");
        if (script != null && !script.isBlank()) mcpServerScript = script;
        String host = props.getProperty("mc_host");
        if (host != null && !host.isBlank()) mcHost = host;
        String port = props.getProperty("mc_port");
        if (port != null) {
            try { mcPort = Integer.parseInt(port); } catch (NumberFormatException ignored) {}
        }
        String user = props.getProperty("mc_username");
        if (user != null && !user.isBlank()) mcUsername = user;
    }

    /** Compact one-liner for logs. */
    public String describe() {
        return String.format("enabled=%s, node=%s, script=%s, mc=%s:%d as %s",
            enabled, nodeBinary, mcpServerScript, mcHost, mcPort, mcUsername);
    }
}
