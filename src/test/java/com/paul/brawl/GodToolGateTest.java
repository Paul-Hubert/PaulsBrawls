package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class GodToolGateTest {

    @Test
    void theSessionOwnerMayDriveTheBodyWhileTheBridgeIsOn() {
        assertNull(GodToolGate.mcpRefusal(true, true));
    }

    @Test
    void aBodilessPrayerCannotDriveTheBody() {
        String r = GodToolGate.mcpRefusal(true, false);
        assertNotNull(r, "bug #8: MCP tools had no session-ownership gate");
        assertTrue(r.contains("occupé"));
    }

    @Test
    void aDisabledBridgeRefusesEveryone() {
        assertTrue(GodToolGate.mcpRefusal(false, true).contains("désactivé"));
        assertTrue(GodToolGate.mcpRefusal(false, false).contains("désactivé"));
    }
}
