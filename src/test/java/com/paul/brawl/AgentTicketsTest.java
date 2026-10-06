package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.Test;

class AgentTicketsTest {

    private final AtomicLong now = new AtomicLong(0);
    private final AgentTickets tickets = new AgentTickets(now::get);
    private final UUID alice = UUID.randomUUID();

    @Test
    void aTicketNamesOnePlayerAndOneKind() {
        AgentTickets.Ticket t = tickets.mint(AgentTickets.Kind.GOD, alice, 7, 1000);
        assertTrue(t.id().startsWith("god-") && t.id().length() > 20, "unguessable: 128 random bits");
        assertEquals(alice, tickets.resolve(t.id(), AgentTickets.Kind.GOD).player());
        assertEquals(7, tickets.resolve(" " + t.id() + " ", AgentTickets.Kind.GOD).generation());
        assertNull(tickets.resolve(t.id(), AgentTickets.Kind.BUILDER), "kinds never cross");
        assertNull(tickets.resolve(null, AgentTickets.Kind.GOD));
    }

    @Test
    void ticketsExpire() {
        AgentTickets.Ticket t = tickets.mint(AgentTickets.Kind.BUILDER, alice, 0, 1000);
        now.set(999);
        assertNotNull(tickets.resolve(t.id(), AgentTickets.Kind.BUILDER));
        now.set(1000);
        assertNull(tickets.resolve(t.id(), AgentTickets.Kind.BUILDER));
        assertEquals(0, tickets.size(), "an expired ticket is dropped");
    }

    @Test
    void aNewTicketRevokesThePlayersOldOne() {
        AgentTickets.Ticket a = tickets.mint(AgentTickets.Kind.GOD, alice, 1, 1000);
        AgentTickets.Ticket b = tickets.mint(AgentTickets.Kind.GOD, alice, 2, 1000);
        assertNotEquals(a.id(), b.id());
        assertNull(tickets.resolve(a.id(), AgentTickets.Kind.GOD));
        assertNotNull(tickets.resolve(b.id(), AgentTickets.Kind.GOD));
        AgentTickets.Ticket build = tickets.mint(AgentTickets.Kind.BUILDER, alice, 0, 1000);
        tickets.revoke(null, AgentTickets.Kind.GOD);
        assertNull(tickets.resolve(b.id(), AgentTickets.Kind.GOD));
        assertNotNull(tickets.resolve(build.id(), AgentTickets.Kind.BUILDER), "revoking one kind keeps the other");
    }

    @Test
    void tokenAndOriginChecks() {
        assertTrue(McpHttpEndpoint.tokenMatches("Bearer abc", "abc"));
        assertTrue(McpHttpEndpoint.tokenMatches("bearer  abc ", "abc"));
        assertTrue(!McpHttpEndpoint.tokenMatches("Bearer abd", "abc"));
        assertTrue(!McpHttpEndpoint.tokenMatches("Bearer ", ""), "a blank configured token refuses everything");
        assertTrue(!McpHttpEndpoint.tokenMatches("Basic abc", "abc"));
        assertTrue(McpHttpEndpoint.originAllowed(null));
        assertTrue(McpHttpEndpoint.originAllowed("http://127.0.0.1:4096"));
        assertTrue(!McpHttpEndpoint.originAllowed("https://evil.example"));
        assertTrue(!McpHttpEndpoint.originAllowed("not a uri"));
    }
}
