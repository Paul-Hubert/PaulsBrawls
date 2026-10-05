package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class GodClampsTest {

    @Test
    void rewardIsClampedToTheConfiguredMax() {
        assertEquals(64, GodClamps.rewardAmount(1_000_000, 64), "bug #6: Reward was unclamped");
        assertEquals(5, GodClamps.rewardAmount(5, 64));
        assertEquals(1, GodClamps.rewardAmount(0, 64));
    }

    @Test
    void punishmentStrikesAreCapped() {
        assertEquals(3, GodClamps.punishments(500, 3), "bug #6: mass lightning in one tick");
        assertEquals(0, GodClamps.punishments(-4, 3));
        assertEquals(2, GodClamps.punishments(2, 3));
    }

    @Test
    void spawnOffsetsStayNearThePlayer() {
        assertEquals(16, GodClamps.spawnOffset(30_000_000, 16), "bug #6: SpawnCreature offsets were unclamped");
        assertEquals(-16, GodClamps.spawnOffset(Integer.MIN_VALUE, 16));
        assertEquals(-3, GodClamps.spawnOffset(-3, 16));
        assertEquals(0, GodClamps.spawnOffset(9, -1), "a negative max pins the spawn to the player");
    }

    @Test
    void aMaxBelowTheMinYieldsTheMin() {
        assertEquals(1, GodClamps.rewardAmount(10, 0));
    }
}
