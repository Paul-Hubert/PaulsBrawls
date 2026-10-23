package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The periodic sub-build sweep: an idle lease gives its BuildGuard slot back without any later builder call (the
 * slots are shared with the builtin BuildSubAgent), and a closed sweeper stops sweeping. Idleness follows the
 * injected clock; only the sweep period is real time.
 */
class SubBuildsSweeperTest {

    private final AtomicLong clock = new AtomicLong(1_000_000);
    private final SubBuilds subBuilds = new SubBuilds(clock::get, 120_000);
    private final UUID alice = UUID.randomUUID();

    @BeforeEach
    @AfterEach
    void clean() {
        subBuilds.endAll(null);
        BuildGuard.resetForTests();
    }

    @Test
    void anIdleLeaseIsReleasedWithoutAnyCall() throws Exception {
        try (AutoCloseable sweeper = subBuilds.startSweeper(10)) {
            assertNotNull(subBuilds.begin(alice, new int[] { 0, 64, 0 }, "tour", 0, 0, 0).lease());
            assertNotNull(subBuilds.begin(alice, new int[] { 0, 64, 0 }, "mur", 8, 0, 0).lease());
            Thread.sleep(50);
            assertEquals(2, BuildGuard.active(), "not idle yet: nothing is swept");
            clock.addAndGet(120_000);
            awaitSlots(0);
            assertEquals(0, subBuilds.live());
        }
    }

    @Test
    void aClosedSweeperStopsSweeping() throws Exception {
        AutoCloseable sweeper = subBuilds.startSweeper(10);
        sweeper.close();
        assertNotNull(subBuilds.begin(alice, new int[] { 0, 64, 0 }, null, 0, 0, 0).lease());
        clock.addAndGet(120_000);
        Thread.sleep(100);
        assertEquals(1, BuildGuard.active(), "after close, only a call sweeps");
        subBuilds.sweep();
        assertEquals(0, BuildGuard.active());
    }

    @Test
    void thePeriodFollowsTheIdleLimit() {
        assertEquals(30_000, SubBuilds.sweepPeriodMillis(120_000));
        assertEquals(1_000, SubBuilds.sweepPeriodMillis(2_000));
        assertEquals(30_000, SubBuilds.sweepPeriodMillis(3_600_000));
    }

    private static void awaitSlots(int n) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 2_000;
        while (BuildGuard.active() != n) {
            assertTrue(System.currentTimeMillis() < deadline, "slots still " + BuildGuard.active() + ", want " + n);
            Thread.sleep(10);
        }
    }
}
