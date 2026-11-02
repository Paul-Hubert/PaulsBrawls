package com.paul.brawl.squad;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import org.junit.jupiter.api.Test;

class SquadInOrderTest {

    private final SquadInOrder<String> order = new SquadInOrder<>();

    @Test
    void aLaterSnapshotWaitsForTheEarlierOnesOfTheSamePlayer() {
        List<String> seen = new ArrayList<>();
        CompletableFuture<String> release = new CompletableFuture<>();
        CompletableFuture<String> hit = new CompletableFuture<>();
        order.after("paul", release).thenAccept(seen::add);
        CompletableFuture<String> second = order.after("paul", hit);
        second.thenAccept(seen::add);
        hit.complete("hit"); // its look was found first
        assertFalse(second.isDone());
        assertEquals(List.of(), seen);
        release.complete("release");
        assertEquals(List.of("release", "hit"), seen);
        assertEquals(0, order.pending());
    }

    @Test
    void anotherPlayerDoesNotWait() {
        CompletableFuture<String> a = new CompletableFuture<>();
        order.after("a", a);
        CompletableFuture<String> b = order.after("b", CompletableFuture.completedFuture("b"));
        assertTrue(b.isDone());
        assertEquals(1, order.pending());
        a.complete("a");
        assertEquals(0, order.pending());
    }

    @Test
    void aFailedEarlierSnapshotDoesNotFailTheNext() {
        CompletableFuture<String> first = new CompletableFuture<>();
        CompletableFuture<String> out1 = order.after("p", first);
        CompletableFuture<String> out2 = order.after("p", CompletableFuture.completedFuture("next"));
        first.completeExceptionally(new IllegalStateException("boom"));
        assertTrue(out1.isCompletedExceptionally());
        assertEquals("next", out2.join());
        assertEquals(0, order.pending());
    }
}
