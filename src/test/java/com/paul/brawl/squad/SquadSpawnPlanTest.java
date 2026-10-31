package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

class SquadSpawnPlanTest {

    @Test
    void spawnTakesAKitThenAnOptionalNumberOwnerAndOtherOwners() {
        SquadSpawnPlan.SpawnArgs a = SquadSpawnPlan.parseSpawn("guard");
        assertEquals("guard", a.kit().name());
        assertEquals(5, a.count());
        assertEquals("@s", a.owner());
        assertEquals(List.of(), a.others());

        a = SquadSpawnPlan.parseSpawn("archer 8");
        assertEquals("archer", a.kit().name());
        assertEquals(8, a.count());
        assertEquals("@s", a.owner());

        a = SquadSpawnPlan.parseSpawn("Archer 3 Paul Alice, Bob alice");
        assertEquals(3, a.count());
        assertEquals("Paul", a.owner());
        assertEquals(List.of("Alice", "Bob"), a.others());

        // No number: the next token is the owner.
        a = SquadSpawnPlan.parseSpawn("miner @s Alice");
        assertEquals(5, a.count());
        assertEquals("@s", a.owner());
        assertEquals(List.of("Alice"), a.others());
    }

    @Test
    void spawnRefusesAnUnknownKitAndANumberOutOfRange() {
        assertThrows(IllegalArgumentException.class, () -> SquadSpawnPlan.parseSpawn(""));
        assertThrows(IllegalArgumentException.class, () -> SquadSpawnPlan.parseSpawn("wizard"));
        assertThrows(IllegalArgumentException.class, () -> SquadSpawnPlan.parseSpawn("guard 0"));
        assertThrows(IllegalArgumentException.class, () -> SquadSpawnPlan.parseSpawn("guard 31"));
    }

    @Test
    void despawnTakesAnOptionalKitThenAnOptionalOwner() {
        SquadSpawnPlan.DespawnArgs d = SquadSpawnPlan.parseDespawn("");
        assertTrue(d.kit().isEmpty());
        assertEquals("@s", d.owner());
        d = SquadSpawnPlan.parseDespawn("guard");
        assertEquals("guard", d.kit().orElseThrow().name());
        assertEquals("@s", d.owner());
        d = SquadSpawnPlan.parseDespawn("archer Paul");
        assertEquals("archer", d.kit().orElseThrow().name());
        assertEquals("Paul", d.owner());
        d = SquadSpawnPlan.parseDespawn("Paul");
        assertTrue(d.kit().isEmpty());
        assertEquals("Paul", d.owner());
        assertThrows(IllegalArgumentException.class, () -> SquadSpawnPlan.parseDespawn("guard Paul Alice"));
    }

    @Test
    void namesFollowTheKit() {
        assertEquals("Garde", SquadSpawnPlan.prefix(SquadKits.find("guard").orElseThrow()));
        assertEquals("Archer", SquadSpawnPlan.prefix(SquadKits.find("archer").orElseThrow()));
        assertEquals("Mineur", SquadSpawnPlan.prefix(SquadKits.find("miner").orElseThrow()));
        assertEquals("Fermier", SquadSpawnPlan.prefix(SquadKits.find("farmer").orElseThrow()));
    }

    @Test
    void theRingKeepsBotsApartAndOffTheOwner() {
        for (int n : new int[] { 1, 5, 12, 30 }) {
            Set<String> blocks = new HashSet<>();
            for (int i = 0; i < n; i++) {
                SquadSpawnPlan.XZ p = SquadSpawnPlan.ring(i, n);
                assertTrue(Math.hypot(p.x(), p.z()) >= SquadSpawnPlan.MIN_RADIUS - 0.01, "too near the owner: " + p);
                blocks.add(Math.floor(p.x()) + "," + Math.floor(p.z()));
            }
            assertEquals(n, blocks.size(), "two bots in one block for n=" + n);
        }
    }
}
