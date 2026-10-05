package com.paul.brawl;

/**
 * Bug #6 — Minecraft-free limits on the God's world-mutating tools (unit-tested in GodClampsTest). The maxima
 * live in {@link BridgeConfig} ({@code rewardMax}, {@code punishmentMax}, {@code spawnOffsetMax}) beside the
 * existing {@code spawnCountMax}; these functions only apply them.
 */
public final class GodClamps {
    private GodClamps() {}

    /** Clamp {@code value} into [{@code min}, {@code max}] (a misconfigured max below min yields min). */
    public static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, Math.max(min, max)));
    }

    /** Reward amount: at least 1, at most {@code rewardMax}. A non-positive request is refused by the caller. */
    public static int rewardAmount(int requested, int rewardMax) {
        return clamp(requested, 1, rewardMax);
    }

    /** Lightning strikes per Punishment: 0..{@code punishmentMax} (one call used to strike any number in one tick). */
    public static int punishments(int requested, int punishmentMax) {
        return clamp(requested, 0, punishmentMax);
    }

    /** One SpawnCreature offset axis, in blocks from the player: ±{@code spawnOffsetMax}. */
    public static int spawnOffset(int requested, int spawnOffsetMax) {
        int m = Math.max(0, spawnOffsetMax);
        return clamp(requested, -m, m);
    }
}
