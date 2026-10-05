package com.paul.brawl;

import java.util.Map;
import java.util.function.ToIntFunction;

/**
 * Minecraft-free arithmetic shared by the two trade paths — the village
 * settlement listener ({@link VillageHttpListener}) and the God's
 * {@code /accept} offers ({@link TradeOffers}). Kept free of game types so it
 * can be unit-tested without a server (see {@code TradeMathTest}).
 *
 * <p>Both item-duplication bugs came from validating one thing and removing
 * another: per-line checks against the whole inventory, and a negative amount
 * slipping past a {@code have < need} check. The rule here is: aggregate what
 * is owed per item, then validate and plan the removal from the SAME numbers.
 */
public final class TradeMath {

    private TradeMath() {}

    /**
     * Adds one offer line to the per-item totals. Duplicate lines for the same
     * key are summed, so validation sees what will actually be removed.
     *
     * @throws IllegalArgumentException if {@code count < 1}
     * @throws ArithmeticException if the running total overflows an int
     */
    public static <K> void addLine(Map<K, Integer> totals, K key, int count) {
        if (count < 1) throw new IllegalArgumentException("count must be positive, got " + count);
        totals.merge(key, count, Math::addExact);
    }

    /**
     * Returns the first key whose required total exceeds what is available,
     * or {@code null} if every total is covered.
     */
    public static <K> K firstShortfall(Map<K, Integer> required, ToIntFunction<K> available) {
        for (var entry : required.entrySet()) {
            if (available.applyAsInt(entry.getKey()) < entry.getValue()) return entry.getKey();
        }
        return null;
    }

    /**
     * Plans how many items to take from each slot, in slot order, to remove
     * exactly {@code need} items. Returns {@code null} if {@code need < 1} or
     * the slots hold fewer than {@code need} in total; otherwise every entry is
     * in {@code [0, available[i]]} and the entries sum to {@code need}.
     * Negative slot counts are treated as empty.
     */
    public static int[] planTakes(int[] available, int need) {
        if (need < 1) return null;
        int[] takes = new int[available.length];
        int remaining = need;
        for (int i = 0; i < available.length && remaining > 0; i++) {
            int take = Math.min(remaining, Math.max(0, available[i]));
            takes[i] = take;
            remaining -= take;
        }
        return remaining == 0 ? takes : null;
    }

    /** {@code true} iff {@code 1 <= amount <= max}. */
    public static boolean isValidAmount(int amount, int max) {
        return amount >= 1 && amount <= max;
    }

    /** {@code true} once {@code ttlMillis} have elapsed since {@code createdAtMillis}. */
    public static boolean isExpired(long createdAtMillis, long nowMillis, long ttlMillis) {
        return nowMillis - createdAtMillis >= ttlMillis;
    }
}
