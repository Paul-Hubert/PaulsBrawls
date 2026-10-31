package com.paul.brawl.squad;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.LongSupplier;

/**
 * Per-player throttling of bound-item triggers (docs/29 §5.4 item 4), Minecraft-free with an injectable clock
 * (SquadTriggerLimiterTest). Used on the server thread only, so it holds no lock.
 * <ul>
 *   <li>{@link #tryAcquire}: a token bucket of {@link #BURST}, refilled at {@link #PER_SECOND} a second. A trigger
 *       without a token (stop and arrow hits included) is dropped silently: a held right-click repeats every 4 ticks,
 *       and each would be a runtime call.</li>
 *   <li>{@link #firstOfShot}: one release per player per server tick, so a multishot crossbow's three arrows are one
 *       trigger (and one tracked arrow), not three.</li>
 *   <li>{@link #shouldShow}: the same answer to the same player is shown once per {@link #ECHO_NANOS}. A refused
 *       start answers every click with the same line; without this a held right-click would print it 4 times a
 *       second.</li>
 * </ul>
 * A player is forgotten on disconnect ({@link #forget}); past {@link #MAX_PLAYERS} entries the idle ones are dropped.
 */
public final class SquadTriggerLimiter {

    public static final int BURST = 4;
    public static final double PER_SECOND = 4;
    static final long ECHO_NANOS = 2_000_000_000L;
    static final int MAX_PLAYERS = 512;
    private static final double NANOS = 1e9;

    private static final class State {
        double tokens = BURST;
        long refilledAt;
        long shotTick = Long.MIN_VALUE;
        String lastText;
        long lastTextAt;
    }

    private final LongSupplier clock;
    private final Map<UUID, State> players = new HashMap<>();

    /** {@code clock}: nanoseconds, monotonic ({@code System::nanoTime}). */
    public SquadTriggerLimiter(LongSupplier clock) {
        this.clock = clock;
    }

    /** Take a token for this player's trigger; false = drop it. */
    public boolean tryAcquire(UUID player) {
        long now = clock.getAsLong();
        State s = state(player, now);
        s.tokens = Math.min(BURST, s.tokens + (now - s.refilledAt) * PER_SECOND / NANOS);
        s.refilledAt = now;
        if (s.tokens < 1) return false;
        s.tokens -= 1;
        return true;
    }

    /** True for the first arrow this player released in server tick {@code tick}. */
    public boolean firstOfShot(UUID player, long tick) {
        State s = state(player, clock.getAsLong());
        if (s.shotTick == tick) return false;
        s.shotTick = tick;
        return true;
    }

    /** True unless the same text was shown to this player within the last {@link #ECHO_NANOS}. */
    public boolean shouldShow(UUID player, String text) {
        long now = clock.getAsLong();
        State s = state(player, now);
        if (Objects.equals(s.lastText, text) && now - s.lastTextAt < ECHO_NANOS) return false;
        s.lastText = text;
        s.lastTextAt = now;
        return true;
    }

    public void forget(UUID player) {
        players.remove(player);
    }

    int size() {
        return players.size();
    }

    private State state(UUID player, long now) {
        State s = players.get(player);
        if (s != null) return s;
        if (players.size() >= MAX_PLAYERS) {
            // A bucket that has had time to fill and no recent echo holds nothing worth keeping.
            players.values().removeIf(x -> now - x.refilledAt >= NANOS * BURST / PER_SECOND && now - x.lastTextAt >= ECHO_NANOS);
        }
        s = new State();
        s.refilledAt = now;
        s.lastTextAt = now - ECHO_NANOS;
        players.put(player, s);
        return s;
    }
}
