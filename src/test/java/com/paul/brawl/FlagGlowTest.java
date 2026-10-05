package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.UUID;

import org.junit.jupiter.api.Test;

class FlagGlowTest {

    private final UUID alice = UUID.randomUUID();

    @Test
    void glowsWhileCarryingAndClearsOnDrop() {
        FlagGlow g = new FlagGlow();
        assertEquals(FlagGlow.Action.SET, g.update(alice, true, false));
        assertEquals(FlagGlow.Action.NONE, g.update(alice, true, true), "already glowing from us: nothing to do");
        assertEquals(FlagGlow.Action.CLEAR, g.update(alice, false, true));
        assertEquals(FlagGlow.Action.NONE, g.update(alice, false, false));
    }

    @Test
    void neverClearsAGlowItDidNotSet() {
        FlagGlow g = new FlagGlow();
        // Bug #11: setGlowing(false) every tick used to clobber a glow from another source.
        assertEquals(FlagGlow.Action.NONE, g.update(alice, false, true));
        assertEquals(FlagGlow.Action.NONE, g.update(alice, true, true), "a pre-existing glow is not adopted");
        assertEquals(FlagGlow.Action.NONE, g.update(alice, false, true), "…so dropping the flag does not clear it");
    }

    @Test
    void forgetReportsOwnershipSoTheCallerClearsTheGlowBeforeTheSave() {
        // Review fix: vanilla persists "Glowing". forget() used to return nothing, so a Flag carrier who logged out
        // came back glowing with no owner, and the glow could never be cleared. The caller now clears an owned glow.
        FlagGlow g = new FlagGlow();
        g.update(alice, true, false);
        assertTrue(g.forget(alice), "the mod owned this glow — the caller must clear it before the player is saved");
        assertFalse(g.forget(alice), "forgotten: nothing left to clear");
        assertEquals(FlagGlow.Action.NONE, g.update(alice, false, true), "an unowned glow is still never cleared");
        UUID bob = UUID.randomUUID();
        assertFalse(g.forget(bob), "never ours: leave it alone");
    }

    @Test
    void flagNamesAreACaseSensitiveSubstring() {
        assertTrue(FlagGlow.isFlagName("Red Flag"));
        assertFalse(FlagGlow.isFlagName("red flag"));
        assertFalse(FlagGlow.isFlagName(null));
    }
}
