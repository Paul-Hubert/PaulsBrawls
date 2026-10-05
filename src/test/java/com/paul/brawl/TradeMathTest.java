package com.paul.brawl;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;

class TradeMathTest {

    // -- settlement aggregation (VERIFICATION-NOTES bug #2) ----------------------

    @Test
    void duplicateLinesAreSummedBeforeValidation() {
        // The original exploit: 15 coins, two lines of {coin,10}.
        Map<String, Integer> totals = new LinkedHashMap<>();
        TradeMath.addLine(totals, "coin", 10);
        TradeMath.addLine(totals, "coin", 10);
        assertEquals(Map.of("coin", 20), totals);

        Map<String, Integer> inventory = Map.of("coin", 15);
        assertEquals("coin", TradeMath.firstShortfall(totals, k -> inventory.getOrDefault(k, 0)));
    }

    @Test
    void coveredTotalsHaveNoShortfall() {
        Map<String, Integer> totals = new LinkedHashMap<>();
        TradeMath.addLine(totals, "coin", 10);
        TradeMath.addLine(totals, "carrot", 32);
        TradeMath.addLine(totals, "coin", 5);

        Map<String, Integer> inventory = Map.of("coin", 15, "carrot", 40);
        assertNull(TradeMath.firstShortfall(totals, k -> inventory.getOrDefault(k, 0)));
    }

    @Test
    void shortfallReportsTheFirstUncoveredItem() {
        Map<String, Integer> totals = new LinkedHashMap<>();
        TradeMath.addLine(totals, "coin", 1);
        TradeMath.addLine(totals, "diamond", 1);
        assertEquals("diamond", TradeMath.firstShortfall(totals, k -> k.equals("coin") ? 1 : 0));
    }

    @Test
    void nonPositiveLinesAreRejected() {
        Map<String, Integer> totals = new LinkedHashMap<>();
        assertThrows(IllegalArgumentException.class, () -> TradeMath.addLine(totals, "coin", 0));
        assertThrows(IllegalArgumentException.class, () -> TradeMath.addLine(totals, "coin", -5));
        assertTrue(totals.isEmpty());
    }

    @Test
    void overflowingTotalsThrowInsteadOfWrapping() {
        Map<String, Integer> totals = new LinkedHashMap<>();
        TradeMath.addLine(totals, "coin", Integer.MAX_VALUE);
        assertThrows(ArithmeticException.class, () -> TradeMath.addLine(totals, "coin", 1));
    }

    // -- removal planning ---------------------------------------------------------

    @Test
    void planTakesRemovesExactlyTheNeedInSlotOrder() {
        assertArrayEquals(new int[] {0, 7, 0, 3, 0}, TradeMath.planTakes(new int[] {0, 7, 0, 64, 2}, 10));
    }

    @Test
    void planTakesFailsWhenSlotsHoldTooLittle() {
        assertNull(TradeMath.planTakes(new int[] {5, 0, 9}, 15));
    }

    @Test
    void planTakesRejectsNonPositiveNeed() {
        // VERIFICATION-NOTES bug #3: a negative takeAmount must never plan a removal.
        assertNull(TradeMath.planTakes(new int[] {64}, 0));
        assertNull(TradeMath.planTakes(new int[] {64}, -10));
    }

    @Test
    void planTakesTreatsNegativeSlotsAsEmpty() {
        assertArrayEquals(new int[] {0, 4}, TradeMath.planTakes(new int[] {-3, 4}, 4));
    }

    // -- God trade amounts + expiry -----------------------------------------------

    @Test
    void amountsMustBeWithinOneAndMax() {
        assertFalse(TradeMath.isValidAmount(-1, 512));
        assertFalse(TradeMath.isValidAmount(0, 512));
        assertTrue(TradeMath.isValidAmount(1, 512));
        assertTrue(TradeMath.isValidAmount(512, 512));
        assertFalse(TradeMath.isValidAmount(513, 512));
    }

    @Test
    void offersExpireAtTheTtl() {
        assertFalse(TradeMath.isExpired(1_000, 1_000 + 299_999, 300_000));
        assertTrue(TradeMath.isExpired(1_000, 1_000 + 300_000, 300_000));
    }
}
