package com.paul.brawl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Properties;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Configuration of the external God agent and the mod's MCP servers (docs/27). Persisted to
 * {@code god_agent.properties} in the server's working directory, like the other configs.
 *
 * <p>{@link #godAgent} is the switch of docs/26 §1: {@code builtin} (default) keeps today's in-mod ChatBot;
 * {@code external} starts the {@code god}/{@code builder} MCP servers and hands {@code /pray}, {@code /prove} and
 * {@code /build} to opencode.
 */
public class GodAgentConfig {

    private static final Logger LOGGER = LoggerFactory.getLogger("GodAgentConfig");

    public static final Path CONFIG_PATH = Path.of("god_agent.properties");

    /** Env var that overrides {@link #mcpToken} (so it can stay out of the properties file). */
    public static final String TOKEN_ENV = "PAULSBRAWLS_MCP_TOKEN";
    /** opencode's own variable for its server password (Basic auth). */
    public static final String AGENT_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";

    public static final String BUILTIN = "builtin";
    public static final String EXTERNAL = "external";

    public static final GodAgentConfig INSTANCE = new GodAgentConfig(CONFIG_PATH);

    private final Path path;

    /** {@code builtin} or {@code external}. */
    public String godAgent = BUILTIN;

    /** Loopback port of the god/builder MCP servers ({@code /mcp/god}, {@code /mcp/builder}). */
    public int mcpPort = 8771;

    /** Bearer token every MCP request must carry. Generated and saved at first start if blank (and no env var). */
    public String mcpToken = "";

    /** opencode server ({@code opencode serve}). */
    public String agentUrl = "http://127.0.0.1:4096";
    public String agentUsername = "opencode";
    /** opencode Basic-auth password; {@value #AGENT_PASSWORD_ENV} wins when set. Blank = no auth header. */
    public String agentPassword = "";

    /** opencode agent names (see god-agent/opencode.json). */
    public String godAgentName = "god";
    public String builderAgentName = "builder";

    /** Hard cap on one agent turn (one POST /session/:id/message). */
    public int turnTimeoutSeconds = 300;

    /** A ticket handed to the agent dies after this long even if its session is still open. */
    public int ticketTtlSeconds = 1800;

    /** A sub-build slot with no builder call for this long is released (a dead agent cannot hold the 4 slots). */
    public int subBuildIdleSeconds = 120;

    GodAgentConfig(Path path) {
        this.path = path;
        load();
    }

    public boolean external() {
        return EXTERNAL.equalsIgnoreCase(godAgent);
    }

    /** The token in force: the env var if set, else the saved one. */
    public synchronized String effectiveToken() {
        String env = System.getenv(TOKEN_ENV);
        if (env != null && !env.isBlank()) return env.trim();
        return mcpToken;
    }

    /** Generate and save a token if none is configured (docs/27 §2: these servers can strike players). */
    public synchronized void ensureToken() {
        if (!effectiveToken().isBlank()) return;
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        mcpToken = Base64.getUrlEncoder().withoutPadding().encodeToString(b);
        save();
        LOGGER.info("Generated a new MCP token in {} — give it to the agent as {}.", path, TOKEN_ENV);
    }

    public synchronized String effectiveAgentPassword() {
        String env = System.getenv(AGENT_PASSWORD_ENV);
        if (env != null && !env.isBlank()) return env;
        return agentPassword;
    }

    public synchronized void save() {
        Properties p = new Properties();
        p.setProperty("godAgent", godAgent);
        p.setProperty("mcpPort", Integer.toString(mcpPort));
        p.setProperty("mcpToken", mcpToken);
        p.setProperty("agentUrl", agentUrl);
        p.setProperty("agentUsername", agentUsername);
        p.setProperty("agentPassword", agentPassword);
        p.setProperty("godAgentName", godAgentName);
        p.setProperty("builderAgentName", builderAgentName);
        p.setProperty("turnTimeoutSeconds", Integer.toString(turnTimeoutSeconds));
        p.setProperty("ticketTtlSeconds", Integer.toString(ticketTtlSeconds));
        p.setProperty("subBuildIdleSeconds", Integer.toString(subBuildIdleSeconds));
        try (var out = Files.newOutputStream(path)) {
            p.store(out, "External God agent (opencode) + god/builder MCP servers — docs/27");
        } catch (IOException e) {
            LOGGER.warn("Failed to save {}: {}", path, e.getMessage());
        }
    }

    public synchronized void load() {
        if (!Files.exists(path)) return;
        Properties p = new Properties();
        try (var in = Files.newInputStream(path)) {
            p.load(in);
        } catch (IOException e) {
            LOGGER.warn("Failed to load {}: {}", path, e.getMessage());
            return;
        }
        godAgent = p.getProperty("godAgent", godAgent).trim();
        mcpPort = parseInt(p.getProperty("mcpPort"), mcpPort);
        mcpToken = p.getProperty("mcpToken", mcpToken).trim();
        agentUrl = p.getProperty("agentUrl", agentUrl).trim();
        agentUsername = p.getProperty("agentUsername", agentUsername).trim();
        agentPassword = p.getProperty("agentPassword", agentPassword);
        godAgentName = p.getProperty("godAgentName", godAgentName).trim();
        builderAgentName = p.getProperty("builderAgentName", builderAgentName).trim();
        turnTimeoutSeconds = parseInt(p.getProperty("turnTimeoutSeconds"), turnTimeoutSeconds);
        ticketTtlSeconds = parseInt(p.getProperty("ticketTtlSeconds"), ticketTtlSeconds);
        subBuildIdleSeconds = parseInt(p.getProperty("subBuildIdleSeconds"), subBuildIdleSeconds);
    }

    public String describe() {
        return "GodAgentConfig{godAgent=" + godAgent + ", mcpPort=" + mcpPort
            + ", mcpToken=" + (effectiveToken().isBlank() ? "unset" : "set")
            + ", agentUrl=" + agentUrl + ", agents=" + godAgentName + "/" + builderAgentName
            + ", turnTimeout=" + turnTimeoutSeconds + "s}";
    }

    private static int parseInt(String s, int fallback) {
        if (s == null) return fallback;
        try { return Integer.parseInt(s.trim()); }
        catch (NumberFormatException e) { return fallback; }
    }
}
