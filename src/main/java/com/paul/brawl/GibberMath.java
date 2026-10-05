package com.paul.brawl;

/**
 * Bug #10 — the Minecraft-free arithmetic of the Gibber salary ledger (GibberMathTest).
 *
 * <p>The ledger is two NBT ints: a global {@code total_revenue} and each player's paid-out amount. {@code /gib} and the
 * salary tick added to the total with plain {@code int} math, which wraps negative past {@code Integer.MAX_VALUE}
 * (and a negative {@code /gib} lowered it). Payouts marked the player paid in full even when the coins did not fit.
 */
public final class GibberMath {
    private GibberMath() {}

    /** {@code total + amount}, saturated to [0, Integer.MAX_VALUE] — the total never wraps or goes negative. */
    public static int addToTotal(int total, int amount) {
        long sum = (long) total + amount;
        return (int) Math.max(0L, Math.min(Integer.MAX_VALUE, sum));
    }

    /** Coins still owed to a player ({@code total - paid}, never negative). */
    public static int owed(int total, int paid) {
        long d = (long) total - paid;
        return (int) Math.max(0L, Math.min(Integer.MAX_VALUE, d));
    }

    /**
     * Coins that really landed: the rise in the player's coin count, capped at what was offered. Measured, not taken
     * from {@code insertStack}'s leftover — in creative mode a full inventory "accepts" a stack by voiding it.
     */
    public static int landed(int coinsBefore, int coinsAfter, int offered) {
        return Math.max(0, Math.min(offered, coinsAfter - coinsBefore));
    }

    /** The paid-out value to store after {@code inserted} coins actually reached the inventory. */
    public static int paidAfter(int paid, int inserted) {
        return addToTotal(paid, Math.max(0, inserted));
    }
}
