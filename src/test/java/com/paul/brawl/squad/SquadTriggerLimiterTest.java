package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.UUID;

import org.junit.jupiter.api.Test;

class SquadTriggerLimiterTest {

    private static final long MS = 1_000_000L;
    private long now = 5_000 * MS;
    private final SquadTriggerLimiter limiter = new SquadTriggerLimiter(() -> now);
    private final UUID alice = UUID.randomUUID();
    private final UUID bob = UUID.randomUUID();

    @Test
    void aBurstOfFourThenDropped() {
        for (int i = 0; i < 4; i++) assertTrue(limiter.tryAcquire(alice), "trigger " + i);
        assertFalse(limiter.tryAcquire(alice));
        assertFalse(limiter.tryAcquire(alice));
    }

    @Test
    void refillsAtFourASecond() {
        for (int i = 0; i < 4; i++) limiter.tryAcquire(alice);
        now += 200 * MS; // 0.8 token
        assertFalse(limiter.tryAcquire(alice));
        now += 60 * MS; // 1.04
        assertTrue(limiter.tryAcquire(alice));
        assertFalse(limiter.tryAcquire(alice));
        now += 10_000 * MS; // capped at the burst, not 40
        for (int i = 0; i < 4; i++) assertTrue(limiter.tryAcquire(alice));
        assertFalse(limiter.tryAcquire(alice));
    }

    @Test
    void aSteadyFourASecondPasses() {
        int passed = 0;
        for (int i = 0; i < 40; i++) {
            if (limiter.tryAcquire(alice)) passed++;
            now += 250 * MS;
        }
        assertEquals(40, passed);
    }

    @Test
    void eightASecondIsCutToFour() {
        int passed = 0;
        for (int i = 0; i < 80; i++) { // 10 s at 8 a second
            if (limiter.tryAcquire(alice)) passed++;
            now += 125 * MS;
        }
        assertTrue(passed >= 42 && passed <= 45, "passed " + passed); // the burst of 4, then 4 a second
    }

    @Test
    void playersHaveTheirOwnBuckets() {
        for (int i = 0; i < 4; i++) limiter.tryAcquire(alice);
        assertFalse(limiter.tryAcquire(alice));
        for (int i = 0; i < 4; i++) assertTrue(limiter.tryAcquire(bob));
    }

    @Test
    void forgettingAPlayerFreesTheirEntry() {
        for (int i = 0; i < 4; i++) limiter.tryAcquire(alice);
        limiter.forget(alice);
        assertEquals(0, limiter.size());
        assertTrue(limiter.tryAcquire(alice)); // a fresh, full bucket
    }

    @Test
    void theMapIsBoundedByDroppingIdlePlayers() {
        for (int i = 0; i < SquadTriggerLimiter.MAX_PLAYERS; i++) limiter.tryAcquire(UUID.randomUUID());
        assertEquals(SquadTriggerLimiter.MAX_PLAYERS, limiter.size());
        now += 5_000 * MS; // every bucket full again, no recent line
        limiter.tryAcquire(alice);
        assertEquals(1, limiter.size());
    }

    @Test
    void oneReleasePerShotTick() {
        assertTrue(limiter.firstOfShot(alice, 100));
        assertFalse(limiter.firstOfShot(alice, 100)); // multishot: the 2nd and 3rd arrows
        assertFalse(limiter.firstOfShot(alice, 100));
        assertTrue(limiter.firstOfShot(bob, 100));
        assertTrue(limiter.firstOfShot(alice, 101));
    }

    @Test
    void theSameLineIsShownOnceInTwoSeconds() {
        String refused = "[Bots] Pas assez de bots pour « tir » : archers 0/1.";
        assertTrue(limiter.shouldShow(alice, refused));
        now += 1_000 * MS;
        assertFalse(limiter.shouldShow(alice, refused));
        assertTrue(limiter.shouldShow(bob, refused));
        assertTrue(limiter.shouldShow(alice, "[Bots] « tir » arrêté."));
        assertTrue(limiter.shouldShow(alice, refused)); // another line came between
        now += 2_000 * MS;
        assertTrue(limiter.shouldShow(alice, refused));
    }
}
