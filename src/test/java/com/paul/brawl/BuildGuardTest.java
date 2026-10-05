package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class BuildGuardTest {

    @BeforeEach
    void reset() {
        BuildGuard.resetForTests();
    }

    @Test
    void subBuildSlotsAreCapped() {
        for (int i = 0; i < BuildGuard.MAX_CONCURRENT_SUB_BUILDS; i++) assertTrue(BuildGuard.tryAcquire());
        assertFalse(BuildGuard.tryAcquire(), "a BuildPlan cannot exceed the parallel cap (bug #7)");
        BuildGuard.release();
        assertTrue(BuildGuard.tryAcquire(), "a finished sub-build frees its slot");
    }

    @Test
    void releaseNeverGoesNegative() {
        BuildGuard.release();
        assertEquals(0, BuildGuard.active());
    }

    @Test
    void cancelAllStopsEverySubBuildStartedBefore() {
        int started = BuildGuard.epoch();
        assertFalse(BuildGuard.cancelledSince(started));
        BuildGuard.cancelAll();
        assertTrue(BuildGuard.cancelledSince(started), "sub-builds had no cancel path (bug #7)");
        assertFalse(BuildGuard.cancelledSince(BuildGuard.epoch()), "a sub-build started after the cancel runs");
    }

    @Test
    void lineBlocksMatchesPlaceLineAt() {
        assertEquals(2, BuildGuard.lineBlocks(0, 0, 0, 0, 0, 0)); // placeLineAt walks i=0..max(1,len)
        assertEquals(11, BuildGuard.lineBlocks(0, 0, 0, 10, 3, -2));
        assertEquals(2_000_001L, BuildGuard.lineBlocks(-1_000_000, 0, 0, 1_000_000, 0, 0));
        assertEquals(4_294_967_296L, BuildGuard.lineBlocks(Integer.MIN_VALUE, 0, 0, Integer.MAX_VALUE, 0, 0), "no int overflow");
    }

    @Test
    void callCapRejectsHugeCalls() {
        assertTrue(BuildGuard.withinCallCap(BuildGuard.MAX_BLOCKS_PER_CALL));
        assertFalse(BuildGuard.withinCallCap(BuildGuard.MAX_BLOCKS_PER_CALL + 1L));
    }
}
