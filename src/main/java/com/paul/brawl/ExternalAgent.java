package com.paul.brawl;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Runtime of the {@code godAgent = external} mode (docs/27): the ticket book, the sub-build leases and the loopback
 * MCP servers. Started on {@code SERVER_STARTED} and stopped on {@code SERVER_STOPPING}; with {@code builtin} it
 * starts nothing.
 */
public final class ExternalAgent {

    private static final Logger LOGGER = LoggerFactory.getLogger("ExternalAgent");

    static final AgentTickets TICKETS = new AgentTickets();
    private static volatile SubBuilds subBuilds;
    private static volatile AgentMcpServers servers;

    private ExternalAgent() {}

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
            servers = AgentMcpServers.start(cfg.mcpPort, cfg::effectiveToken, BuildService.live(), TICKETS, subBuilds);
        } catch (Exception e) {
            LOGGER.warn("MCP servers failed to bind 127.0.0.1:{} — the external God agent cannot act: {}", cfg.mcpPort, e.toString());
            servers = null;
        }
    }

    public static synchronized void stop() {
        if (servers != null) {
            servers.close();
            servers = null;
        }
        if (subBuilds != null) subBuilds.endAll(null);
        TICKETS.revoke(null, AgentTickets.Kind.GOD);
        TICKETS.revoke(null, AgentTickets.Kind.BUILDER);
    }

    public static boolean running() {
        return servers != null;
    }
}
