package com.paul.brawl;

import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Runtime of the {@code godAgent = external} mode (docs/27): the ticket book, the sub-build leases, the loopback
 * MCP servers and the {@link AgentTurns} that hand prayers and builds to the external agent (opencode or Claude
 * Code, {@code agentKind}). Started on
 * {@code SERVER_STARTED} and stopped on {@code SERVER_STOPPING}; with {@code builtin} it starts nothing and
 * {@link #enabled()} is false, so every caller keeps the in-mod ChatBot path.
 */
public final class ExternalAgent {

    private static final Logger LOGGER = LoggerFactory.getLogger("ExternalAgent");

    static final AgentTickets TICKETS = new AgentTickets();
    private static volatile SubBuilds subBuilds;
    private static volatile AutoCloseable sweeper;
    private static volatile AgentMcpServers servers;
    private static volatile AgentTurns turns;
    private static boolean listening;

    private ExternalAgent() {}

    /** The switch of docs/26 §1. Read live, so a config change takes effect at the next server start. */
    public static boolean enabled() {
        return GodAgentConfig.INSTANCE.external();
    }

    public static synchronized void start() {
        GodAgentConfig cfg = GodAgentConfig.INSTANCE;
        LOGGER.info("{}", cfg.describe());
        if (!cfg.external() || servers != null) return;
        cfg.ensureToken();
        long idle = cfg.subBuildIdleSeconds * 1000L;
        subBuilds = new SubBuilds(System::currentTimeMillis, idle);
        sweeper = subBuilds.startSweeper(SubBuilds.sweepPeriodMillis(idle));
        try {
            servers = AgentMcpServers.start(cfg.mcpPort, cfg::effectiveToken, GodService.live(), new GatewayBodyTools(),
                () -> BridgeConfig.INSTANCE.enabled, BuildService.live(), TICKETS, subBuilds);
        } catch (Exception e) {
            LOGGER.warn("MCP servers failed to bind 127.0.0.1:{} — the external God agent cannot act: {}", cfg.mcpPort, e.toString());
            servers = null;
        }
        turns = new AgentTurns(backend(cfg), GodService.live(), BuildService.live(), TICKETS, subBuilds, cfg);
        if (!listening) {
            GodSessionManager.addEndListener(former -> {
                AgentTurns t = turns;
                if (t != null) t.onSessionEnded(former);
            });
            listening = true;
        }
    }

    /** opencode over HTTP, or Claude Code headless with the MCP token and URL in its environment. */
    static AgentBackend backend(GodAgentConfig cfg) {
        if (cfg.claudeCode()) {
            return new ClaudeCodeClient(cfg.claudeBin, java.nio.file.Path.of(cfg.claudeDir), cfg.claudeModel, cfg.claudeEffort,
                java.util.Map.of(GodAgentConfig.TOKEN_ENV, cfg.effectiveToken(),
                    ClaudeCodeClient.MCP_URL_ENV, "http://127.0.0.1:" + cfg.mcpPort));
        }
        return new AgentClient(cfg.agentUrl, cfg.agentUsername, cfg.effectiveAgentPassword());
    }

    public static synchronized void stop() {
        if (turns != null) turns.abortBuilds();
        turns = null;
        if (servers != null) {
            servers.close();
            servers = null;
        }
        if (sweeper != null) {
            try {
                sweeper.close();
            } catch (Exception ignored) {
                // a daemon thread; shutdownNow does not throw
            }
            sweeper = null;
        }
        if (subBuilds != null) subBuilds.endAll(null);
        TICKETS.revoke(null, AgentTickets.Kind.GOD);
        TICKETS.revoke(null, AgentTickets.Kind.BUILDER);
    }

    public static boolean running() {
        return servers != null && turns != null;
    }

    /** {@code /pray <text>} or {@code /prove} (image) in external mode. */
    public static void pray(UUID player, String name, String text, byte[] image) {
        AgentTurns t = turns;
        if (t == null || servers == null) {
            GodService.live().world().tell(player, AgentTurns.DOWN);
            return;
        }
        t.pray(player, name, text, image);
    }

    /** {@code /build} in external mode. */
    public static void build(UUID player, String name, String text, byte[] image) {
        AgentTurns t = turns;
        if (t == null || servers == null) {
            GodService.live().world().tell(player, AgentTurns.DOWN);
            return;
        }
        t.build(player, name, text, image);
    }

    /** {@code /pray reset}: the player's next prayer starts a fresh agent conversation. */
    public static void resetGod(UUID player) {
        AgentTurns t = turns;
        if (t != null) t.resetGod(player);
    }

    /** {@code /construction}: a new site starts a fresh builder conversation. */
    public static void resetBuild(UUID player) {
        AgentTurns t = turns;
        if (t != null) t.resetBuild(player);
    }

    /** {@code /godbody off}: stop every running build turn and kill every builder ticket. */
    public static void abortBuilds() {
        AgentTurns t = turns;
        if (t != null) t.abortBuilds();
    }

    static final String NOT_RUNNING = "Les serveurs MCP ne tournent pas : mets godAgent=external dans "
        + "god_agent.properties et redémarre le serveur.";

    /** {@code /construction ticket [minutes]}; null turns = external mode off or the servers failed to bind. */
    public static AgentTurns.ManualTicket mintManualBuilderTicket(UUID player, Integer minutes) {
        AgentTurns t = turns;
        if (t == null || servers == null) return new AgentTurns.ManualTicket(null, 0, null, NOT_RUNNING);
        return t.mintManualBuilderTicket(player, minutes);
    }

    /** {@code /construction ticket revoke}; -1 when external mode is off. */
    public static int revokeBuilderTickets(UUID player) {
        AgentTurns t = turns;
        return t == null ? -1 : t.revokeBuilderTickets(player);
    }

    /** The builder endpoint as an MCP client on this machine reaches it. */
    public static String builderUrl() {
        return "http://127.0.0.1:" + GodAgentConfig.INSTANCE.mcpPort + AgentMcpServers.BUILDER_PATH;
    }
}
