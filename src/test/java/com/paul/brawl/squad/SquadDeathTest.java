package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.List;

import org.junit.jupiter.api.Test;

class SquadDeathTest {

    @Test
    void aRosterBotDropsNothingWhateverTheCase() {
        List<String> roster = List.of("Garde01", "Archer02");
        assertTrue(SquadDeath.dropsNothing(roster, "Garde01"));
        assertTrue(SquadDeath.dropsNothing(roster, "garde01"));
        assertTrue(SquadDeath.dropsNothing(roster, "ARCHER02"));
    }

    @Test
    void aPlayerDropsAsVanilla() {
        List<String> roster = List.of("Garde01");
        assertFalse(SquadDeath.dropsNothing(roster, "PUALHubert"));
        assertFalse(SquadDeath.dropsNothing(roster, "Garde0"), "a prefix is another name");
        assertFalse(SquadDeath.dropsNothing(List.of(), "Garde01"), "an empty roster (Squad off)");
        assertFalse(SquadDeath.dropsNothing(roster, null));
        assertFalse(SquadDeath.dropsNothing(null, "Garde01"));
        assertFalse(SquadDeath.dropsNothing(Arrays.asList("Garde01", null), "Garde02"));
    }
}
