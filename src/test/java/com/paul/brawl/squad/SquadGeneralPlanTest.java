package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;

import org.junit.jupiter.api.Test;

class SquadGeneralPlanTest {

    @Test
    void termsAreKitsReinforcementsAndRange() {
        SquadGeneralPlan.Terms t = SquadGeneralPlan.parseTerms("archer=10 Guard=5 reinforce=4 range=300", true);
        assertEquals(Map.of("archer", 10, "guard", 5), t.allowance());
        assertEquals(4, t.reinforce());
        assertEquals(300, t.range());
        SquadGeneralPlan.Terms only = SquadGeneralPlan.parseTerms("reinforce=2", false);
        assertTrue(only.allowance().isEmpty());
        assertNull(only.range());
    }

    @Test
    void badTermsAreRefusedInFrench() {
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadGeneralPlan.parseTerms("", true)).getMessage().contains("au moins une dotation"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadGeneralPlan.parseTerms("archer=0", true)).getMessage().contains("au moins une dotation"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadGeneralPlan.parseTerms("knight=3", true)).getMessage().contains("un kit"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadGeneralPlan.parseTerms("archer=lots", true)).getMessage().contains("nombre entier"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadGeneralPlan.parseTerms("archer=101", true)).getMessage().contains("entre 0 et 100"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadGeneralPlan.parseTerms("range=5 archer=1", true)).getMessage().contains("entre 16"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> SquadGeneralPlan.parseTerms("archer", true)).getMessage().contains("clé=nombre"));
    }

    @Test
    void namesLeaveRoomForTheBotsSuffix() {
        assertTrue(SquadGeneralPlan.NAME.matcher("Rouge").matches());
        assertTrue(SquadGeneralPlan.NAME.matcher("Rouge_12345").matches()); // 11: Rouge_12345 + Arc + 01 = 16
        assertFalse(SquadGeneralPlan.NAME.matcher("Rouge_123456").matches());
        assertFalse(SquadGeneralPlan.NAME.matcher("ab").matches());
        assertTrue(SquadGeneralPlan.knownKit("archer"));
        assertFalse(SquadGeneralPlan.knownKit("knight"));
    }

    @Test
    void botsStandAcrossTheAxisTheirRowsAlongIt() {
        // Facing east (yaw 270 / -90): a row of 3 lies north-south, centred on the spawn point.
        SquadRaidPlan.XZ mid = SquadGeneralPlan.place(100, -300, 270, 1, 3);
        assertEquals(100, mid.x(), 1e-9);
        assertEquals(-300, mid.z(), 1e-9);
        SquadRaidPlan.XZ first = SquadGeneralPlan.place(100, -300, 270, 0, 3);
        assertEquals(100, first.x(), 1e-9);
        assertEquals(2, Math.abs(first.z() + 300), 1e-9);
        // Two rows of 5 facing south (yaw 0): the rows are 2 blocks apart along z.
        SquadRaidPlan.XZ a = SquadGeneralPlan.place(0, 0, 0, 0, 10);
        SquadRaidPlan.XZ b = SquadGeneralPlan.place(0, 0, 0, 5, 10);
        assertEquals(2, Math.abs(a.z() - b.z()), 1e-9);
        assertEquals(a.x(), b.x(), 1e-9);
    }

    @Test
    void theLaunchLineCarriesTheTicket() {
        assertEquals("cd squad/agent/general; $env:SQUAD_GENERAL_TICKET='gen-x'; claude", SquadGeneralPlan.launchLine("gen-x"));
        assertEquals("cd squad/agent/general && SQUAD_GENERAL_TICKET='gen-x' claude", SquadGeneralPlan.launchLinePosix("gen-x"));
    }
}
