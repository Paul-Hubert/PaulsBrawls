package com.paul.brawl;

import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The trigger path of {@code godAgent = external} (docs/27 §6): a prayer or a build becomes ONE agent turn.
 *
 * <ul>
 *   <li><b>Prayer</b> ({@code /pray}, {@code /prove}): claim the avatar (busy → a French refusal, the agent is never
 *       called, so the second player cannot reach a {@code god} tool), mint a god ticket, send the prayer to the
 *       {@code god} agent in the player's own opencode session, wait for the turn. If the turn never spoke through
 *       {@code say}, its final text is said instead. Then the encounter ends (vanish + release), as the builtin
 *       ChatBot ends it when the model stops calling tools.</li>
 *   <li><b>Build</b> ({@code /build}): needs the sender's {@code /construction} pivot; mints a builder ticket, sends
 *       the request and the screenshot to the {@code builder} agent, and when the turn ends closes the player's
 *       sub-build leases.</li>
 *   <li><b>Failures</b> — agent down, timing out or erroring — end in a French message and a closed session, never
 *       a hang or a stuck avatar. A session ended from the mod side (idle watchdog, {@code /pray stop},
 *       {@code /godbody off}) revokes the ticket and aborts the agent's run.</li>
 * </ul>
 *
 * Minecraft-free: players are UUIDs, messages go through {@link GodWorld#tell}. One turn per player and kind at a
 * time; turns run on virtual threads.
 */
public final class AgentTurns {

    private static final Logger LOGGER = LoggerFactory.getLogger("AgentTurns");

    static final String BUSY = "Dieu : (occupé avec un autre fidèle — reviens plus tard.)";
    static final String STILL_THINKING = "Dieu : (Dieu médite encore ta dernière prière.)";
    static final String DOWN = "Dieu : (le lien avec l'au-delà est rompu — réessaie plus tard.)";
    static final String TIMEOUT = "Dieu : (Dieu s'est perdu dans ses pensées — réessaie plus tard.)";
    static final String ERROR = "Dieu : (Dieu reste muet — l'oracle a échoué.)";
    static final String ENDED = "Dieu : (la rencontre s'est achevée.)";
    static final String BUILD_BUSY = "Dieu : (une construction est déjà en cours pour toi.)";
    static final String NO_PIVOT = "Dieu : (aucun point de référence : lance /construction avant /build.)";

    /** An in-flight turn: the agent session it runs in (null until created) and its ticket. */
    private record Turn(String sessionId, String ticketId) {}

    private final AgentClient client;
    private final GodService god;
    private final BuildService build;
    private final AgentTickets tickets;
    private final SubBuilds subBuilds;
    private final GodAgentConfig cfg;

    private final Map<UUID, Turn> godTurns = new ConcurrentHashMap<>();
    private final Map<UUID, Turn> buildTurns = new ConcurrentHashMap<>();
    /** One opencode session per player and agent: the agent keeps the conversation (its memory). */
    private final Map<UUID, String> godSessions = new ConcurrentHashMap<>();
    private final Map<UUID, String> buildSessions = new ConcurrentHashMap<>();

    public AgentTurns(AgentClient client, GodService god, BuildService build, AgentTickets tickets, SubBuilds subBuilds,
            GodAgentConfig cfg) {
        this.client = client;
        this.god = god;
        this.build = build;
        this.tickets = tickets;
        this.subBuilds = subBuilds;
        this.cfg = cfg;
    }

    // -- prayers ---------------------------------------------------------------------------------------------------

    /**
     * {@code /pray} or {@code /prove} (with {@code image}). Returns the thread running the turn, or null when it was
     * refused on the spot.
     */
    public Thread pray(UUID player, String name, String text, byte[] image) {
        if (godTurns.containsKey(player)) {
            tell(player, STILL_THINKING);
            return null;
        }
        if (!GodSessionManager.claim(player)) {
            tell(player, BUSY);
            return null;
        }
        AgentTickets.Ticket t = tickets.mint(AgentTickets.Kind.GOD, player, GodSessionManager.generation(),
            cfg.ticketTtlSeconds * 1000L);
        if (godTurns.putIfAbsent(player, new Turn(null, t.id())) != null) {
            tickets.revoke(t.id());
            tell(player, STILL_THINKING);
            return null;
        }
        String prompt = prayerPrompt(name, t.id(), text, image != null && image.length > 0);
        return Thread.ofVirtual().name("god-turn-" + name).start(() -> runPrayer(player, name, t, prompt, image));
    }

    private void runPrayer(UUID player, String name, AgentTickets.Ticket t, String prompt, byte[] image) {
        AgentClient.Reply reply;
        String sid = null;
        try {
            sid = session(godSessions, player, "Prière — " + name);
            godTurns.computeIfPresent(player, (k, v) -> v.ticketId().equals(t.id()) ? new Turn(sid(k), t.id()) : v);
            reply = client.send(sid, cfg.godAgentName, prompt, image, Duration.ofSeconds(cfg.turnTimeoutSeconds));
        } catch (AgentClient.AgentException e) {
            reply = new AgentClient.Reply("", e.failure, e.getMessage());
        }
        boolean stillMine = GodSessionManager.isOwner(player) && GodSessionManager.generation() == t.generation();
        boolean spoke = tickets.takeSaid(t.id());
        tickets.revoke(t.id());
        godTurns.remove(player);
        if (!reply.ok()) {
            LOGGER.warn("God agent turn for {} failed ({}): {}", name, reply.failure(), reply.detail());
            if (reply.failure() == AgentClient.Failure.TIMEOUT && sid != null) client.abort(sid);
            if (reply.failure() != AgentClient.Failure.TIMEOUT) godSessions.remove(player); // start clean next time
            tell(player, stillMine ? failureMessage(reply.failure()) : ENDED);
        } else if (stillMine && !spoke && !reply.text().isBlank()) {
            god.say(player, reply.text());
        } else if (!stillMine && !spoke) {
            tell(player, ENDED);
        }
        if (stillMine) god.endSession(player);
    }

    private String sid(UUID player) {
        return godSessions.get(player);
    }

    static String prayerPrompt(String name, String ticket, String text, boolean withImage) {
        boolean body = BridgeConfig.INSTANCE.enabled;
        return "[Prière de " + name + "]\n"
            + "Ticket de séance : " + ticket + "\n"
            + "Ton corps : " + (body ? "disponible (appear pour te manifester)." : "désactivé par un administrateur — réponds sans apparaître.") + "\n"
            + (withImage ? "Une image est jointe : la preuve envoyée par le joueur avec /prove.\n" : "")
            + name + " dit : " + text;
    }

    // -- builds ----------------------------------------------------------------------------------------------------

    /** {@code /build} (client screenshot + text). Returns the thread running the turn, or null when refused. */
    public Thread build(UUID player, String name, String text, byte[] image) {
        int[] origin = build.origin(player);
        if (origin == null) {
            tell(player, NO_PIVOT);
            return null;
        }
        long ttl = Math.max(cfg.ticketTtlSeconds, cfg.buildTurnTimeoutSeconds) * 1000L;
        AgentTickets.Ticket t = tickets.mint(AgentTickets.Kind.BUILDER, player, 0, ttl);
        if (buildTurns.putIfAbsent(player, new Turn(null, t.id())) != null) {
            tickets.revoke(t.id());
            tell(player, BUILD_BUSY);
            return null;
        }
        String prompt = "[Construction demandée par " + name + "]\n"
            + "Ticket de construction : " + t.id() + "\n"
            + "Pivot /construction (absolu) : x=" + origin[0] + " y=" + origin[1] + " z=" + origin[2] + "\n"
            + (image != null && image.length > 0 ? "Une capture d'écran du site est jointe.\n" : "")
            + "Demande : " + text;
        return Thread.ofVirtual().name("build-turn-" + name).start(() -> runBuild(player, name, t, prompt, image));
    }

    private void runBuild(UUID player, String name, AgentTickets.Ticket t, String prompt, byte[] image) {
        AgentClient.Reply reply;
        String sid = null;
        try {
            sid = session(buildSessions, player, "Construction — " + name);
            final String s = sid;
            buildTurns.computeIfPresent(player, (k, v) -> v.ticketId().equals(t.id()) ? new Turn(s, t.id()) : v);
            reply = client.send(sid, cfg.builderAgentName, prompt, image, Duration.ofSeconds(cfg.buildTurnTimeoutSeconds));
        } catch (AgentClient.AgentException e) {
            reply = new AgentClient.Reply("", e.failure, e.getMessage());
        }
        boolean live = tickets.resolve(t.id(), AgentTickets.Kind.BUILDER) != null; // false once aborted
        tickets.revoke(t.id());
        subBuilds.endAll(player);
        buildTurns.remove(player);
        if (!reply.ok()) {
            LOGGER.warn("Builder agent turn for {} failed ({}): {}", name, reply.failure(), reply.detail());
            if (reply.failure() == AgentClient.Failure.TIMEOUT && sid != null) client.abort(sid);
            if (reply.failure() != AgentClient.Failure.TIMEOUT) buildSessions.remove(player);
            tell(player, live ? failureMessage(reply.failure()) : "Dieu : (construction arrêtée.)");
        } else if (!reply.text().isBlank()) {
            tell(player, "Dieu : " + reply.text());
        }
    }

    // -- ends from the mod side ----------------------------------------------------------------------------------

    /**
     * A session ended (watchdog, {@code /pray stop}, {@code /godbody off}): its ticket dies and the agent's run is
     * aborted. Registered with {@link GodSessionManager#addEndListener}. A turn ending naturally has already left
     * {@link #godTurns}, so this is a no-op for it.
     */
    public void onSessionEnded(UUID former) {
        if (former == null) return;
        Turn turn = godTurns.get(former);
        if (turn == null) return;
        tickets.revoke(turn.ticketId());
        String sid = turn.sessionId() != null ? turn.sessionId() : godSessions.get(former);
        if (sid != null) Thread.ofVirtual().start(() -> client.abort(sid));
    }

    /** {@code /godbody off}: stop every build turn (sub-build leases die through BuildGuard's epoch). */
    public void abortBuilds() {
        for (Map.Entry<UUID, Turn> e : buildTurns.entrySet()) {
            tickets.revoke(e.getValue().ticketId());
            String sid = e.getValue().sessionId();
            if (sid != null) Thread.ofVirtual().start(() -> client.abort(sid));
        }
    }

    /** Forget the player's agent conversation (its next prayer starts a fresh session). */
    public void resetGod(UUID player) {
        godSessions.remove(player);
    }

    /** Forget the player's builder conversation ({@code /construction} sets a new site). */
    public void resetBuild(UUID player) {
        buildSessions.remove(player);
    }

    public boolean praying(UUID player) {
        return godTurns.containsKey(player);
    }

    // -- helpers ---------------------------------------------------------------------------------------------------

    private String session(Map<UUID, String> sessions, UUID player, String title) throws AgentClient.AgentException {
        String sid = sessions.get(player);
        if (sid != null) return sid;
        sid = client.createSession(title);
        sessions.put(player, sid);
        return sid;
    }

    private void tell(UUID player, String line) {
        try {
            god.world().tell(player, line);
        } catch (RuntimeException e) {
            LOGGER.info("Could not tell {}: {}", player, e.getMessage());
        }
    }

    static String failureMessage(AgentClient.Failure f) {
        return switch (f) {
            case DOWN -> DOWN;
            case TIMEOUT -> TIMEOUT;
            case ERROR -> ERROR;
        };
    }
}
