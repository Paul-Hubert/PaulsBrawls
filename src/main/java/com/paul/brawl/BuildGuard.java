package com.paul.brawl;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * Bug #7 — the Minecraft-free limits around textual building (unit-tested in BuildGuardTest).
 *
 * <ul>
 *   <li><b>Concurrency:</b> at most {@link #MAX_CONCURRENT_SUB_BUILDS} BuildSubAgents run at once; a BuildPlan
 *       asking for more launches only what fits and says so.</li>
 *   <li><b>Cancel:</b> {@link #cancelAll()} bumps an epoch; a sub-agent started under an older epoch stops at its
 *       next turn (used by {@code /godbody off} and server stop — sub-builds used to have no cancel path).</li>
 *   <li><b>Size:</b> one textual call places at most {@link #MAX_BLOCKS_PER_CALL} blocks, so a single
 *       {@code PlaceLine(0,0,0, 1000000,0,0, …)} cannot queue a million {@code setBlockState}s.</li>
 * </ul>
 */
public final class BuildGuard {
    private BuildGuard() {}

    /** Parallel sub-agents allowed across the whole server. */
    public static final int MAX_CONCURRENT_SUB_BUILDS = 4;
    /** Blocks one PlaceLine / PlaceBlocks call may place (each call is one main-thread task). */
    public static final int MAX_BLOCKS_PER_CALL = 128;

    private static final AtomicInteger ACTIVE = new AtomicInteger();
    private static final AtomicInteger EPOCH = new AtomicInteger();

    /** Claim a sub-build slot; false when {@link #MAX_CONCURRENT_SUB_BUILDS} are already running. */
    public static boolean tryAcquire() {
        while (true) {
            int n = ACTIVE.get();
            if (n >= MAX_CONCURRENT_SUB_BUILDS) return false;
            if (ACTIVE.compareAndSet(n, n + 1)) return true;
        }
    }

    /** Give a slot back (once per successful {@link #tryAcquire()}). */
    public static void release() {
        ACTIVE.updateAndGet(n -> Math.max(0, n - 1));
    }

    public static int active() {
        return ACTIVE.get();
    }

    /** The epoch a sub-agent records at start. */
    public static int epoch() {
        return EPOCH.get();
    }

    /** Cancel every running sub-build: each stops at its next turn. Returns how many slots were busy. */
    public static int cancelAll() {
        EPOCH.incrementAndGet();
        return ACTIVE.get();
    }

    /** True once {@link #cancelAll()} ran after a sub-agent started under {@code startEpoch}. */
    public static boolean cancelledSince(int startEpoch) {
        return EPOCH.get() != startEpoch;
    }

    /** Number of blocks {@code PlaceLine(x,y,z,x2,y2,z2)} places (the longest axis delta + 1, as placeLineAt walks it). */
    public static long lineBlocks(int x, int y, int z, int x2, int y2, int z2) {
        long dx = Math.abs((long) x2 - x), dy = Math.abs((long) y2 - y), dz = Math.abs((long) z2 - z);
        return Math.max(1, Math.max(dx, Math.max(dy, dz))) + 1;
    }

    /** Whether one call of {@code blocks} blocks is within {@link #MAX_BLOCKS_PER_CALL}. */
    public static boolean withinCallCap(long blocks) {
        return blocks <= MAX_BLOCKS_PER_CALL;
    }

    /** Test hook: reset the counters (JUnit runs in one JVM). */
    static void resetForTests() {
        ACTIVE.set(0);
        EPOCH.set(0);
    }
}
