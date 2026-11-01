package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class SquadPacerTest {

    private final SquadPacer pacer = new SquadPacer();

    @Test
    void theFirstActionRunsAtOnce() {
        assertEquals(0, pacer.reserve(1_000, 100));
    }

    @Test
    void actionsAskedTogetherAreSpacedOneIntervalApart() {
        assertEquals(0, pacer.reserve(1_000, 100));
        assertEquals(100, pacer.reserve(1_000, 100));
        assertEquals(200, pacer.reserve(1_000, 100));
        assertEquals(300, pacer.reserve(1_000, 100));
    }

    @Test
    void anActionAskedPartWayThroughTheIntervalWaitsTheRest() {
        pacer.reserve(1_000, 100);
        assertEquals(70, pacer.reserve(1_030, 100));
        // queued behind it: 100 after the one at 1 100
        assertEquals(150, pacer.reserve(1_050, 100));
    }

    @Test
    void anActionLongAfterTheLastRunsAtOnce() {
        pacer.reserve(1_000, 100);
        assertEquals(0, pacer.reserve(5_000, 100));
        assertEquals(100, pacer.reserve(5_000, 100));
    }

    @Test
    void noIntervalNeverWaits() {
        assertEquals(0, pacer.reserve(1_000, 0));
        assertEquals(0, pacer.reserve(1_000, 0));
        assertEquals(0, pacer.reserve(1_000, -5));
    }
}
