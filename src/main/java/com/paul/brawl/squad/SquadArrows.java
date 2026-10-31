package com.paul.brawl.squad;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/**
 * The arrows shot from a bound bow or crossbow, between their release and their first hit (docs/29 §5.4 item 4).
 * Minecraft-free with an injectable clock (SquadArrowsTest); used on the server thread only.
 * <ul>
 *   <li>Keyed by the arrow's UUID, never the entity, so a tracked arrow is not kept alive by this table.</li>
 *   <li>{@link #take} hands an arrow out once: its first hit is the trigger, a piercing arrow's later hits are not.</li>
 *   <li>An arrow is forgotten {@link #TTL_NANOS} after its release (stuck in a wall, flown out of the world, or
 *       unloaded), and the table never holds more than {@link #MAX} arrows (the oldest go first).</li>
 * </ul>
 */
public final class SquadArrows<V> {

    static final long TTL_NANOS = 10_000_000_000L;
    static final int MAX = 256;

    private record Entry<V>(V value, long at) {}

    private final LongSupplier clock;
    /** Insertion order is release order, so the expired and the oldest are at the head. */
    private final LinkedHashMap<UUID, Entry<V>> arrows = new LinkedHashMap<>();

    /** {@code clock}: nanoseconds, monotonic ({@code System::nanoTime}). */
    public SquadArrows(LongSupplier clock) {
        this.clock = clock;
    }

    public void track(UUID arrow, V value) {
        long now = clock.getAsLong();
        purge(now);
        while (arrows.size() >= MAX) {
            Iterator<UUID> it = arrows.keySet().iterator();
            it.next();
            it.remove();
        }
        arrows.put(arrow, new Entry<>(value, now));
    }

    /** The arrow's value at its first hit, then forgotten; null when untracked or expired. */
    public V take(UUID arrow) {
        if (arrows.isEmpty()) return null;
        long now = clock.getAsLong();
        purge(now);
        Entry<V> e = arrows.remove(arrow);
        return e == null ? null : e.value();
    }

    public boolean isEmpty() {
        return arrows.isEmpty();
    }

    int size() {
        return arrows.size();
    }

    private void purge(long now) {
        Iterator<Map.Entry<UUID, Entry<V>>> it = arrows.entrySet().iterator();
        while (it.hasNext()) {
            if (now - it.next().getValue().at() < TTL_NANOS) return;
            it.remove();
        }
    }
}
