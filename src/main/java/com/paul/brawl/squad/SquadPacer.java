package com.paul.brawl.squad;

/**
 * Spaces out actions so two of them are at least an interval apart, counted from the last one whoever asked: the
 * kits of {@code /bots squad spawn}, {@code /bots raid} and {@code /bots equip} go out one every
 * {@link SquadConfig#kitStaggerMs} (like the runtime's logins, {@code loginStaggerMs}). Minecraft-free
 * (SquadPacerTest). Used on the server thread only, so it holds no lock.
 */
public final class SquadPacer {

    /** When the last reserved action runs (ms, the caller's clock); none yet = far in the past. */
    private long lastAt = Long.MIN_VALUE / 2;

    /**
     * Reserve the next slot: how long to wait (ms, ≥ 0) from {@code nowMs} so this action runs at least
     * {@code intervalMs} after the previous one. An interval ≤ 0 never waits.
     */
    public long reserve(long nowMs, long intervalMs) {
        long at = intervalMs <= 0 ? nowMs : Math.max(nowMs, lastAt + intervalMs);
        lastAt = at;
        return at - nowMs;
    }
}
