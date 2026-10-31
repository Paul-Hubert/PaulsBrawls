package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

class SquadArrowsTest {

    private static final long S = 1_000_000_000L;
    private long now = 100 * S;
    private final SquadArrows<String> arrows = new SquadArrows<>(() -> now);

    @Test
    void anArrowIsHandedOutAtItsFirstHitOnly() {
        UUID a = UUID.randomUUID();
        arrows.track(a, "tir");
        assertEquals("tir", arrows.take(a));
        assertNull(arrows.take(a)); // a piercing arrow's second hit
        assertTrue(arrows.isEmpty());
        assertNull(arrows.take(UUID.randomUUID()));
    }

    @Test
    void anArrowIsForgottenTenSecondsAfterItsRelease() {
        UUID early = UUID.randomUUID();
        UUID late = UUID.randomUUID();
        arrows.track(early, "early");
        now += 6 * S;
        arrows.track(late, "late");
        now += 4 * S; // early is 10 s old
        assertNull(arrows.take(early));
        assertEquals(1, arrows.size());
        assertEquals("late", arrows.take(late));
    }

    @Test
    void theTableKeepsTheNewestWhenFull() {
        List<UUID> ids = new ArrayList<>();
        for (int i = 0; i < SquadArrows.MAX + 10; i++) {
            UUID id = UUID.randomUUID();
            ids.add(id);
            arrows.track(id, "n" + i);
        }
        assertEquals(SquadArrows.MAX, arrows.size());
        assertNull(arrows.take(ids.get(0)));
        assertEquals("n" + (SquadArrows.MAX + 9), arrows.take(ids.get(ids.size() - 1)));
    }
}
