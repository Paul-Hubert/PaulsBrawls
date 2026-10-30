package com.paul.brawl.squad;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Properties;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Configuration of the {@code /bots} front (docs/29): where the squad runtime listens, the shared token, and how
 * {@code /bots create} and {@code /bots fix} run the {@code squad-author} agent. Persisted to
 * {@code squad.properties} in the server's working directory, like the other configs.
 */
public final class SquadConfig {

    private static final Logger LOGGER = LoggerFactory.getLogger("SquadConfig");

    public static final Path CONFIG_PATH = Path.of("squad.properties");
    /** The runtime reads the same variable; it wins over {@link #token} on both sides. */
    public static final String TOKEN_ENV = "PAULSBRAWLS_SQUAD_TOKEN";
    /** The agent's MCP config reads it ({@code squad/agent/claude-code/.mcp.json}). */
    public static final String URL_ENV = "PAULSBRAWLS_SQUAD_URL";

    public static final SquadConfig INSTANCE = new SquadConfig(CONFIG_PATH);

    private final Path path;

    /** {@code /bots} answers "désactivé" when false. */
    public boolean enabled = true;
    /** The runtime's control API, SSE stream and MCP server (loopback). */
    public String url = "http://127.0.0.1:8772";
    /** Bearer token shared with the runtime; generated and saved at first start when blank (and no env var). */
    public String token = "";

    /** {@code claude-code} (default: one headless {@code claude -p} per authoring turn) or {@code opencode}. */
    public String agentKind = "claude-code";
    public String claudeBin = "claude";
    public String claudeDir = "squad/agent/claude-code";
    public String claudeModel = "";
    public String claudeEffort = "";
    /** opencode ({@code agentKind = opencode}): a second {@code opencode serve} with squad/agent/opencode.json. */
    public String agentUrl = "http://127.0.0.1:4097";
    public String agentUsername = "opencode";
    public String agentPassword = "";
    public String authorAgentName = "squad-author";

    /** Hard cap on one authoring turn (writing, checking, up to three trial runs). */
    public int authorTimeoutSeconds = 900;
    /** Authoring turns running at once, all players together. */
    public int maxAuthoring = 2;
    /** A join under a bot's name from any other address is kicked (offline mode trusts names). */
    public boolean joinGate = true;
    public String allowedBotAddresses = "127.0.0.1,::1,0:0:0:0:0:0:0:1";

    SquadConfig(Path path) {
        this.path = path;
        load();
    }

    public synchronized String effectiveToken() {
        String env = System.getenv(TOKEN_ENV);
        if (env != null && !env.isBlank()) return env.trim();
        return token;
    }

    /** Generate and save a token if none is configured. */
    public synchronized void ensureToken() {
        if (!effectiveToken().isBlank()) return;
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        token = Base64.getUrlEncoder().withoutPadding().encodeToString(b);
        save();
        LOGGER.info("Generated a squad token in {}: export it as {} for the squad runtime (or put it in squad.json).", path, TOKEN_ENV);
    }

    public boolean opencode() {
        return "opencode".equalsIgnoreCase(agentKind);
    }

    public synchronized void save() {
        Properties p = new Properties();
        p.setProperty("enabled", Boolean.toString(enabled));
        p.setProperty("url", url);
        p.setProperty("token", token);
        p.setProperty("agentKind", agentKind);
        p.setProperty("claudeBin", claudeBin);
        p.setProperty("claudeDir", claudeDir);
        p.setProperty("claudeModel", claudeModel);
        p.setProperty("claudeEffort", claudeEffort);
        p.setProperty("agentUrl", agentUrl);
        p.setProperty("agentUsername", agentUsername);
        p.setProperty("agentPassword", agentPassword);
        p.setProperty("authorAgentName", authorAgentName);
        p.setProperty("authorTimeoutSeconds", Integer.toString(authorTimeoutSeconds));
        p.setProperty("maxAuthoring", Integer.toString(maxAuthoring));
        p.setProperty("joinGate", Boolean.toString(joinGate));
        p.setProperty("allowedBotAddresses", allowedBotAddresses);
        try (var out = Files.newOutputStream(path)) {
            p.store(out, "Squad: player-owned bots (/bots) — docs/29");
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
        enabled = Boolean.parseBoolean(p.getProperty("enabled", Boolean.toString(enabled)).trim());
        url = p.getProperty("url", url).trim();
        token = p.getProperty("token", token).trim();
        agentKind = p.getProperty("agentKind", agentKind).trim();
        claudeBin = p.getProperty("claudeBin", claudeBin).trim();
        claudeDir = p.getProperty("claudeDir", claudeDir).trim();
        claudeModel = p.getProperty("claudeModel", claudeModel).trim();
        claudeEffort = p.getProperty("claudeEffort", claudeEffort).trim();
        agentUrl = p.getProperty("agentUrl", agentUrl).trim();
        agentUsername = p.getProperty("agentUsername", agentUsername).trim();
        agentPassword = p.getProperty("agentPassword", agentPassword);
        authorAgentName = p.getProperty("authorAgentName", authorAgentName).trim();
        authorTimeoutSeconds = parseInt(p.getProperty("authorTimeoutSeconds"), authorTimeoutSeconds);
        maxAuthoring = parseInt(p.getProperty("maxAuthoring"), maxAuthoring);
        joinGate = Boolean.parseBoolean(p.getProperty("joinGate", Boolean.toString(joinGate)).trim());
        allowedBotAddresses = p.getProperty("allowedBotAddresses", allowedBotAddresses).trim();
    }

    public String describe() {
        return "SquadConfig{enabled=" + enabled + ", url=" + url + ", token=" + (effectiveToken().isBlank() ? "unset" : "set")
            + ", agent=" + agentKind + (opencode() ? " " + agentUrl : " " + claudeBin + " in " + claudeDir)
            + ", authorTimeout=" + authorTimeoutSeconds + "s, maxAuthoring=" + maxAuthoring + ", joinGate=" + joinGate + "}";
    }

    private static int parseInt(String s, int fallback) {
        if (s == null) return fallback;
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
