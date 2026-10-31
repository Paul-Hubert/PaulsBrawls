package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.jupiter.api.Test;

class SquadRaidPlanTest {

    @Test
    void argumentsArePositionalAndOptional() {
        assertEquals(new SquadRaidPlan.Args(200, 10, 10), SquadRaidPlan.parse(""));
        assertEquals(new SquadRaidPlan.Args(200, 10, 10), SquadRaidPlan.parse(null));
        assertEquals(new SquadRaidPlan.Args(150, 10, 10), SquadRaidPlan.parse("150"));
        assertEquals(new SquadRaidPlan.Args(80, 4, 6), SquadRaidPlan.parse(" 80  4 6 "));
        assertEquals(new SquadRaidPlan.Args(80, 0, 6), SquadRaidPlan.parse("80 0 6"));
        assertEquals(10, SquadRaidPlan.parse("80 4 6").total());
    }

    @Test
    void badArgumentsAreRefusedInFrench() {
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadRaidPlan.parse("loin")).getMessage().contains("nombre entier"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadRaidPlan.parse("5")).getMessage().contains("entre 16"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadRaidPlan.parse("200 31")).getMessage().contains("archers"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadRaidPlan.parse("200 0 0")).getMessage().contains("au moins"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadRaidPlan.parse("1 2 3 4")).getMessage().contains("trop"));
    }

    @Test
    void thePointIsAheadAlongTheHorizontalLookDirection() {
        // Minecraft yaw: 0 looks to +Z (south), 90 to -X (west), 180 to -Z, -90 / 270 to +X.
        assertXZ(10, 210, SquadRaidPlan.point(10, 10, 0, 200));
        assertXZ(-190, 10, SquadRaidPlan.point(10, 10, 90, 200));
        assertXZ(10, -190, SquadRaidPlan.point(10, 10, 180, 200));
        assertXZ(210, 10, SquadRaidPlan.point(10, 10, -90, 200));
        SquadRaidPlan.XZ d = SquadRaidPlan.point(0, 0, 45, 100);
        assertEquals(100, Math.hypot(d.x(), d.z()), 1e-9, "the distance is horizontal");
    }

    private static void assertXZ(double x, double z, SquadRaidPlan.XZ p) {
        assertEquals(x, p.x(), 1e-9);
        assertEquals(z, p.z(), 1e-9);
    }

    @Test
    void namesSkipTakenOnesAndFitSixteenCharacters() {
        Set<String> taken = Set.of("EnnArcher02", "EnnArcher03");
        assertEquals(List.of("EnnArcher01", "EnnArcher04", "EnnArcher05"), SquadRaidPlan.names("EnnArcher", 3, taken::contains));
        List<String> many = SquadRaidPlan.names(SquadRaidPlan.GUARD_PREFIX, 120, n -> false);
        assertEquals("EnnGarde120", many.get(119));
        assertTrue(many.stream().allMatch(n -> SquadArgs.BOT_NAME.matcher(n).matches()), "valid bot names, at most 16 characters");
        assertEquals(List.of(), SquadRaidPlan.names("EnnGarde", 0, n -> true));
        assertTrue(SquadRaidPlan.OWNER.matches("[A-Za-z0-9_]{3,16}"), "the owner is a valid offline name");
    }

    @Test
    void raidersAppearOnDistinctSpotsAroundThePoint() {
        for (int n : new int[] { 1, 3, 7, 20 }) {
            Set<String> spots = new HashSet<>();
            Set<Double> rows = new HashSet<>();
            double sx = 0;
            for (int i = 0; i < n; i++) {
                SquadRaidPlan.XZ d = SquadRaidPlan.spread(i, n);
                spots.add(d.x() + "," + d.z());
                sx += d.x();
                rows.add(d.z());
                assertTrue(Math.abs(d.x()) <= 4 && Math.abs(d.z()) <= 4, "close to the point: " + d);
            }
            assertEquals(n, spots.size(), "one spot each for " + n);
            assertEquals(0, rows.stream().mapToDouble(Double::doubleValue).sum(), 1e-9, "rows centred on the point");
            if (n % SquadRaidPlan.ROW == 0 || n < SquadRaidPlan.ROW) assertEquals(0, sx / n, 1e-9, "columns centred");
        }
        assertEquals(new SquadRaidPlan.XZ(0, 0), SquadRaidPlan.spread(0, 1));
    }

    @Test
    void theStartWaitsForEveryLoginPlusSlack() {
        assertEquals(110_000, SquadRaidPlan.startTimeoutMs(20));
        assertEquals(34_000, SquadRaidPlan.startTimeoutMs(1));
    }

    @Test
    void theOrderTargetsTheCallersPosition() {
        assertEquals(List.of("x=12", "y=64", "z=-30", "target=Paul"), SquadRaidPlan.orderTokens(11.6, 64.0, -30.2, "Paul"));
        assertEquals(List.of("x=0", "y=70", "z=0"), SquadRaidPlan.orderTokens(0, 70, 0, null));
    }
}
