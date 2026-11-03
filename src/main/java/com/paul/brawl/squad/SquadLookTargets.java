package com.paul.brawl.squad;

import java.util.Optional;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * The entity a crosshair picks, as vanilla's {@code ProjectileUtil.raycast} (1.21.1) picks it, over entities copied
 * on the server thread, so the commander's long look ({@link SquadLook}) can choose on its worker. Only math types:
 * no world, no entity.
 */
final class SquadLookTargets {

    private SquadLookTargets() {}

    /**
     * An entity in the look's way, as copied: its targeting box (bounding box grown by its targeting margin), whether
     * it rides with the player (the same root vehicle), and what the snapshot names it.
     */
    record Target<T>(AABB box, boolean sameRootVehicle, T ref) {}

    /**
     * Vanilla's choice on the segment {@code from → to}, at most {@code maxSq} (squared) from {@code from}: the nearest
     * box the segment enters; a box holding {@code from} wins at distance 0; what the player rides is taken only when
     * nothing else was. Null when none.
     */
    static <T> T pick(Iterable<Target<T>> targets, Vec3 from, Vec3 to, double maxSq) {
        double d = maxSq;
        T best = null;
        for (Target<T> t : targets) {
            AABB box = t.box();
            Optional<Vec3> at = box.clip(from, to);
            if (box.contains(from)) {
                if (d >= 0) {
                    best = t.ref();
                    d = 0;
                }
            } else if (at.isPresent()) {
                double e = from.distanceToSqr(at.get());
                if (e < d || d == 0) {
                    if (t.sameRootVehicle()) {
                        if (d == 0) best = t.ref();
                    } else {
                        best = t.ref();
                        d = e;
                    }
                }
            }
        }
        return best;
    }
}
