package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class GibberMathTest {

    @Test
    void theTotalSaturatesInsteadOfWrapping() {
        assertEquals(Integer.MAX_VALUE, GibberMath.addToTotal(Integer.MAX_VALUE - 5, 100), "bug #10: int overflow");
        assertEquals(15, GibberMath.addToTotal(10, 5));
        assertEquals(0, GibberMath.addToTotal(3, -10), "never negative");
    }

    @Test
    void owedIsTheUnpaidDifferenceNeverNegative() {
        assertEquals(40, GibberMath.owed(100, 60));
        assertEquals(0, GibberMath.owed(60, 100), "a player paid above the total is owed nothing");
        assertEquals(Integer.MAX_VALUE, GibberMath.owed(Integer.MAX_VALUE, 0));
    }

    @Test
    void onlyCoinsThatReachedTheInventoryCountAsPaid() {
        // Bug #10: a full inventory used to lose the coins AND mark them paid. Now the rest stays owed.
        int paid = GibberMath.paidAfter(60, 25); // 40 owed, only 25 fit
        assertEquals(85, paid);
        assertEquals(15, GibberMath.owed(100, paid));
        assertEquals(60, GibberMath.paidAfter(60, -3));
    }

    @Test
    void landedIsMeasuredFromTheInventoryNotTheLeftover() {
        // Review fix: creative insertStack voids what does not fit and reports success — the count does not rise.
        assertEquals(0, GibberMath.landed(64, 64, 40), "voided by a full creative inventory: nothing landed");
        assertEquals(25, GibberMath.landed(10, 35, 40));
        assertEquals(40, GibberMath.landed(0, 99, 40), "never more than was offered (a pickup in between)");
        assertEquals(0, GibberMath.landed(50, 20, 40), "never negative");
    }
}
