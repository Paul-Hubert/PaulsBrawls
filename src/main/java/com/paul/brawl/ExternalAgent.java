package com.paul.brawl;

import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Runtime of the {@code godAgent = external} mode (docs/27): the ticket book, the sub-build leases, the loopback
 * MCP servers and the {@link AgentTurns} that hand prayers and builds to opencode. Started on
 * {@code SERVER_STARTED} and stopped on {@code SERVER_STOPPING}; with {@code builtin} it starts nothing and
 * {@link #enabled()} is false, so every caller keeps the in-mod ChatBot path.
 */
public final class ExternalAgent {

    private static final Logger LOGGER = LoggerFactory.getLogger("ExternalAgent");

    static final AgentTickets TICKETS = new AgentTickets();
    private static volatile SubBuilds subBuilds;
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
        subBuilds = new SubBuilds(System::currentTimeMillis, cfg.subBuildIdleSeconds * 1000L);
        try {
            servers = AgentMcpServers.start(cfg.mcpPort, cfg::effectiveToken, GodService.live(), new GatewayBodyTools(),
                () -> BridgeConfig.INSTANCE.enabled, BuildService.live(), TICKETS, subBuilds);
        } catch (Exception e) {
            LOGGER.warn("MCP servers failed to bind 127.0.0.1:{} — the external God agent cannot act: {}", cfg.mcpPort, e.toString());
            servers = null;
        }
        AgentClient client = new AgentClient(cfg.agentUrl, cfg.agentUsername, cfg.effectiveAgentPassword());
        turns = new AgentTurns(client, GodService.live(), BuildService.live(), TICKETS, subBuilds, cfg);
        if (!listening) {
            GodSessionManager.addEndListener(former -> {
                AgentTurns t = turns;
                if (t != null) t.onSessionEnded(former);
            });
            listening = true;
        }
    }

    public static synchronized void stop() {
        if (turns != null) turns.abortBuilds();
        turns = null;
        if (servers != null) {
            servers.close();
            servers = null;
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

    /** {@code /godbody off}: stop every running build turn. */
    public static void abortBuilds() {
        AgentTurns t = turns;
        if (t != null) t.abortBuilds();
    }
}
