package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;

/** Squads and the selected squad (docs/40): the tag rules, the texts, the per-player selection. */
class SquadSelectionTest {

    @Test
    void aBotsSquadIsItsEscTag() {
        assertEquals(Optional.of("esc-3"), SquadSelection.squadOf(List.of("archer", "esc-3")));
        assertEquals(Optional.of("esc-2"), SquadSelection.squadOf(List.of("esc-10", "esc-2")), "the lowest, should it have several");
        assertEquals(Optional.empty(), SquadSelection.squadOf(List.of("guard", "escort", "esc-", "esc-x1")));
        assertEquals(Optional.empty(), SquadSelection.squadOf(List.of()));
    }

    @Test
    void aNewSquadIsOnePastTheHighestNumberAndTheLastGiven() {
        assertEquals("esc-1", SquadSelection.nextTag(List.of(), 0));
        assertEquals("esc-8", SquadSelection.nextTag(List.of("archer", "esc-2", "esc-7", "guard"), 0));
        // A second spawn before the runtime's state shows the first one's bots.
        assertEquals("esc-5", SquadSelection.nextTag(List.of("esc-2"), 4));
        assertEquals(5, SquadSelection.number("esc-5"));
        assertEquals(0, SquadSelection.number("archer"));
        // Within the runtime's tag rule (a-z, 0-9, _ and -, 24 at most).
        assertTrue(SquadSelection.nextTag(List.of("esc-999999999"), 0).matches("[a-z0-9_-]{1,24}"));
    }

    @Test
    void theSelectorIsAReservedOrder() {
        assertTrue(SquadSelection.isSelector("select"));
        assertTrue(SquadSelection.isSelector("SELECT"));
        assertFalse(SquadSelection.isSelector("line"));
        assertFalse(SquadSelection.isSelector(null));
        assertTrue(SquadBinding.validOrder(SquadSelection.SELECT), "a bind line names it like any order");
        assertEquals("Sélecteur d'escouade", SquadBinding.loreFor("select", ""));
    }

    @Test
    void theTexts() {
        assertEquals("[Bots] Escouade 3 sélectionnée : Archer01, Garde01 (2 bots).", SquadSelection.selectedText("esc-3", List.of("Archer01", "Garde01")));
        assertEquals("[Bots] Escouade 4 sélectionnée : Garde02 (1 bot).", SquadSelection.selectedText("esc-4", List.of("Garde02")));
        assertEquals("[Bots] Escouade désélectionnée.", SquadSelection.deselectedText(true));
        assertEquals("[Bots] Aucune escouade sélectionnée.", SquadSelection.deselectedText(false));
    }

    @Test
    void oneSelectionPerPlayer() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        assertEquals(Optional.empty(), SquadSelection.selected(a));
        SquadSelection.select(a, "esc-1");
        SquadSelection.select(b, "esc-2");
        SquadSelection.select(a, "esc-3"); // another squad replaces the first
        assertEquals(Optional.of("esc-3"), SquadSelection.selected(a));
        assertEquals(Optional.of("esc-2"), SquadSelection.selected(b));
        assertTrue(SquadSelection.clear(a));
        assertFalse(SquadSelection.clear(a));
        assertEquals(Optional.empty(), SquadSelection.selected(a));
        assertTrue(SquadSelection.clear(b));
    }
}
