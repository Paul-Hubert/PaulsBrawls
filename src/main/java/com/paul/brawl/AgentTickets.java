package com.paul.brawl;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * The tickets the mod hands an external agent (docs/27 §5). A ticket is an unguessable id naming ONE player and
 * one server kind; every {@code god}/{@code builder} MCP call must carry one, and the ticket — never an argument
 * the agent chose — decides which player a tool touches. Minecraft-free (AgentTicketsTest).
 */
public final class AgentTickets {

    public enum Kind { GOD, BUILDER }

    /** {@code generation} is {@link GodSessionManager#generation()} at minting (god tickets only). */
    public record Ticket(String id, Kind kind, UUID player, long generation, long expiresAtMillis) {}

    private final Map<String, Ticket> tickets = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private final LongSupplier clock;

    public AgentTickets() {
        this(System::currentTimeMillis);
    }

    public AgentTickets(LongSupplier clock) {
        this.clock = clock;
    }

    /** Mint a ticket; any earlier ticket of the same player and kind is revoked (one live turn per player). */
    public Ticket mint(Kind kind, UUID player, long generation, long ttlMillis) {
        revoke(player, kind);
        byte[] b = new byte[16];
        random.nextBytes(b);
        String id = (kind == Kind.GOD ? "god-" : "bld-") + Base64.getUrlEncoder().withoutPadding().encodeToString(b);
        Ticket t = new Ticket(id, kind, player, generation, clock.getAsLong() + ttlMillis);
        tickets.put(id, t);
        return t;
    }

    /** The live ticket, or null when unknown, expired (removed) or of the other kind. */
    public Ticket resolve(String id, Kind kind) {
        if (id == null) return null;
        Ticket t = tickets.get(id.trim());
        if (t == null || t.kind() != kind) return null;
        if (clock.getAsLong() >= t.expiresAtMillis()) {
            tickets.remove(t.id());
            return null;
        }
        return t;
    }

    public void revoke(String id) {
        if (id != null) tickets.remove(id);
    }

    /** Revoke every ticket of {@code player} (null = every player) of {@code kind}. */
    public void revoke(UUID player, Kind kind) {
        tickets.values().removeIf(t -> t.kind() == kind && (player == null || t.player().equals(player)));
    }

    public int size() {
        return tickets.size();
    }
}
