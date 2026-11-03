package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;

import org.junit.jupiter.api.Test;

import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

class SquadLookTargetsTest {

    private static final Vec3 EYE = new Vec3(0, 1.62, 0);
    private static final Vec3 FAR = new Vec3(100, 1.62, 0); // looking along +x

    private static SquadLookTargets.Target<String> at(double x, String name) {
        return new SquadLookTargets.Target<>(new AABB(x - 0.3, 0, -0.3, x + 0.3, 1.8, 0.3), false, name);
    }

    @Test
    void theNearestBoxTheLookEntersWinsWhateverTheOrder() {
        assertEquals("near", SquadLookTargets.pick(List.of(at(40, "far"), at(10, "near"), at(25, "mid")), EYE, FAR, 100 * 100));
        SquadLookTargets.Target<String> aside = new SquadLookTargets.Target<>(new AABB(9, 0, 4, 10, 2, 5), false, "aside");
        assertNull(SquadLookTargets.pick(List.of(aside), EYE, FAR, 100 * 100));
    }

    @Test
    void onlyBoxesWithinTheLimitCount() {
        // The limit is the block hit's distance: an entity behind the block is not looked at.
        assertNull(SquadLookTargets.pick(List.of(at(40, "behind")), EYE, new Vec3(30, 1.62, 0), 30 * 30));
        assertEquals("before", SquadLookTargets.pick(List.of(at(40, "behind"), at(20, "before")), EYE, new Vec3(30, 1.62, 0), 30 * 30));
    }

    @Test
    void aBoxHoldingTheEyesWinsAndWhatThePlayerRidesOnlyWhenAlone() {
        SquadLookTargets.Target<String> around = new SquadLookTargets.Target<>(new AABB(-1, 0, -1, 1, 3, 1), false, "around");
        assertEquals("around", SquadLookTargets.pick(List.of(around), EYE, FAR, 100 * 100));
        // As vanilla: after a box holding the eyes (distance 0), a later box the look enters still takes it.
        assertEquals("later", SquadLookTargets.pick(List.of(around, at(10, "later")), EYE, FAR, 100 * 100));
        SquadLookTargets.Target<String> horse = new SquadLookTargets.Target<>(new AABB(3, 0, -1, 5, 2, 1), true, "horse");
        assertEquals("zombie", SquadLookTargets.pick(List.of(horse, at(10, "zombie")), EYE, FAR, 100 * 100));
        assertNull(SquadLookTargets.pick(List.of(horse), EYE, FAR, 100 * 100));
    }
}
