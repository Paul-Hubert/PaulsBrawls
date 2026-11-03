package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

class SquadSavesTest {

    @Test
    void aDespawnedBotsSaveGoesOnceItIsOfflineAndOutOfTheRoster() {
        SquadSaves s = new SquadSaves();
        assertTrue(s.isEmpty());
        s.forget("Garde01", 0);
        Set<String> online = new HashSet<>(Set.of("Garde01"));
        Set<String> roster = new HashSet<>(Set.of("Garde01"));

        // Still online (its save is not written yet), then still in the cached roster (the state event lags).
        assertEquals(new SquadSaves.Due(List.of(), List.of()), s.due(1_000, online::contains, roster::contains));
        online.clear();
        assertEquals(new SquadSaves.Due(List.of(), List.of()), s.due(2_000, online::contains, roster::contains));
        roster.clear();
        assertEquals(new SquadSaves.Due(List.of("Garde01"), List.of()), s.due(3_000, online::contains, roster::contains));
        assertTrue(s.isEmpty());
        assertEquals(new SquadSaves.Due(List.of(), List.of()), s.due(4_000, online::contains, roster::contains));
    }

    @Test
    void aNameStillInTheRosterAfterTheWaitIsGivenUpAndItsSaveKept() {
        SquadSaves s = new SquadSaves();
        s.forget("Archer03", 0);
        // Spawned again under the same name: a roster bot, whose save must stay.
        assertEquals(new SquadSaves.Due(List.of(), List.of()), s.due(SquadSaves.WAIT_MS, n -> false, n -> true));
        assertEquals(new SquadSaves.Due(List.of(), List.of("Archer03")), s.due(SquadSaves.WAIT_MS + 1, n -> false, n -> true));
        assertTrue(s.isEmpty());
    }

    @Test
    void theExactNameIsKeptAndForgettingTwiceWaitsOnce() {
        SquadSaves s = new SquadSaves();
        s.forget("EnnGarde07", 0);
        s.forget("enngarde07", 10);
        SquadSaves.Due d = s.due(20, n -> false, n -> false);
        // The offline UUID is case-sensitive: the last name given is the one deleted.
        assertEquals(List.of("enngarde07"), d.delete());
        assertTrue(s.isEmpty());
    }

    @Test
    void generatedNamesAreTheOnesSpawnAndRaidGive() {
        List<String> prefixes = SquadSaves.prefixes();
        assertEquals(List.of("Archer", "Garde", "Mineur", "Fermier", "EnnArcher", "EnnGarde"), prefixes);
        List<String> names = SquadSaves.generatedNames(List.of("Garde", "EnnArcher"));
        assertEquals("Garde01", names.get(0));
        assertTrue(names.contains("Garde09") && names.contains("Garde134") && names.contains("Garde9999"));
        assertFalse(names.contains("Garde1") || names.contains("Garde10000"));
        assertTrue(names.contains("EnnArcher01") && names.contains("EnnArcher9999"));
        // Every one is a name SquadRaidPlan.names can give: the first free ones of an empty world.
        assertEquals(names.subList(0, 3), SquadRaidPlan.names("Garde", 3, n -> false));
        assertEquals(2 * SquadRaidPlan.MAX_NUMBER, names.size());
        for (String n : names) assertTrue(n.length() <= 16, n);
    }
}
